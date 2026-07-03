import { alternateApiKeyEnvs, defaultApiKeyEnv, normalizeProviderKey, resolveApiKey } from "./credentials.js";
import { findProjectConfig, globalConfigPath } from "./config.js";
import type { SemanticGateConfig } from "./types.js";

interface CredentialStatus {
  required: boolean;
  configured: boolean;
  source: "env" | "stored" | "none" | "not-required";
  envName?: string;
}

export interface StatusSummary {
  provider: string | null;
  model: string | null;
  scope: string;
  paths: string[];
  excludes: string[];
  includes: string[];
  ignoreFiles: string[];
  threshold: number;
  output: string;
  contextStrategy: string;
  includeUntracked: boolean;
  writeReports: boolean;
  outputDir: string;
  maxContextChars: number;
  maxFileChars: number;
  maxDiffChars: number;
  timeoutMs: number;
  temperature: number;
  base: string | null;
  head: string | null;
  baseUrl: string | null;
  codexSandbox: string | null;
  codexBypassSandbox: boolean;
  codexSkipGitRepoCheck: boolean;
  command: string | null;
  commandArgs: string[] | null;
  commandPromptMode: string;
  modelListCommand: string | null;
  modelListArgs: string[] | null;
  configFiles: {
    global: string;
    project: string | null;
  };
  credential: CredentialStatus;
}

export function buildStatusSummary(cwd: string, config: SemanticGateConfig): StatusSummary {
  return {
    provider: config.provider ?? null,
    model: config.model ?? null,
    scope: config.scope,
    paths: config.paths,
    excludes: config.excludes,
    includes: config.includes,
    ignoreFiles: config.ignoreFiles,
    threshold: config.threshold,
    output: config.output,
    contextStrategy: config.contextStrategy,
    includeUntracked: config.includeUntracked,
    writeReports: config.writeReports,
    outputDir: config.outputDir,
    maxContextChars: config.maxContextChars,
    maxFileChars: config.maxFileChars,
    maxDiffChars: config.maxDiffChars,
    timeoutMs: config.timeoutMs,
    temperature: config.temperature,
    base: config.base ?? null,
    head: config.head ?? null,
    baseUrl: config.baseUrl ?? null,
    codexSandbox: config.codexSandbox ?? null,
    codexBypassSandbox: config.codexBypassSandbox,
    codexSkipGitRepoCheck: config.codexSkipGitRepoCheck,
    command: config.command ?? null,
    commandArgs: config.commandArgs ?? null,
    commandPromptMode: config.commandPromptMode,
    modelListCommand: config.modelListCommand ?? null,
    modelListArgs: config.modelListArgs ?? null,
    configFiles: {
      global: globalConfigPath(),
      project: findProjectConfig(cwd) ?? null,
    },
    credential: credentialStatus(config),
  };
}

export function renderStatus(summary: StatusSummary): string {
  const lines = [
    "Semantic Gate Status",
    "",
    `Provider: ${summary.provider ?? "(not set)"}`,
    `Model: ${summary.model ?? "(not set)"}`,
    `Scope: ${summary.scope}`,
    `Paths: ${summary.paths.length ? summary.paths.join(", ") : "(none)"}`,
    `Excludes: ${summary.excludes.length ? summary.excludes.join(", ") : "(none)"}`,
    `Includes: ${summary.includes.length ? summary.includes.join(", ") : "(none)"}`,
    `Ignore files: ${summary.ignoreFiles.length ? summary.ignoreFiles.join(", ") : "(auto)"}`,
    `Threshold: ${summary.threshold}`,
    `Output: ${summary.output}`,
    `Context strategy: ${summary.contextStrategy}`,
    `Include untracked: ${formatBoolean(summary.includeUntracked)}`,
    `Write reports: ${formatBoolean(summary.writeReports)}`,
    `Reports dir: ${summary.outputDir}`,
    `Max context chars: ${summary.maxContextChars}`,
    `Max file chars: ${summary.maxFileChars}`,
    `Max diff chars: ${summary.maxDiffChars}`,
    `Timeout ms: ${summary.timeoutMs}`,
    `Temperature: ${summary.temperature}`,
    `Base ref: ${summary.base ?? "(working tree)"}`,
    `Head ref: ${summary.head ?? "(working tree)"}`,
    `Base URL: ${summary.baseUrl ?? "(default/provider local)"}`,
    `Codex sandbox: ${summary.codexSandbox ?? "(disabled/custom command)"}`,
    `Codex bypass sandbox: ${formatBoolean(summary.codexBypassSandbox)}`,
    `Codex skip git repo check: ${formatBoolean(summary.codexSkipGitRepoCheck)}`,
    `Command: ${summary.command ?? "(provider default)"}`,
    `Command args: ${summary.commandArgs ? JSON.stringify(summary.commandArgs) : "(provider default)"}`,
    `Command prompt mode: ${summary.commandPromptMode}`,
    `Model list command: ${summary.modelListCommand ?? "(provider default)"}`,
    `Model list args: ${summary.modelListArgs ? JSON.stringify(summary.modelListArgs) : "(provider default)"}`,
    "",
    "Config files:",
    `Global: ${summary.configFiles.global}`,
    `Project: ${summary.configFiles.project ?? "(not found)"}`,
    "",
    `Credential: ${formatCredential(summary.credential)}`,
    "",
  ];
  return `${lines.join("\n")}`;
}

function credentialStatus(config: SemanticGateConfig): CredentialStatus {
  const provider = config.provider;
  if (!provider || !providerRequiresApiKey(provider)) {
    return { required: false, configured: false, source: "not-required" };
  }

  const keyProvider = normalizeProviderKey(config.apiKeyProvider ?? provider);
  const explicitEnvName = config.apiKeyEnv;
  const defaultEnvName = defaultApiKeyEnv(keyProvider);
  const envNames = uniqueStrings(
    [explicitEnvName, defaultEnvName, ...alternateApiKeyEnvs(keyProvider)].filter((name): name is string => Boolean(name)),
  );
  const configuredEnvName = envNames.find((envName) => process.env[envName]);
  if (configuredEnvName) {
    return { required: true, configured: true, source: "env", envName: configuredEnvName };
  }

  const envName = explicitEnvName ?? defaultEnvName ?? alternateApiKeyEnvs(keyProvider)[0];
  const resolveOptions: { provider: string; envName?: string; keyProvider?: string } = {
    provider,
    keyProvider,
  };
  if (explicitEnvName) {
    resolveOptions.envName = explicitEnvName;
  }
  const resolved = resolveApiKey(resolveOptions);
  if (resolved) {
    const status: CredentialStatus = {
      required: true,
      configured: true,
      source: "stored",
    };
    if (envName) {
      status.envName = envName;
    }
    return status;
  }

  const status: CredentialStatus = {
    required: true,
    configured: false,
    source: "none",
  };
  if (envName) {
    status.envName = envName;
  }
  return status;
}

function providerRequiresApiKey(provider: string): boolean {
  switch (normalizeProviderKey(provider)) {
    case "openrouter":
    case "openai":
    case "anthropic":
    case "gemini":
    case "openai-compatible":
    case "opencode-api":
      return true;
    default:
      return false;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function formatBoolean(value: boolean): string {
  return value ? "true" : "false";
}

function formatCredential(status: CredentialStatus): string {
  if (!status.required) {
    return "not required for current provider";
  }
  if (!status.configured) {
    return status.envName ? `missing; expected env ${status.envName} or stored key` : "missing";
  }
  if (status.source === "env") {
    return status.envName ? `configured from env ${status.envName}` : "configured from env";
  }
  if (status.source === "stored") {
    return status.envName ? `configured from user-local secret store; env override ${status.envName}` : "configured from user-local secret store";
  }
  return "missing";
}
