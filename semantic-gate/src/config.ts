import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SemanticGateError } from "./errors.js";
import { parseScalar } from "./args.js";
import type { CliOptions, SemanticGateConfig } from "./types.js";

export const PROJECT_CONFIG = ".semantic-gate.json";

export const defaultConfig: SemanticGateConfig = {
  scope: "changed",
  threshold: 90,
  output: "json",
  paths: [],
  excludes: [],
  includes: [],
  ignoreFiles: [],
  includeUntracked: true,
  maxContextChars: 160_000,
  maxFileChars: 50_000,
  maxDiffChars: 60_000,
  contextStrategy: "auto",
  outputDir: ".quality/semantic-gate",
  writeReports: true,
  timeoutMs: 300_000,
  temperature: 0,
  codexSandbox: "danger-full-access",
  codexBypassSandbox: false,
  codexSkipGitRepoCheck: true,
  commandPromptMode: "stdin",
  commandOutput: "text",
};

export function globalConfigDir(): string {
  if (process.env.SEMANTIC_GATE_HOME) {
    return process.env.SEMANTIC_GATE_HOME;
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "semantic-gate");
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "semantic-gate");
}

export function globalConfigPath(): string {
  return path.join(globalConfigDir(), "config.json");
}

export function globalSecretsPath(): string {
  return path.join(globalConfigDir(), "secrets.json");
}

export function findProjectConfig(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, PROJECT_CONFIG);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function loadEffectiveConfig(cwd: string, cliOptions: CliOptions): SemanticGateConfig {
  const globalConfig = readJsonIfExists(globalConfigPath());
  const projectPath = findProjectConfig(cwd);
  const projectConfig = projectPath ? readJsonIfExists(projectPath) : {};
  const envConfig = configFromEnv(process.env);
  const flagConfig = normalizeFlagConfig(cliOptions);

  return normalizeConfig({
    ...defaultConfig,
    ...globalConfig,
    ...projectConfig,
    ...envConfig,
    ...flagConfig,
  }, cliOptions);
}

export function readJsonIfExists(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const text = fs.readFileSync(filePath, "utf8");
  if (!text.trim()) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SemanticGateError(`Config file is not a JSON object: ${filePath}`, "usage");
  }
  return parsed as Record<string, unknown>;
}

export function configFromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  setIfPresent(config, "provider", env.SEMANTIC_GATE_PROVIDER);
  setIfPresent(config, "model", env.SEMANTIC_GATE_MODEL);
  setIfPresent(config, "scope", env.SEMANTIC_GATE_SCOPE);
  setIfPresent(config, "paths", env.SEMANTIC_GATE_PATHS);
  setIfPresent(config, "excludes", env.SEMANTIC_GATE_EXCLUDES);
  setIfPresent(config, "includes", env.SEMANTIC_GATE_INCLUDES);
  setIfPresent(config, "ignoreFiles", env.SEMANTIC_GATE_IGNORE_FILES);
  setIfPresent(config, "threshold", env.SEMANTIC_GATE_THRESHOLD);
  setIfPresent(config, "output", env.SEMANTIC_GATE_OUTPUT);
  setIfPresent(config, "base", env.SEMANTIC_GATE_BASE);
  setIfPresent(config, "head", env.SEMANTIC_GATE_HEAD);
  setIfPresent(config, "maxContextChars", env.SEMANTIC_GATE_MAX_CONTEXT_CHARS);
  setIfPresent(config, "maxFileChars", env.SEMANTIC_GATE_MAX_FILE_CHARS);
  setIfPresent(config, "maxDiffChars", env.SEMANTIC_GATE_MAX_DIFF_CHARS);
  setIfPresent(config, "contextStrategy", env.SEMANTIC_GATE_CONTEXT_STRATEGY);
  setIfPresent(config, "outputDir", env.SEMANTIC_GATE_OUTPUT_DIR);
  setIfPresent(config, "writeReports", env.SEMANTIC_GATE_WRITE_REPORTS);
  setIfPresent(config, "timeoutMs", env.SEMANTIC_GATE_TIMEOUT_MS);
  setIfPresent(config, "temperature", env.SEMANTIC_GATE_TEMPERATURE);
  setIfPresent(config, "baseUrl", env.SEMANTIC_GATE_BASE_URL);
  setIfPresent(config, "apiKeyEnv", env.SEMANTIC_GATE_API_KEY_ENV);
  setIfPresent(config, "apiKeyProvider", env.SEMANTIC_GATE_API_KEY_PROVIDER);
  setIfPresent(config, "reasoningEffort", env.SEMANTIC_GATE_REASONING_EFFORT);
  setIfPresent(config, "codexSandbox", env.SEMANTIC_GATE_CODEX_SANDBOX);
  setIfPresent(config, "codexBypassSandbox", env.SEMANTIC_GATE_CODEX_BYPASS_SANDBOX);
  setIfPresent(config, "codexSkipGitRepoCheck", env.SEMANTIC_GATE_CODEX_SKIP_GIT_REPO_CHECK);
  setIfPresent(config, "command", env.SEMANTIC_GATE_COMMAND);
  setIfPresent(config, "commandArgs", env.SEMANTIC_GATE_COMMAND_ARGS);
  setIfPresent(config, "modelListCommand", env.SEMANTIC_GATE_MODEL_LIST_COMMAND);
  setIfPresent(config, "modelListArgs", env.SEMANTIC_GATE_MODEL_LIST_ARGS);
  setIfPresent(config, "commandPromptMode", env.SEMANTIC_GATE_COMMAND_PROMPT_MODE);
  return config;
}

export function writeConfigValue(
  cwd: string,
  scope: "global" | "project",
  key: string,
  value: unknown,
): string {
  const filePath = scope === "global" ? globalConfigPath() : path.join(cwd, PROJECT_CONFIG);
  const config = readJsonIfExists(filePath);
  config[key] = value;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

export function unsetConfigValue(cwd: string, scope: "global" | "project", key: string): string {
  const filePath = scope === "global" ? globalConfigPath() : path.join(cwd, PROJECT_CONFIG);
  const config = readJsonIfExists(filePath);
  delete config[key];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

export function initProjectConfig(cwd: string): string {
  const filePath = path.join(cwd, PROJECT_CONFIG);
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  const config = {
    threshold: 90,
    includeUntracked: true,
    maxContextChars: 160_000,
    contextStrategy: "auto",
    outputDir: ".quality/semantic-gate",
  };
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

export function configTargetScope(options: CliOptions): "global" | "project" {
  if (options.project) {
    return "project";
  }
  return "global";
}

function normalizeFlagConfig(options: CliOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (
      key === "objectiveFile" ||
      key === "objectiveStdin" ||
      key === "json" ||
      key === "ci" ||
      key === "project" ||
      key === "global" ||
      value === undefined
    ) {
      continue;
    }
    config[key] = value;
  }
  if (options.json || options.ci) {
    config.output = "json";
  }
  return config;
}

function normalizeConfig(input: Record<string, unknown>, cliOptions: CliOptions = {}): SemanticGateConfig {
  const output = { ...defaultConfig, ...input } as SemanticGateConfig;
  output.threshold = numberValue(input.threshold, defaultConfig.threshold, "threshold");
  output.maxContextChars = numberValue(input.maxContextChars, defaultConfig.maxContextChars, "maxContextChars");
  output.maxFileChars = numberValue(input.maxFileChars, defaultConfig.maxFileChars, "maxFileChars");
  output.maxDiffChars = numberValue(input.maxDiffChars, defaultConfig.maxDiffChars, "maxDiffChars");
  output.timeoutMs = numberValue(input.timeoutMs, defaultConfig.timeoutMs, "timeoutMs");
  output.temperature = numberValue(input.temperature, defaultConfig.temperature, "temperature");
  output.includeUntracked = booleanValue(input.includeUntracked, defaultConfig.includeUntracked);
  output.writeReports = booleanValue(input.writeReports, defaultConfig.writeReports);
  output.codexBypassSandbox = booleanValue(input.codexBypassSandbox, defaultConfig.codexBypassSandbox);
  output.codexSkipGitRepoCheck = booleanValue(input.codexSkipGitRepoCheck, defaultConfig.codexSkipGitRepoCheck);
  output.paths = stringArrayValue(input.paths, defaultConfig.paths);
  output.excludes = stringArrayValue(input.excludes, defaultConfig.excludes);
  output.includes = stringArrayValue(input.includes, defaultConfig.includes);
  output.ignoreFiles = stringArrayValue(input.ignoreFiles, defaultConfig.ignoreFiles);

  if (!["changed", "full", "paths"].includes(output.scope)) {
    throw new SemanticGateError("scope must be changed, full, or paths.", "usage");
  }
  const cliPaths = Array.isArray(cliOptions.paths) ? cliOptions.paths : [];
  if (output.scope !== "paths" && cliPaths.length > 0) {
    throw new SemanticGateError("--path can only be used with scope=paths.", "usage");
  }
  if (output.scope !== "paths") {
    output.paths = [];
  }
  if (output.scope === "paths" && output.paths.length === 0) {
    throw new SemanticGateError("scope=paths requires at least one --path.", "usage");
  }
  if (input.commandArgs !== undefined) {
    if (Array.isArray(input.commandArgs)) {
      output.commandArgs = input.commandArgs.map(String);
    } else if (typeof input.commandArgs === "string" && input.commandArgs.trim()) {
      const parsed = parseScalar(input.commandArgs);
      output.commandArgs = Array.isArray(parsed) ? parsed.map(String) : input.commandArgs.split(/\s+/);
    }
  }
  if (input.modelListArgs !== undefined) {
    if (Array.isArray(input.modelListArgs)) {
      output.modelListArgs = input.modelListArgs.map(String);
    } else if (typeof input.modelListArgs === "string" && input.modelListArgs.trim()) {
      const parsed = parseScalar(input.modelListArgs);
      output.modelListArgs = Array.isArray(parsed) ? parsed.map(String) : input.modelListArgs.split(/\s+/);
    }
  }

  if (output.output !== "json" && output.output !== "markdown") {
    throw new SemanticGateError("output must be json or markdown.", "usage");
  }
  if (!["single", "chunked", "auto"].includes(output.contextStrategy)) {
    throw new SemanticGateError("contextStrategy must be single, chunked, or auto.", "usage");
  }
  if (!["stdin", "argument"].includes(output.commandPromptMode)) {
    throw new SemanticGateError("commandPromptMode must be stdin or argument.", "usage");
  }
  if (!["text", "json"].includes(output.commandOutput)) {
    throw new SemanticGateError("commandOutput must be text or json.", "usage");
  }
  if (input.codexSandbox === null || input.codexSandbox === false || input.codexSandbox === "") {
    output.codexSandbox = undefined;
  } else if (input.codexSandbox !== undefined) {
    output.codexSandbox = String(input.codexSandbox) as SemanticGateConfig["codexSandbox"];
  }
  if (
    output.codexSandbox &&
    !["read-only", "workspace-write", "danger-full-access"].includes(output.codexSandbox)
  ) {
    throw new SemanticGateError("codexSandbox must be read-only, workspace-write, or danger-full-access.", "usage");
  }
  return output;
}

function setIfPresent(config: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined && value !== "") {
    config[key] = parseScalar(value);
  }
}

function numberValue(value: unknown, fallback: number, key: string): number {
  if (value === undefined) {
    return fallback;
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new SemanticGateError(`${key} must be a number.`, "usage");
  }
  return number;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return String(value).toLowerCase() === "true";
}

function stringArrayValue(value: unknown, fallback: string[]): string[] {
  if (value === undefined) {
    return fallback;
  }
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (typeof value === "string") {
    const parsed = parseScalar(value);
    if (Array.isArray(parsed)) {
      return parsed.map(String).filter(Boolean);
    }
    return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [String(value)].filter(Boolean);
}
