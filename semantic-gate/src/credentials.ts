import fs from "node:fs";
import path from "node:path";
import { globalSecretsPath, readJsonIfExists } from "./config.js";

export interface StoredSecretInfo {
  provider: string;
  configured: boolean;
  source: "env" | "stored" | "none";
  envName?: string;
  masked?: string;
}

export function setStoredApiKey(provider: string, apiKey: string): string {
  const normalized = normalizeProviderKey(provider);
  const filePath = globalSecretsPath();
  const secrets = readSecrets(filePath);
  secrets[normalized] = apiKey.trim();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows may ignore POSIX modes; the file still remains user-local.
  }
  return filePath;
}

export function unsetStoredApiKey(provider: string): string {
  const normalized = normalizeProviderKey(provider);
  const filePath = globalSecretsPath();
  const secrets = readSecrets(filePath);
  delete secrets[normalized];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

export function listStoredApiKeys(env = process.env): StoredSecretInfo[] {
  const secrets = readSecrets(globalSecretsPath());
  const known = new Set([
    ...Object.keys(secrets),
    "openrouter",
    "openai",
    "anthropic",
    "gemini",
    "openai-compatible",
    "opencode-api",
  ]);
  return [...known].sort().map((provider) => {
    const envName = defaultApiKeyEnv(provider);
    const envNames = uniqueStrings([envName, ...alternateApiKeyEnvs(provider)].filter((name): name is string => Boolean(name)));
    const configuredEnvName = envNames.find((name) => env[name]);
    const envValue = configuredEnvName ? env[configuredEnvName] : undefined;
    const stored = secrets[provider];
    if (envValue) {
      return withEnvName({ provider, configured: true, source: "env", masked: maskSecret(envValue) }, configuredEnvName);
    }
    if (stored) {
      return withEnvName({ provider, configured: true, source: "stored", masked: maskSecret(stored) }, envName);
    }
    return withEnvName({ provider, configured: false, source: "none" }, envName);
  });
}

export function resolveApiKey(options: {
  provider: string;
  envName?: string;
  keyProvider?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = options.env ?? process.env;
  if (options.envName && env[options.envName]) {
    return env[options.envName];
  }
  const normalizedProvider = normalizeProviderKey(options.keyProvider ?? options.provider);
  const defaultEnv = defaultApiKeyEnv(normalizedProvider);
  if (defaultEnv && env[defaultEnv]) {
    return env[defaultEnv];
  }
  for (const envName of alternateApiKeyEnvs(normalizedProvider)) {
    if (env[envName]) {
      return env[envName];
    }
  }
  const secrets = readSecrets(globalSecretsPath());
  return secrets[normalizedProvider];
}

export function defaultApiKeyEnv(provider: string): string | undefined {
  switch (normalizeProviderKey(provider)) {
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
    case "claude":
    case "claude-api":
      return "ANTHROPIC_API_KEY";
    case "gemini":
    case "gemini-api":
      return "GEMINI_API_KEY";
    case "openai-compatible":
      return "SEMANTIC_GATE_API_KEY";
    case "opencode-api":
      return "OPENCODE_API_KEY";
    default:
      return undefined;
  }
}

export function alternateApiKeyEnvs(provider: string): string[] {
  switch (normalizeProviderKey(provider)) {
    case "anthropic":
      return ["CLAUDE_API_KEY"];
    default:
      return [];
  }
}

export function normalizeProviderKey(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "claude") {
    return "anthropic";
  }
  if (normalized === "claude-api") {
    return "anthropic";
  }
  if (normalized === "gemini-api") {
    return "gemini";
  }
  return normalized;
}

function withEnvName<T extends StoredSecretInfo>(info: Omit<T, "envName">, envName: string | undefined): T {
  return (envName ? { ...info, envName } : info) as T;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function readSecrets(filePath: string): Record<string, string> {
  const parsed = readJsonIfExists(filePath);
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value) {
      secrets[normalizeProviderKey(key)] = value;
    }
  }
  return secrets;
}

function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) {
    return "****";
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
