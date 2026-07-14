#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_IMAGE = "code-approval-gates/quality-sidecar:latest";
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const DEFAULT_IGNORES = [
  ".git/",
  ".quality/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".turbo/",
  ".vite/",
  "__pycache__/",
  "*.pyc",
  "*.pyo",
  "*.log",
  "*.sqlite",
  "*.sqlite3",
  "*.db"
];
const SUPPORT_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".gitignore",
  "README.md"
];

function takeValue(raw, index, flag, options = {}) {
  const value = raw[index + 1];
  if (value === undefined || (!options.allowFlagValue && value.startsWith("--"))) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function normalizeFormatValue(value) {
  return String(value).trim().split(/[\s,]+/).filter(Boolean).join(",");
}

function parseArgs(rawArgs, env = process.env) {
  const raw = [...rawArgs];
  const parsed = {
    target: ".",
    image: env.QUALITY_SIDECAR_IMAGE || DEFAULT_IMAGE,
    pull: false,
    noPull: false,
    startDocker: env.QUALITY_CHECK_START_DOCKER !== "0" && env.QUALITY_CHECK_NO_START_DOCKER !== "1",
    dockerStartTimeoutMs: Number(env.QUALITY_CHECK_DOCKER_START_TIMEOUT_MS || 120000),
    build: env.QUALITY_CHECK_AUTO_BUILD !== "0" && env.QUALITY_CHECK_NO_BUILD !== "1",
    debugDocker: false,
    help: false,
    scope: env.QUALITY_CHECK_SCOPE || "changed",
    paths: [],
    excludes: [],
    includes: [],
    ignoreFiles: [],
    json: false,
    ci: false,
    noInteractive: false,
    output: env.QUALITY_CHECK_OUTPUT || ".quality/reports",
    dockerArgs: [],
    containerArgs: []
  };

  if (raw[0] && !raw[0].startsWith("-")) {
    parsed.target = raw.shift();
  }

  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--scope") {
      parsed.scope = takeValue(raw, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith("--scope=")) {
      parsed.scope = arg.slice("--scope=".length);
      continue;
    }

    if (arg === "--path") {
      parsed.paths.push(takeValue(raw, i, arg));
      i += 1;
      continue;
    }

    if (arg.startsWith("--path=")) {
      parsed.paths.push(arg.slice("--path=".length));
      continue;
    }

    if (arg === "--exclude") {
      parsed.excludes.push(takeValue(raw, i, arg));
      i += 1;
      continue;
    }

    if (arg.startsWith("--exclude=")) {
      parsed.excludes.push(arg.slice("--exclude=".length));
      continue;
    }

    if (arg === "--include") {
      parsed.includes.push(takeValue(raw, i, arg));
      i += 1;
      continue;
    }

    if (arg.startsWith("--include=")) {
      parsed.includes.push(arg.slice("--include=".length));
      continue;
    }

    if (arg === "--ignore-file") {
      parsed.ignoreFiles.push(takeValue(raw, i, arg));
      i += 1;
      continue;
    }

    if (arg.startsWith("--ignore-file=")) {
      parsed.ignoreFiles.push(arg.slice("--ignore-file=".length));
      continue;
    }

    if (arg === "--ci") {
      parsed.ci = true;
      parsed.noInteractive = true;
      continue;
    }

    if (arg === "--no-interactive") {
      parsed.noInteractive = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--image" || arg === "-Image" || arg === "-image") {
      parsed.image = takeValue(raw, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith("--image=")) {
      parsed.image = arg.slice("--image=".length);
      continue;
    }

    if (arg === "--pull" || arg === "-Pull" || arg === "-pull") {
      parsed.pull = true;
      continue;
    }

    if (arg === "--no-pull" || arg === "-NoPull" || arg === "-noPull") {
      parsed.noPull = true;
      continue;
    }

    if (arg === "--start-docker") {
      parsed.startDocker = true;
      continue;
    }

    if (arg === "--no-start-docker") {
      parsed.startDocker = false;
      continue;
    }

    if (arg === "--docker-start-timeout-ms") {
      parsed.dockerStartTimeoutMs = Number(takeValue(raw, i, arg));
      i += 1;
      continue;
    }

    if (arg.startsWith("--docker-start-timeout-ms=")) {
      parsed.dockerStartTimeoutMs = Number(arg.slice("--docker-start-timeout-ms=".length));
      continue;
    }

    if (arg === "--build" || arg === "-Build" || arg === "-build") {
      parsed.build = true;
      continue;
    }

    if (arg === "--no-build" || arg === "-NoBuild" || arg === "-noBuild") {
      parsed.build = false;
      continue;
    }

    if (arg === "--debug-docker" || arg === "-DebugDocker" || arg === "-debugDocker") {
      parsed.debugDocker = true;
      continue;
    }

    if (arg === "--docker-arg" || arg === "-DockerArg" || arg === "-dockerArg") {
      parsed.dockerArgs.push(takeValue(raw, i, arg, { allowFlagValue: true }));
      i += 1;
      continue;
    }

    if (arg.startsWith("--docker-arg=")) {
      parsed.dockerArgs.push(arg.slice("--docker-arg=".length));
      continue;
    }

    if (arg === "--format") {
      parsed.containerArgs.push(arg, normalizeFormatValue(takeValue(raw, i, arg)));
      i += 1;
      continue;
    }

    if (arg.startsWith("--format=")) {
      parsed.containerArgs.push(`--format=${normalizeFormatValue(arg.slice("--format=".length))}`);
      continue;
    }

    if (arg === "--output") {
      parsed.output = takeValue(raw, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith("--output=")) {
      parsed.output = arg.slice("--output=".length);
      continue;
    }

    parsed.containerArgs.push(arg);
  }

  if (parsed.pull && parsed.noPull) {
    parsed.pull = false;
  }
  if (!["changed", "full", "paths"].includes(parsed.scope)) {
    throw new Error("--scope must be changed, full, or paths");
  }
  if (parsed.scope !== "paths" && parsed.paths.length > 0) {
    throw new Error("--path can only be used with --scope paths");
  }
  if (parsed.scope === "paths" && parsed.paths.length === 0) {
    throw new Error("--scope paths requires at least one --path");
  }
  if (!Number.isFinite(parsed.dockerStartTimeoutMs) || parsed.dockerStartTimeoutMs < 0) {
    throw new Error("--docker-start-timeout-ms must be a non-negative number");
  }
  if (parsed.json && !hasContainerFormat(parsed.containerArgs)) {
    parsed.containerArgs.push("--format", "json");
  }

  return parsed;
}

function hasContainerFormat(args) {
  return args.some((arg) => arg === "--format" || String(arg).startsWith("--format="));
}

function ensureTarget(target) {
  const targetPath = path.resolve(target);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target path does not exist: ${targetPath}`);
  }
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    throw new Error(`Target path must be a directory: ${targetPath}`);
  }
  return targetPath;
}

function buildDockerArgs(parsed, targetPath, reportsPath = path.join(targetPath, ".quality", "reports")) {
  const containerArgs = withoutOutputArgs(parsed.containerArgs);
  return [
    "run",
    "--rm",
    "--user",
    "0",
    "-e",
    `QUALITY_CHECK_SCOPE=${parsed.scope}`,
    ...parsed.dockerArgs,
    "-v",
    `${targetPath}:/workspace`,
    "-v",
    `${reportsPath}:/workspace/.quality/reports`,
    "-w",
    "/workspace",
    parsed.image,
    "check",
    "/workspace",
    "--output",
    ".quality/reports",
    ...containerArgs
  ];
}

function hasSidecarMode(args) {
  return args.some((arg) => arg === "--mode" || String(arg).startsWith("--mode="));
}

function buildLocalSidecarArgs(parsed, targetPath, reportsPath) {
  const containerArgs = withoutOutputArgs(parsed.containerArgs);
  const args = [
    "-m",
    "quality_sidecar",
    "check",
    targetPath,
    "--output",
    reportsPath,
    ...containerArgs
  ];
  if (!hasSidecarMode(containerArgs)) {
    args.push("--mode", "offline");
  }
  return args;
}

function withoutOutputArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      index += 1;
      continue;
    }
    if (String(arg).startsWith("--output=")) {
      continue;
    }
    result.push(arg);
  }
  return result;
}

function quoteForDisplay(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function commandLine(command, args) {
  return [command, ...args].map(quoteForDisplay).join(" ");
}

function resolveScopedTarget(targetPath, parsed) {
  const reportsPath = path.isAbsolute(parsed.output)
    ? parsed.output
    : path.resolve(targetPath, parsed.output);
  const selected = resolveScopeFiles(targetPath, parsed);
  if (parsed.scope === "full" && selected.ignoredCount === 0 && parsed.excludes.length === 0 && parsed.includes.length === 0 && parsed.ignoreFiles.length === 0) {
    return { effectiveTarget: targetPath, reportsPath, scope: selected };
  }
  const projectionRoot = path.join(targetPath, ".quality", "scopes", `quality-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const effectiveTarget = path.join(projectionRoot, "workspace");
  fs.mkdirSync(effectiveTarget, { recursive: true });
  for (const file of selected.files) {
    const source = path.join(targetPath, file);
    const destination = path.join(effectiveTarget, file);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return { effectiveTarget, reportsPath, scope: selected };
}

function resolveScopeFiles(targetPath, parsed) {
  const ignorePlan = loadIgnorePlan(targetPath, parsed);
  let files = [];
  const commands = [];

  if (parsed.scope === "changed") {
    const range = resolveGitRange();
    if (range.base || range.head) {
      const args = ["diff", "--name-only", `${range.base || "HEAD"}...${range.head || "HEAD"}`];
      const result = runCaptured("git", args, targetPath);
      commands.push(recordCommand("git", args, result));
      files.push(...splitLines(result.stdout));
    } else {
      for (const args of [["diff", "--name-only"], ["diff", "--cached", "--name-only"], ["ls-files", "--others", "--exclude-standard"]]) {
        const result = runCaptured("git", args, targetPath);
        commands.push(recordCommand("git", args, result));
        files.push(...splitLines(result.stdout));
      }
    }
    files = filterToConfiguredPaths(files, parsed.paths);
  } else if (parsed.scope === "full") {
    const args = ["ls-files", "-co", "--exclude-standard"];
    const result = runCaptured("git", args, targetPath);
    commands.push(recordCommand("git", args, result));
    files = result.status === 0 ? splitLines(result.stdout) : walkFiles(targetPath).map((file) => normalizePath(path.relative(targetPath, file)));
  } else {
    for (const selectedPath of parsed.paths) {
      const normalized = normalizePath(selectedPath);
      const args = ["ls-files", "-co", "--exclude-standard", "--", normalized];
      const result = runCaptured("git", args, targetPath);
      commands.push(recordCommand("git", args, result));
      files.push(...(result.status === 0 ? splitLines(result.stdout) : walkFiles(path.join(targetPath, normalized)).map((file) => normalizePath(path.relative(targetPath, file)))));
    }
  }

  if (parsed.scope === "full") {
    files.push(...collectIncludedFiles(targetPath, ignorePlan, [""]));
  } else if (parsed.scope === "paths") {
    files.push(...collectIncludedFiles(targetPath, ignorePlan, parsed.paths));
  }

  if (parsed.scope === "full" || (parsed.scope === "changed" && files.length > 0)) {
    for (const support of SUPPORT_FILES) {
      if (fs.existsSync(path.join(targetPath, support))) {
        files.push(support);
      }
    }
  }
  const unique = [...new Set(files.map(normalizePath).filter(Boolean))];
  const filtered = unique
    .filter((file) => fs.existsSync(path.join(targetPath, file)) && fs.statSync(path.join(targetPath, file)).isFile())
    .filter((file) => !isIgnored(file, ignorePlan));
  return {
    scope: parsed.scope,
    files: filtered.sort(),
    fileCount: filtered.length,
    ignoredCount: unique.length - filtered.length,
    ignoreFiles: ignorePlan.files,
    commands
  };
}

function collectIncludedFiles(targetPath, ignorePlan, roots) {
  const includePatterns = [...new Set(ignorePlan.rules
    .filter((rule) => rule.include)
    .map((rule) => normalizePath(rule.pattern))
    .filter(Boolean))];

  if (!includePatterns.length) {
    return [];
  }

  const selectedRoots = roots.length ? roots : [""];
  const files = [];
  for (const root of selectedRoots) {
    const normalizedRoot = normalizePath(root);
    const absoluteRoot = path.join(targetPath, normalizedRoot);
    for (const filePath of walkFiles(absoluteRoot)) {
      const relative = normalizePath(path.relative(targetPath, filePath));
      if (includePatterns.some((pattern) => matchesPattern(relative, pattern))) {
        files.push(relative);
      }
    }
  }
  return files;
}

function resolveGitRange() {
  if (process.env.GITLAB_CI && process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME) {
    return { base: `origin/${process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME}`, head: process.env.CI_COMMIT_SHA || "HEAD" };
  }
  if (process.env.GITHUB_BASE_REF) {
    return { base: `origin/${process.env.GITHUB_BASE_REF}`, head: process.env.GITHUB_SHA || "HEAD" };
  }
  return {};
}

function loadIgnorePlan(targetPath, parsed) {
  const rules = DEFAULT_IGNORES.map((pattern) => ({ pattern, include: false, source: "defaults" }));
  const files = [];
  const candidates = [...new Set([".gitignore", ".code-approval-gates.ignore", ".quality-gate.ignore", ...parsed.ignoreFiles])];
  for (const candidate of candidates) {
    const relative = normalizePath(candidate);
    const absolute = path.resolve(targetPath, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      continue;
    }
    files.push(relative);
    for (const rawLine of fs.readFileSync(absolute, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const include = line.startsWith("!");
      rules.push({ pattern: include ? line.slice(1) : line, include, source: relative });
    }
  }
  for (const pattern of parsed.excludes) {
    rules.push({ pattern, include: false, source: "--exclude" });
  }
  for (const pattern of parsed.includes) {
    rules.push({ pattern, include: true, source: "--include" });
  }
  return { files, rules };
}

function isIgnored(file, ignorePlan) {
  let ignored = false;
  for (const rule of ignorePlan.rules) {
    if (matchesPattern(file, rule.pattern)) {
      ignored = !rule.include;
    }
  }
  return ignored;
}

function filterToConfiguredPaths(files, configuredPaths) {
  if (!configuredPaths.length) {
    return files;
  }
  const prefixes = configuredPaths.map(normalizePath).filter(Boolean);
  return files.filter((file) => {
    const normalized = normalizePath(file);
    return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
  });
}

function runCaptured(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", errors: "replace", timeout: 30000 });
}

function recordCommand(command, args, result) {
  return { command: commandLine(command, args), exitCode: result.status ?? null };
}

function splitLines(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function walkFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  if (fs.statSync(root).isFile()) {
    return [root];
  }
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if ([".git", "node_modules", ".quality"].includes(entry.name)) {
          continue;
        }
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

function matchesPattern(file, pattern) {
  const normalizedFile = normalizePath(file);
  const normalizedPattern = normalizePath(pattern);
  if (!normalizedPattern) {
    return false;
  }
  if (normalizedPattern.endsWith("/")) {
    const prefix = normalizedPattern.replace(/\/+$/, "");
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`) || normalizedFile.includes(`/${prefix}/`);
  }
  if (!normalizedPattern.includes("/")) {
    return normalizedFile.split("/").some((part) => globMatches(part, normalizedPattern));
  }
  return globMatches(normalizedFile, normalizedPattern);
}

function globMatches(value, pattern) {
  const memo = new Map();
  const match = (valueIndex, patternIndex) => {
    const key = `${valueIndex}:${patternIndex}`;
    if (memo.has(key)) {
      return memo.get(key);
    }
    let matched;
    if (patternIndex === pattern.length) {
      matched = valueIndex === value.length;
    } else if (pattern[patternIndex] === "*" && pattern[patternIndex + 1] === "*") {
      matched = match(valueIndex, patternIndex + 2) ||
        (valueIndex < value.length && match(valueIndex + 1, patternIndex));
    } else if (pattern[patternIndex] === "*") {
      matched = match(valueIndex, patternIndex + 1) ||
        (valueIndex < value.length && value[valueIndex] !== "/" && match(valueIndex + 1, patternIndex));
    } else if (pattern[patternIndex] === "?") {
      matched = valueIndex < value.length && value[valueIndex] !== "/" && match(valueIndex + 1, patternIndex + 1);
    } else {
      matched = valueIndex < value.length && value[valueIndex] === pattern[patternIndex] &&
        match(valueIndex + 1, patternIndex + 1);
    }
    memo.set(key, matched);
    return matched;
  };
  return match(0, 0);
}

function isDockerAvailable(env = process.env, runner = spawnSync) {
  const result = runner("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    errors: "replace",
    env,
    timeout: 15000
  });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  return !result.error && result.status === 0 && stdout.length > 0 && !/internal server error/i.test(stderr);
}

function sleepSync(ms) {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function dockerDesktopCandidates(env = process.env) {
  const candidates = [];
  if (env.DOCKER_DESKTOP_PATH) {
    candidates.push({ command: env.DOCKER_DESKTOP_PATH, args: [] });
  }
  if (process.platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const localAppData = env.LOCALAPPDATA;
    const windowsCandidates = [
      path.join(programFiles, "Docker", "Docker", "Docker Desktop.exe"),
      localAppData ? path.join(localAppData, "Docker", "Docker Desktop.exe") : null
    ].filter(Boolean);
    for (const command of windowsCandidates) {
      if (fs.existsSync(command)) {
        candidates.push({ command, args: [] });
      }
    }
  } else if (process.platform === "darwin") {
    candidates.push({ command: "open", args: ["-a", "Docker"] });
  }
  candidates.push({ command: "docker", args: ["desktop", "start"] });
  return candidates;
}

function startDetachedProcess(command, args, env = process.env) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env
    });
    child.unref();
    return { status: 0 };
  } catch (error) {
    return { error };
  }
}

function startDockerDaemon(env = process.env, starter = startDetachedProcess) {
  const failures = [];
  for (const candidate of dockerDesktopCandidates(env)) {
    const result = starter(candidate.command, candidate.args, env);
    if (!result.error && (result.status === undefined || result.status === 0)) {
      return {
        started: true,
        command: commandLine(candidate.command, candidate.args),
        failures
      };
    }
    failures.push({
      command: commandLine(candidate.command, candidate.args),
      message: result.error ? result.error.message : `exit ${result.status}`
    });
  }
  return { started: false, command: null, failures };
}

function waitForDocker(env = process.env, runner = spawnSync, timeoutMs = 120000, pollMs = 2000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    if (isDockerAvailable(env, runner)) {
      return true;
    }
    if (Date.now() >= deadline) {
      break;
    }
    sleepSync(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return isDockerAvailable(env, runner);
}

function ensureDockerAvailable(parsed, env = process.env, runner = spawnSync, starter = startDetachedProcess) {
  if (isDockerAvailable(env, runner)) {
    return true;
  }
  if (!parsed.startDocker) {
    return false;
  }
  const started = startDockerDaemon(env, starter);
  if (!started.started) {
    console.error("Docker is not available and could not be started automatically.");
    for (const failure of started.failures) {
      console.error(`- ${failure.command}: ${failure.message}`);
    }
    return false;
  }
  console.error(`Docker is not available; started ${started.command} and waiting for the daemon...`);
  if (waitForDocker(env, runner, parsed.dockerStartTimeoutMs)) {
    console.error("Docker daemon is ready.");
    return true;
  }
  console.error(`Docker did not become ready within ${parsed.dockerStartTimeoutMs}ms.`);
  return false;
}

function imageExists(image, env = process.env, runner = spawnSync) {
  const result = runner("docker", ["image", "inspect", image], {
    encoding: "utf8",
    errors: "replace",
    env,
    timeout: 15000
  });
  return !result.error && result.status === 0;
}

function canBuildBundledImage(packageRoot = PACKAGE_ROOT) {
  return fs.existsSync(path.join(packageRoot, "Dockerfile")) &&
    fs.existsSync(path.join(packageRoot, "sidecar")) &&
    fs.existsSync(path.join(packageRoot, "docker", "entrypoint.sh"));
}

function buildBundledImage(image, env = process.env, runner = spawnSync, packageRoot = PACKAGE_ROOT) {
  if (!canBuildBundledImage(packageRoot)) {
    console.error(
      `Docker image ${image} was not found locally and this installation does not include the bundled sidecar build context. ` +
      "Run with --pull, pass --image <existing-image>, or install from the full repository/package."
    );
    return 3;
  }

  console.error(`Docker image ${image} was not found locally. Building the bundled quality-sidecar image...`);
  const result = runner("docker", ["build", "-t", image, packageRoot], {
    stdio: "inherit",
    env
  });
  if (result.error) {
    console.error(`Failed to execute docker build: ${result.error.message}`);
    return 3;
  }
  return result.status ?? 3;
}

function pythonCommand(env = process.env) {
  if (env.PYTHON) {
    return env.PYTHON;
  }
  return process.platform === "win32" ? "python" : "python3";
}

function localSidecarEnv(env = process.env, packageRoot = PACKAGE_ROOT) {
  const sidecarPath = path.join(packageRoot, "sidecar");
  return {
    ...env,
    PYTHONPATH: env.PYTHONPATH ? `${sidecarPath}${path.delimiter}${env.PYTHONPATH}` : sidecarPath
  };
}

function runLocalSidecar(parsed, scopedTarget, reportsPath, env = process.env, runner = spawnSync) {
  const args = buildLocalSidecarArgs(parsed, scopedTarget.effectiveTarget, reportsPath);
  const command = pythonCommand(env);
  if (parsed.debugDocker) {
    console.log(commandLine(command, args));
  }
  console.error("Docker is not available; running bundled Quality Gate sidecar locally in offline mode.");
  const result = runner(command, args, {
    stdio: "inherit",
    env: {
      ...localSidecarEnv(env),
      QUALITY_CHECK_SCOPE: parsed.scope
    }
  });
  if (result.error) {
    console.error(`Failed to run local quality sidecar: ${result.error.message}`);
    return 3;
  }
  return result.status ?? 3;
}

function helpText() {
  return `quality-check

Usage:
  quality-check
  quality-check --scope changed
  quality-check --scope full
  quality-check --scope paths --path apps/web --path packages/core
  quality-check . --threshold 90 --format=json,md --output .quality/reports

Scope flags:
  --scope changed|full|paths     changed is the default.
  --path <path>                  Add a path for scope=paths; repeatable.
  --exclude <glob>               Exclude files using gitignore-style globs; repeatable.
  --include <glob>               Re-include a previously excluded file; repeatable.
  --ignore-file <path>           Add a custom gitignore-style ignore file; repeatable; supports !path re-inclusion.

Automation:
  --ci                           Headless CI mode.
  --json                         Request JSON report format.
  --no-interactive               Never prompt.

Docker wrapper flags:
  --image <image>
  --pull / --no-pull
  --start-docker / --no-start-docker
  --docker-start-timeout-ms <ms>
  --build / --no-build
  --docker-arg <arg>
  --debug-docker

Local fallback:
  When Docker is not available, the bundled Python sidecar runs locally in offline mode.
  Pass --mode quick|offline|full to choose the sidecar mode explicitly.

All remaining flags are passed to the sidecar check command.
`;
}

function writeEmptyQualityReport(reportsPath, scope, parsed) {
  fs.mkdirSync(reportsPath, { recursive: true });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: parsed.target,
    status: "APPROVED",
    exitCode: 0,
    profile: "standard",
    mode: "scoped",
    score: { value: 100, threshold: 0, max: 100 },
    scope,
    scoreAppliesTo: scoreAppliesToForScope(scope.scope),
    summary: {
      counts: { active: 0, allowed: 0, total: 0 },
      reasons: ["No files matched the requested scope after ignore rules."],
      toolErrors: []
    },
    stack: {},
    tools: [],
    findings: []
  };
  fs.writeFileSync(path.join(reportsPath, "quality-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(reportsPath, "quality-report.md"),
    `# Quality Gate Report\n\nStatus: APPROVED\nScope: ${scope.scope}\nFiles analyzed: 0\n\nNo files matched the requested scope after ignore rules.\n`,
    "utf8"
  );
}

function scoreAppliesToForScope(scope) {
  return scope === "full" ? "entire-project" : scope === "paths" ? "selected-paths" : "changed-files";
}

function augmentQualityReports(reportsPath, scope) {
  const jsonPath = path.join(reportsPath, "quality-report.json");
  const markdownPath = path.join(reportsPath, "quality-report.md");
  if (fs.existsSync(jsonPath)) {
    try {
      const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      report.scope = scope;
      report.scoreAppliesTo = scoreAppliesToForScope(scope.scope);
      fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch {
      // Keep the original report if augmentation fails.
    }
  }
  if (fs.existsSync(markdownPath)) {
    const addition = [
      "",
      "## Scope",
      "",
      `Scope: ${scope.scope}`,
      `Files analyzed: ${scope.fileCount}`,
      `Ignored files: ${scope.ignoredCount}`,
      `Ignore files: ${scope.ignoreFiles.length ? scope.ignoreFiles.join(", ") : "(none)"}`,
      "",
    ].join("\n");
    fs.appendFileSync(markdownPath, addition, "utf8");
  }
}

function runDockerWrapper(rawArgs, env = process.env, runner = spawnSync, starter = startDetachedProcess) {
  let parsed;
  let targetPath;

  try {
    parsed = parseArgs(rawArgs, env);
    if (parsed.help) {
      console.log(helpText());
      return 0;
    }
    targetPath = ensureTarget(parsed.target);
  } catch (error) {
    console.error(error.message);
    return 3;
  }

  const scopedTarget = resolveScopedTarget(targetPath, parsed);
  const reportsPath = scopedTarget.reportsPath;
  fs.mkdirSync(reportsPath, { recursive: true });
  fs.writeFileSync(
    path.join(reportsPath, "quality-scope.json"),
    `${JSON.stringify(scopedTarget.scope, null, 2)}\n`,
    "utf8"
  );

  if (scopedTarget.scope.files.length === 0) {
    writeEmptyQualityReport(reportsPath, scopedTarget.scope, parsed);
    console.error("No files matched the requested quality-check scope after ignore rules.");
    return 0;
  }

  if (!ensureDockerAvailable(parsed, env, runner, starter)) {
    const exitCode = runLocalSidecar(parsed, scopedTarget, reportsPath, env, runner);
    augmentQualityReports(reportsPath, scopedTarget.scope);
    return exitCode;
  }

  if (parsed.pull) {
    const pullResult = runner("docker", ["pull", parsed.image], { stdio: "inherit", env });
    if (pullResult.error) {
      console.error(`Falha ao executar docker pull: ${pullResult.error.message}`);
      return 3;
    }
    if (pullResult.status !== 0) {
      return pullResult.status ?? 3;
    }
  }

  if (parsed.build && !imageExists(parsed.image, env, runner)) {
    const buildExitCode = buildBundledImage(parsed.image, env, runner);
    if (buildExitCode !== 0) {
      return buildExitCode;
    }
  }

  const dockerArgs = buildDockerArgs(parsed, scopedTarget.effectiveTarget, reportsPath);
  if (parsed.debugDocker) {
    console.log(commandLine("docker", dockerArgs));
  }

  const result = runner("docker", dockerArgs, { stdio: "inherit", env });
  if (result.error) {
    console.error(`Falha ao executar docker run: ${result.error.message}`);
    return 3;
  }

  augmentQualityReports(reportsPath, scopedTarget.scope);
  return result.status ?? 3;
}

if (require.main === module) {
  process.exit(runDockerWrapper(process.argv.slice(2)));
}

module.exports = {
  DEFAULT_IMAGE,
  PACKAGE_ROOT,
  parseArgs,
  ensureTarget,
  buildDockerArgs,
  quoteForDisplay,
  commandLine,
  isDockerAvailable,
  dockerDesktopCandidates,
  startDockerDaemon,
  waitForDocker,
  ensureDockerAvailable,
  imageExists,
  canBuildBundledImage,
  buildBundledImage,
  buildLocalSidecarArgs,
  runLocalSidecar,
  helpText,
  resolveScopeFiles,
  resolveScopedTarget,
  matchesPattern,
  augmentQualityReports,
  writeEmptyQualityReport,
  normalizeFormatValue,
  runDockerWrapper
};
