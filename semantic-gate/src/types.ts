export type GateStatus = "APPROVED" | "NEEDS_CHANGES" | "REJECTED";

export type FindingSeverity = "blocking" | "important" | "suggestion" | "nit";

export type FindingCategory =
  | "functional"
  | "tests"
  | "security"
  | "maintainability"
  | "architecture"
  | "performance"
  | "ai-generated-code-risk";

export interface SemanticGateConfig {
  scope: "changed" | "full" | "paths";
  provider?: string;
  model?: string;
  threshold: number;
  output: "json" | "markdown";
  base?: string;
  head?: string;
  paths: string[];
  excludes: string[];
  includes: string[];
  ignoreFiles: string[];
  includeUntracked: boolean;
  maxContextChars: number;
  maxFileChars: number;
  maxDiffChars: number;
  contextStrategy: "single" | "chunked" | "auto";
  outputDir: string;
  writeReports: boolean;
  timeoutMs: number;
  temperature: number;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKeyProvider?: string;
  reasoningEffort?: string;
  command?: string;
  commandArgs?: string[];
  modelListCommand?: string;
  modelListArgs?: string[];
  commandPromptMode: "stdin" | "argument";
  commandOutput: "text" | "json";
}

export interface CliOptions {
  [key: string]: unknown;
  objectiveFile?: string;
  objectiveStdin?: boolean;
  json?: boolean;
  ci?: boolean;
  project?: boolean;
  global?: boolean;
  cwd?: string;
}

export interface ParsedCli {
  command: "run" | "init" | "config" | "auth" | "models" | "setup" | "status" | "help" | "version";
  subcommand?: string;
  positional: string[];
  options: CliOptions;
}

export interface ObjectiveInput {
  text: string;
  source: string;
}

export interface CommandRecord {
  command: string;
  result: string;
  purpose: string;
}

export interface FileContext {
  path: string;
  changeKinds: string[];
  diff?: string;
  stagedDiff?: string;
  content?: string;
  skippedReason?: string;
  truncated?: boolean;
}

export interface GitReviewContext {
  repoRoot: string;
  scope: "changed" | "full" | "paths";
  paths: string[];
  excludes: string[];
  includes: string[];
  ignoreFiles: string[];
  statusShort: string;
  diffStat: string;
  stagedDiffStat: string;
  rangeDiffStat?: string;
  commandsExecuted: CommandRecord[];
  changedFiles: FileContext[];
  warnings: string[];
}

export interface ScoreBreakdownItem {
  category: string;
  weight: number;
  score: number;
  observations: string;
}

export interface SemanticFinding {
  severity: FindingSeverity;
  category: FindingCategory | string;
  path?: string;
  line?: number;
  message: string;
  requiredFix?: string;
}

export interface GateResult {
  gate: "semantic";
  status: GateStatus;
  score: number;
  threshold: number;
  deterministicSummaryUsed: false;
  objectiveSource: string;
  changesReviewed: string;
  scoreAppliesTo: "changed-files" | "entire-project" | "selected-paths";
  hardBlockers: string[];
  scoreBreakdown: ScoreBreakdownItem[];
  commandsExecuted: CommandRecord[];
  findings: SemanticFinding[];
  requiredFixPlan: string[];
  rerunCommands: string[];
  approvalNotes: string;
  residualRisks: string[];
  contextWarnings: string[];
  provider: string;
  model?: string;
}

export interface ProviderRequest {
  prompt: string;
  system: string;
  config: SemanticGateConfig;
  cwd?: string;
  chunkLabel?: string;
}

export interface ProviderResponse {
  text: string;
  raw: unknown;
}

export interface ProviderModel {
  id: string;
  name?: string;
  raw?: unknown;
}
