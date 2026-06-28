import fs from "node:fs";
import path from "node:path";
import { SemanticGateError } from "./errors.js";
import { commandLine, runCommand } from "./shell.js";
import type { CommandRecord, FileContext, GitReviewContext, SemanticGateConfig } from "./types.js";

const generatedOrVendoredPatterns = [
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)coverage\//,
  /(^|\/)\.quality\/reports\//,
  /(^|\/)\.quality\/semantic-gate\//,
  /(^|\/)vendor\//,
  /(^|\/)__pycache__\//,
  /(^|\/).*\.egg-info\//,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)Cargo\.lock$/,
];

export async function collectGitReviewContext(
  cwd: string,
  config: SemanticGateConfig,
): Promise<GitReviewContext> {
  const repoRootResult = await git(cwd, ["rev-parse", "--show-toplevel"], "find git repository root");
  if (repoRootResult.code !== 0) {
    throw new SemanticGateError("semantic-gate must run inside a git repository.", "context", repoRootResult.stderr);
  }
  const repoRoot = repoRootResult.stdout.trim();

  const commands: CommandRecord[] = [record(repoRootResult)];
  const warnings: string[] = [];

  const status = await git(repoRoot, ["status", "--short"], "identify changed files");
  commands.push(record(status));

  const range = config.base
    ? config.head
      ? `${config.base}...${config.head}`
      : `${config.base}...HEAD`
    : undefined;

  let diffStat = "";
  let stagedDiffStat = "";
  let rangeDiffStat: string | undefined;
  let changedFiles = new Set<string>();

  if (range) {
    const rangeStat = await git(repoRoot, ["diff", "--stat", range], "summarize comparison range");
    const rangeNames = await git(repoRoot, ["diff", "--name-only", range], "list changed files in comparison range");
    commands.push(record(rangeStat), record(rangeNames));
    rangeDiffStat = rangeStat.stdout.trim();
    changedFiles = new Set(splitLines(rangeNames.stdout));
  } else {
    const unstagedStat = await git(repoRoot, ["diff", "--stat"], "summarize unstaged changes");
    const stagedStat = await git(repoRoot, ["diff", "--cached", "--stat"], "summarize staged changes");
    const unstagedNames = await git(repoRoot, ["diff", "--name-only"], "list unstaged changed files");
    const stagedNames = await git(repoRoot, ["diff", "--cached", "--name-only"], "list staged changed files");
    commands.push(record(unstagedStat), record(stagedStat), record(unstagedNames), record(stagedNames));
    diffStat = unstagedStat.stdout.trim();
    stagedDiffStat = stagedStat.stdout.trim();
    changedFiles = new Set([...splitLines(unstagedNames.stdout), ...splitLines(stagedNames.stdout)]);

    if (config.includeUntracked) {
      const untracked = await git(repoRoot, ["ls-files", "--others", "--exclude-standard"], "list untracked files");
      commands.push(record(untracked));
      for (const file of splitLines(untracked.stdout)) {
        changedFiles.add(file);
      }
    }
  }

  const files: FileContext[] = [];
  for (const relativeFile of [...changedFiles].sort()) {
    const normalized = normalizePath(relativeFile);
    if (!normalized || shouldSkipPath(normalized)) {
      warnings.push(`Skipped generated or vendored path: ${normalized || relativeFile}`);
      continue;
    }
    files.push(await collectFile(repoRoot, normalized, config, range, warnings, commands));
  }

  const context: GitReviewContext = {
    repoRoot,
    statusShort: status.stdout.trim(),
    diffStat,
    stagedDiffStat,
    commandsExecuted: commands,
    changedFiles: files,
    warnings,
  };
  if (rangeDiffStat !== undefined) {
    context.rangeDiffStat = rangeDiffStat;
  }
  return context;
}

async function collectFile(
  repoRoot: string,
  relativeFile: string,
  config: SemanticGateConfig,
  range: string | undefined,
  warnings: string[],
  commands: CommandRecord[],
): Promise<FileContext> {
  const file: FileContext = {
    path: relativeFile,
    changeKinds: [],
  };

  if (range) {
    const diff = await git(repoRoot, ["diff", range, "--", relativeFile], `read diff for ${relativeFile}`);
    commands.push(record(diff));
    file.diff = limitText(diff.stdout, config.maxDiffChars, `diff for ${relativeFile}`, warnings, file);
    file.changeKinds.push("range");
  } else {
    const unstaged = await git(repoRoot, ["diff", "--", relativeFile], `read unstaged diff for ${relativeFile}`);
    const staged = await git(repoRoot, ["diff", "--cached", "--", relativeFile], `read staged diff for ${relativeFile}`);
    commands.push(record(unstaged), record(staged));
    if (unstaged.stdout.trim()) {
      file.diff = limitText(unstaged.stdout, config.maxDiffChars, `unstaged diff for ${relativeFile}`, warnings, file);
      file.changeKinds.push("unstaged");
    }
    if (staged.stdout.trim()) {
      file.stagedDiff = limitText(staged.stdout, config.maxDiffChars, `staged diff for ${relativeFile}`, warnings, file);
      file.changeKinds.push("staged");
    }
  }

  const absoluteFile = path.join(repoRoot, relativeFile);
  if (!fs.existsSync(absoluteFile)) {
    file.skippedReason = "file deleted or unavailable in working tree";
    file.changeKinds.push("deleted");
    return file;
  }

  const stat = fs.statSync(absoluteFile);
  if (!stat.isFile()) {
    file.skippedReason = "not a regular file";
    return file;
  }
  if (stat.size > config.maxFileChars) {
    file.skippedReason = `file exceeds maxFileChars (${stat.size} > ${config.maxFileChars})`;
    file.truncated = true;
    warnings.push(`Skipped full content for ${relativeFile}: ${file.skippedReason}`);
    return file;
  }

  const buffer = fs.readFileSync(absoluteFile);
  if (buffer.includes(0)) {
    file.skippedReason = "binary file";
    warnings.push(`Skipped binary file content: ${relativeFile}`);
    return file;
  }
  file.content = buffer.toString("utf8");
  if (file.changeKinds.length === 0) {
    file.changeKinds.push("untracked");
  }
  return file;
}

function limitText(
  text: string,
  limit: number,
  label: string,
  warnings: string[],
  file: FileContext,
): string {
  if (text.length <= limit) {
    return text;
  }
  file.truncated = true;
  warnings.push(`Truncated ${label}: ${text.length} chars > ${limit}.`);
  return `${text.slice(0, limit)}\n[semantic-gate truncated ${label}; original chars=${text.length}]`;
}

async function git(cwd: string, args: string[], purpose: string) {
  const result = await runCommand("git", args, { cwd, timeoutMs: 30_000 });
  return { ...result, command: commandLine("git", args), purpose };
}

function record(result: Awaited<ReturnType<typeof git>>): CommandRecord {
  const outcome = result.code === 0 ? "ok" : `exit ${result.code}: ${trimForRecord(result.stderr)}`;
  return {
    command: result.command,
    result: outcome,
    purpose: result.purpose,
  };
}

function trimForRecord(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 180 ? `${trimmed.slice(0, 180)}...` : trimmed;
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function shouldSkipPath(filePath: string): boolean {
  return generatedOrVendoredPatterns.some((pattern) => pattern.test(filePath));
}
