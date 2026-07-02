import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SemanticGateError } from "./errors.js";
import type { GitReviewContext, ObjectiveInput, SemanticGateConfig } from "./types.js";

export interface PromptChunk {
  label: string;
  prompt: string;
}

export function systemPrompt(): string {
  return [
    "You are semantic-gate, an AI semantic code review gate.",
    "Return valid JSON only. Do not include Markdown fences.",
    "Do not use deterministic quality gate summaries as input.",
    "Do not inspect, infer, request, or classify secrets or PII.",
  ].join("\n");
}

export function buildPromptChunks(
  objective: ObjectiveInput,
  context: GitReviewContext,
  config: SemanticGateConfig,
): PromptChunk[] {
  const shared = buildSharedHeader(objective, context, config);
  if (shared.length > config.maxContextChars) {
    throw new SemanticGateError(
      `Objective and repository metadata exceed maxContextChars (${shared.length} > ${config.maxContextChars}).`,
      "context",
    );
  }

  const fileBlocks = context.changedFiles.map(formatFileBlock);
  const allFiles = fileBlocks.join("\n\n");
  const singlePrompt = `${shared}\n\n## File Context\n\n${allFiles}\n\n${finalInstruction(config)}`;

  if (config.contextStrategy !== "chunked" && singlePrompt.length <= config.maxContextChars) {
    return [{ label: "full-review", prompt: singlePrompt }];
  }
  if (config.contextStrategy === "single" && singlePrompt.length > config.maxContextChars) {
    throw new SemanticGateError(
      `Context exceeds maxContextChars (${singlePrompt.length} > ${config.maxContextChars}). Use a larger model or contextStrategy=chunked.`,
      "context",
    );
  }

  const chunks: PromptChunk[] = [];
  let currentBlocks: string[] = [];
  let currentLength = shared.length + finalInstruction(config).length + 40;

  for (const block of fileBlocks) {
    const blockLength = block.length + 2;
    if (currentBlocks.length > 0 && currentLength + blockLength > config.maxContextChars) {
      chunks.push(chunkPrompt(shared, currentBlocks, chunks.length + 1, config));
      currentBlocks = [];
      currentLength = shared.length + finalInstruction(config).length + 40;
    }
    if (blockLength + shared.length > config.maxContextChars) {
      throw new SemanticGateError(
        `A single file context block exceeds maxContextChars. Lower maxFileChars/maxDiffChars or use a larger model.`,
        "context",
      );
    }
    currentBlocks.push(block);
    currentLength += blockLength;
  }

  if (currentBlocks.length > 0 || chunks.length === 0) {
    chunks.push(chunkPrompt(shared, currentBlocks, chunks.length + 1, config));
  }
  return chunks;
}

export function buildSynthesisPrompt(
  objective: ObjectiveInput,
  context: GitReviewContext,
  partialResults: unknown[],
  config: SemanticGateConfig,
): string {
  return [
    buildSharedHeader(objective, context, config),
    "## Partial Semantic Reviews",
      "The following JSON objects are partial semantic reviews over disjoint file-context chunks. Synthesize a final gate result for the requested scope.",
    JSON.stringify(partialResults, null, 2),
    finalInstruction(config),
  ].join("\n\n");
}

function chunkPrompt(
  shared: string,
  blocks: string[],
  index: number,
  config: SemanticGateConfig,
): PromptChunk {
  return {
    label: `chunk-${index}`,
    prompt: `${shared}\n\n## File Context Chunk ${index}\n\n${blocks.join("\n\n")}\n\n${finalInstruction(config)}`,
  };
}

function buildSharedHeader(
  objective: ObjectiveInput,
  context: GitReviewContext,
  config: SemanticGateConfig,
): string {
  return [
    "## Semantic Review Rubric",
    loadSkillTemplate(),
    "## Objective",
    `Source: ${objective.source}`,
    objective.text,
    "## Repository Context",
    `Repo root: ${context.repoRoot}`,
    `Scope: ${context.scope}`,
    `Configured paths: ${context.paths.length ? context.paths.join(", ") : "(none)"}`,
    `Configured excludes: ${context.excludes.length ? context.excludes.join(", ") : "(none)"}`,
    `Configured includes: ${context.includes.length ? context.includes.join(", ") : "(none)"}`,
    `Ignore files used: ${context.ignoreFiles.length ? context.ignoreFiles.join(", ") : "(none)"}`,
    `Threshold: ${config.threshold}`,
    "Deterministic summary used: false",
    "## Git Status",
    fenced(context.statusShort || "(clean status output)"),
    "## Diff Stats",
    fenced(
      [
        context.rangeDiffStat ? `Range diff stat:\n${context.rangeDiffStat}` : undefined,
        context.diffStat ? `Unstaged diff stat:\n${context.diffStat}` : undefined,
        context.stagedDiffStat ? `Staged diff stat:\n${context.stagedDiffStat}` : undefined,
      ]
        .filter(Boolean)
        .join("\n\n") || "(no diff stat output)",
    ),
    "## Context Warnings",
    context.warnings.length ? context.warnings.map((warning) => `- ${warning}`).join("\n") : "- None",
  ].join("\n\n");
}

function formatFileBlock(file: GitReviewContext["changedFiles"][number]): string {
  const parts = [
    `### ${file.path}`,
    `Change kinds: ${file.changeKinds.join(", ") || "unknown"}`,
  ];
  if (file.skippedReason) {
    parts.push(`Skipped content reason: ${file.skippedReason}`);
  }
  if (file.diff) {
    parts.push("Unstaged/range diff:", fenced(file.diff));
  }
  if (file.stagedDiff) {
    parts.push("Staged diff:", fenced(file.stagedDiff));
  }
  if (file.content !== undefined) {
    parts.push("Current file content:", fenced(file.content));
  }
  if (file.truncated) {
    parts.push("Context note: this file or diff was truncated by configured safety limits.");
  }
  return parts.join("\n\n");
}

function finalInstruction(config: SemanticGateConfig): string {
  return [
    "## Output Contract",
    "Return one JSON object matching this shape:",
    fenced(
      JSON.stringify(
        {
          gate: "semantic",
          status: "APPROVED | NEEDS_CHANGES | REJECTED",
          score: "0-100",
          threshold: config.threshold,
          deterministicSummaryUsed: false,
          objectiveSource: "file:path | stdin | inferred from diff",
          changesReviewed: "short description",
          hardBlockers: ["string"],
          scoreBreakdown: [
            { category: "functional", weight: 25, score: 0, observations: "string" },
            { category: "tests", weight: 20, score: 0, observations: "string" },
            { category: "security", weight: 20, score: 0, observations: "string" },
            { category: "maintainability", weight: 15, score: 0, observations: "string" },
            { category: "architecture", weight: 10, score: 0, observations: "string" },
            { category: "performance", weight: 10, score: 0, observations: "string" },
          ],
          commandsExecuted: [{ command: "git status --short", result: "ok", purpose: "identify changed files" }],
          findings: [
            {
              severity: "blocking | important | suggestion | nit",
              category: "functional | tests | security | maintainability | architecture | performance | ai-generated-code-risk",
              path: "relative/path",
              line: 1,
              message: "concrete issue",
              requiredFix: "concrete fix",
            },
          ],
          requiredFixPlan: ["step"],
          rerunCommands: [
            "code-approval-gates semantic --scope changed --objective-file <file> --json --no-interactive",
            "code-approval-gates quality --scope changed --json --no-interactive",
          ],
          approvalNotes: "string",
          residualRisks: ["string"],
          contextWarnings: ["string"],
        },
        null,
        2,
      ),
    ),
    "Do not include deterministic findings unless they have a separate semantic consequence. Do not output Markdown.",
  ].join("\n\n");
}

function loadSkillTemplate(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const templatePath = path.resolve(path.dirname(currentFile), "../templates/semantic-review-skill.md");
  if (!fs.existsSync(templatePath)) {
    throw new SemanticGateError(`Missing semantic review template: ${templatePath}`, "context");
  }
  return fs.readFileSync(templatePath, "utf8");
}

function fenced(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}
