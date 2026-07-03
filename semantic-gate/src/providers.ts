import { SemanticGateError } from "./errors.js";
import { runCommand } from "./shell.js";
import { resolveApiKey } from "./credentials.js";
import type { ProviderModel, ProviderRequest, ProviderResponse, SemanticGateConfig } from "./types.js";

export async function callProvider(request: ProviderRequest): Promise<ProviderResponse> {
  const provider = request.config.provider;
  if (!provider) {
    throw new SemanticGateError(
      "No provider configured. Run `semantic-gate config set provider <provider>` or pass --provider.",
      "provider",
    );
  }

  switch (provider) {
    case "mock":
      return mockProvider(request);
    case "openrouter":
      return openAiCompatibleProvider(request, {
        provider: "openrouter",
        baseUrl: request.config.baseUrl ?? "https://openrouter.ai/api/v1",
        apiKeyEnv: request.config.apiKeyEnv ?? "OPENROUTER_API_KEY",
      });
    case "openai":
      return openAiCompatibleProvider(request, {
        provider: "openai",
        baseUrl: request.config.baseUrl ?? "https://api.openai.com/v1",
        apiKeyEnv: request.config.apiKeyEnv ?? "OPENAI_API_KEY",
      });
    case "openai-compatible":
      return openAiCompatibleProvider(
        request,
        request.config.baseUrl === undefined
          ? { provider: "openai-compatible", apiKeyEnv: request.config.apiKeyEnv ?? "SEMANTIC_GATE_API_KEY" }
          : {
              provider: "openai-compatible",
              baseUrl: request.config.baseUrl,
              apiKeyEnv: request.config.apiKeyEnv ?? "SEMANTIC_GATE_API_KEY",
            },
      );
    case "opencode-api":
      return openAiCompatibleProvider(
        request,
        request.config.baseUrl === undefined
          ? { provider: "opencode-api", apiKeyEnv: request.config.apiKeyEnv ?? "OPENCODE_API_KEY" }
          : {
              provider: "opencode-api",
              baseUrl: request.config.baseUrl,
              apiKeyEnv: request.config.apiKeyEnv ?? "OPENCODE_API_KEY",
            },
      );
    case "anthropic":
    case "claude":
    case "claude-api":
      return anthropicProvider(request);
    case "ollama":
      return ollamaProvider(request);
    case "gemini":
    case "gemini-api":
      return geminiProvider(request);
    case "command":
    case "codex-cli":
    case "claude-code":
    case "gemini-cli":
    case "opencode":
      return commandProvider(request);
    default:
      throw new SemanticGateError(`Unsupported provider: ${provider}`, "provider");
  }
}

function mockProvider(request: ProviderRequest): ProviderResponse {
  const text =
    process.env.SEMANTIC_GATE_MOCK_RESPONSE ??
    JSON.stringify({
      gate: "semantic",
      status: "APPROVED",
      score: 100,
      threshold: request.config.threshold,
      deterministicSummaryUsed: false,
      objectiveSource: "mock",
      changesReviewed: request.chunkLabel ?? "mock full review",
      hardBlockers: [],
      scoreBreakdown: [
        { category: "functional", weight: 25, score: 25, observations: "Mock provider." },
        { category: "tests", weight: 20, score: 20, observations: "Mock provider." },
        { category: "security", weight: 20, score: 20, observations: "Mock provider." },
        { category: "maintainability", weight: 15, score: 15, observations: "Mock provider." },
        { category: "architecture", weight: 10, score: 10, observations: "Mock provider." },
        { category: "performance", weight: 10, score: 10, observations: "Mock provider." },
      ],
      commandsExecuted: [],
      findings: [],
      requiredFixPlan: [],
      rerunCommands: [
        "code-approval-gates semantic --scope changed --objective-file <objective-file> --json --no-interactive",
        "code-approval-gates quality --scope changed --json --no-interactive",
      ],
      approvalNotes: "Mock provider approved the semantic review.",
      residualRisks: [],
      contextWarnings: [],
    });
  return { text, raw: { provider: "mock" } };
}

async function openAiCompatibleProvider(
  request: ProviderRequest,
  defaults: { provider: string; baseUrl?: string; apiKeyEnv: string },
): Promise<ProviderResponse> {
  const baseUrl = defaults.baseUrl;
  if (!baseUrl) {
    throw new SemanticGateError(`${defaults.provider} provider requires baseUrl or SEMANTIC_GATE_BASE_URL.`, "provider");
  }
  const apiKey = readApiKey(defaults.provider, defaults.apiKeyEnv, request.config);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: requireModel(request.config),
      temperature: request.config.temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
    }),
  });
  const json = await parseHttpJson(response);
  const text = jsonPath(json, ["choices", 0, "message", "content"]);
  if (typeof text !== "string") {
    throw new SemanticGateError("OpenAI-compatible provider returned no message content.", "provider", json);
  }
  return { text, raw: json };
}

async function anthropicProvider(request: ProviderRequest): Promise<ProviderResponse> {
  const apiKey = readApiKey("anthropic", request.config.apiKeyEnv ?? "ANTHROPIC_API_KEY", request.config);
  const response = await fetch(`${(request.config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: requireModel(request.config),
      max_tokens: 4096,
      temperature: request.config.temperature,
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
    }),
  });
  const json = await parseHttpJson(response);
  const text = Array.isArray(jsonPath(json, ["content"]))
    ? (jsonPath(json, ["content"]) as unknown[])
        .map((item) =>
          item && typeof item === "object" && "text" in item ? String((item as { text: unknown }).text) : "",
        )
        .join("\n")
    : undefined;
  if (!text) {
    throw new SemanticGateError("Anthropic provider returned no text content.", "provider", json);
  }
  return { text, raw: json };
}

async function ollamaProvider(request: ProviderRequest): Promise<ProviderResponse> {
  const host = (request.config.baseUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const response = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: requireModel(request.config),
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
    }),
  });
  const json = await parseHttpJson(response);
  const text = jsonPath(json, ["message", "content"]);
  if (typeof text !== "string") {
    throw new SemanticGateError("Ollama provider returned no message content.", "provider", json);
  }
  return { text, raw: json };
}

async function geminiProvider(request: ProviderRequest): Promise<ProviderResponse> {
  const apiKey = readApiKey("gemini", request.config.apiKeyEnv ?? "GEMINI_API_KEY", request.config);
  const model = requireModel(request.config);
  const baseUrl = (request.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      generationConfig: {
        temperature: request.config.temperature,
        responseMimeType: "application/json",
      },
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
    }),
  });
  const json = await parseHttpJson(response);
  const text = jsonPath(json, ["candidates", 0, "content", "parts", 0, "text"]);
  if (typeof text !== "string") {
    throw new SemanticGateError("Gemini API provider returned no text content.", "provider", json);
  }
  return { text, raw: json };
}

async function commandProvider(request: ProviderRequest): Promise<ProviderResponse> {
  const defaults = defaultCommandConfigForProvider(
    request.config.provider,
    request.config.model,
    request.config.reasoningEffort,
    request.config.codexSandbox,
    request.config.codexBypassSandbox,
    request.config.codexSkipGitRepoCheck,
  );
  const command = request.config.command ?? defaults.command;
  if (!command) {
    throw new SemanticGateError(
      "Command provider requires `command` in config. Example: semantic-gate config set command codex",
      "provider",
    );
  }
  const args = request.config.commandArgs ?? defaults.args ?? [];
  const promptMode = request.config.commandArgs ? request.config.commandPromptMode : defaults.promptMode ?? request.config.commandPromptMode;
  const finalArgs =
    promptMode === "argument"
      ? args.map((arg) => arg.replace("{prompt}", request.prompt))
      : args;
  const input = promptMode === "stdin" ? request.prompt : undefined;
  const runOptions: { cwd: string; input?: string; timeoutMs?: number } = {
    cwd: request.cwd ?? process.cwd(),
    timeoutMs: request.config.timeoutMs,
  };
  if (input !== undefined) {
    runOptions.input = input;
  }
  const result = await runCommand(command, finalArgs, runOptions);
  if (result.code !== 0) {
    const failure = classifyCommandProviderFailure(request.config.provider, result.code ?? 1, result.stderr || result.stdout);
    throw new SemanticGateError(failure.message, "provider", failure.details);
  }
  const text = request.config.commandOutput === "json" ? result.stdout : result.stdout.trim();
  return { text, raw: { stdout: result.stdout, stderr: result.stderr, code: result.code } };
}

function classifyCommandProviderFailure(
  provider: string | undefined,
  exitCode: number,
  output: string,
): { message: string; details: Record<string, unknown> } {
  const text = String(output || "");
  const runtimeLines = providerRuntimeLines(text);
  const details = {
    provider: provider ?? "command",
    exitCode,
    classification: "command-failed",
    advice: "Inspect the provider command configuration and rerun semantic-gate status.",
    diagnosticExcerpt: providerDiagnosticExcerpt(text),
  };

  if (runtimeLines.some(isProviderNetworkLine)) {
    return {
      message: `Command provider exited with ${exitCode}: provider network connection failed before a semantic response was returned.`,
      details: {
        ...details,
        classification: "provider-network",
        advice:
          "Verify network/firewall/sandbox access to the provider API. This is different from an API credential failure. For local Windows Firewall with codex-cli, run code-approval-gates doctor semantic --fix-network --yes from Administrator PowerShell.",
      },
    };
  }

  if (exitCode === 124 || runtimeLines.some(isProviderTimeoutLine)) {
    return {
      message: `Command provider exited with ${exitCode}: provider timed out before a semantic response was returned.`,
      details: {
        ...details,
        classification: "provider-timeout",
        advice: "Increase --timeout-ms or reduce the semantic context size. This is different from an API credential failure.",
      },
    };
  }

  if (runtimeLines.some(isProviderAuthLine)) {
    return {
      message: `Command provider exited with ${exitCode}: provider authentication failed.`,
      details: {
        ...details,
        classification: "provider-auth",
        advice: "Check the provider login/API key, configured model, and semantic-gate status.",
      },
    };
  }

  return {
    message: `Command provider exited with ${exitCode}.`,
    details,
  };
}

function providerDiagnosticExcerpt(output: string): string {
  const runtimeLines = providerRuntimeLines(output);
  const transportLines = runtimeLines.filter(isProviderNetworkLine);
  const timeoutLines = runtimeLines.filter(isProviderTimeoutLine);
  const operationalLines = transportLines.length ? [...transportLines, ...timeoutLines] : timeoutLines;
  const diagnosticLines = operationalLines.length
    ? operationalLines
    : runtimeLines.filter((line) =>
        /error|warning|failed|connect|socket|timeout|permission|denied|unauthorized|forbidden|api\.openai\.com|\/v1\/responses/i.test(line),
      );
  const selected = diagnosticLines.length ? diagnosticLines : runtimeLines.slice(-12);
  const excerpt = selected.slice(-20).join("\n");
  return excerpt.length > 2000 ? `${excerpt.slice(0, 900)}\n...<truncated>...\n${excerpt.slice(-900)}` : excerpt;
}

function providerRuntimeLines(output: string): string[] {
  return stripAnsi(String(output || ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !looksLikePromptContextLine(line));
}

function isProviderNetworkLine(line: string): boolean {
  return /codex_api|responses_websocket|failed to connect|stream disconnected|falling back from websockets|reconnecting|error sending request|os error \d+|wss:\/\/|econnrefused|enotfound|etimedout|permission denied|acesso negado/i.test(line);
}

function isProviderAuthLine(line: string): boolean {
  return /401|403|unauthorized|forbidden|invalid api key|authentication failed|api key rejected/i.test(line);
}

function isProviderTimeoutLine(line: string): boolean {
  return /^command timed out(\.| after \d+ms\.)?$/i.test(line);
}

function looksLikePromptContextLine(line: string): boolean {
  return (
    /^diff --git\b|^@@\b|^index [0-9a-f]+\.\.[0-9a-f]+/i.test(line) ||
    /^[+-]/.test(line) ||
    /^\d+:\s/.test(line) ||
    /^rg:\s/i.test(line) ||
    /(^|\s)[\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|md|json):\d+:/i.test(line) ||
    (/\|/.test(line) && /api\.openai\.com|responses_websocket|econnrefused|enotfound|etimedout|permission|wss:\\?\/\\?\//i.test(line)) ||
    /^[A-Za-z_$][\w$]*:\s+.*https?:\/\//.test(line) ||
    /SemanticGateError|providerDiagnosticExcerpt|runGateProcess|spawnSync|spawn\(/.test(line)
  );
}

function defaultCommandConfigForProvider(
  provider: string | undefined,
  model: string | undefined,
  reasoningEffort: string | undefined,
  codexSandbox: SemanticGateConfig["codexSandbox"],
  codexBypassSandbox: boolean,
  codexSkipGitRepoCheck: boolean,
): { command?: string; args?: string[]; promptMode?: "stdin" | "argument" } {
  switch (provider) {
    case "codex-cli":
      return {
        command: "codex",
        args: codexCliArgs(model, reasoningEffort, codexSandbox, codexBypassSandbox, codexSkipGitRepoCheck),
        promptMode: "stdin",
      };
    case "claude-code":
      return {
        command: "claude",
        args: model ? ["--print", "--model", model] : ["--print"],
        promptMode: "stdin",
      };
    case "gemini-cli":
      return {
        command: "gemini",
        args: model
          ? ["--model", model, "--prompt", "{prompt}", "--output-format", "text"]
          : ["--prompt", "{prompt}", "--output-format", "text"],
        promptMode: "argument",
      };
    case "opencode":
      return {
        command: "opencode",
        args: [],
        promptMode: "stdin",
      };
    default:
      return {};
  }
}

function codexCliArgs(
  model: string | undefined,
  reasoningEffort: string | undefined,
  codexSandbox: SemanticGateConfig["codexSandbox"],
  codexBypassSandbox: boolean,
  codexSkipGitRepoCheck: boolean,
): string[] {
  const args = ["exec"];
  if (model) {
    args.push("-m", model);
  }
  if (codexBypassSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (codexSandbox) {
    args.push("--sandbox", codexSandbox);
  }
  if (codexSkipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  }
  args.push("-");
  return args;
}

export async function listProviderModels(config: SemanticGateConfig): Promise<ProviderModel[]> {
  const provider = config.provider;
  if (!provider) {
    throw new SemanticGateError("No provider configured for model listing.", "provider");
  }
  switch (provider) {
    case "openrouter":
      return listOpenAiCompatibleModels(config, {
        provider: "openrouter",
        baseUrl: config.baseUrl ?? "https://openrouter.ai/api/v1",
        apiKeyEnv: config.apiKeyEnv ?? "OPENROUTER_API_KEY",
        requireApiKey: false,
      });
    case "openai":
      return listOpenAiCompatibleModels(config, {
        provider: "openai",
        baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
        apiKeyEnv: config.apiKeyEnv ?? "OPENAI_API_KEY",
        requireApiKey: true,
      });
    case "openai-compatible":
      if (!config.baseUrl) {
        throw new SemanticGateError("openai-compatible model listing requires baseUrl.", "provider");
      }
      return listOpenAiCompatibleModels(config, {
        provider: "openai-compatible",
        baseUrl: config.baseUrl,
        apiKeyEnv: config.apiKeyEnv ?? "SEMANTIC_GATE_API_KEY",
        requireApiKey: true,
      });
    case "opencode-api":
      if (!config.baseUrl) {
        throw new SemanticGateError("opencode-api model listing requires baseUrl.", "provider");
      }
      return listOpenAiCompatibleModels(config, {
        provider: "opencode-api",
        baseUrl: config.baseUrl,
        apiKeyEnv: config.apiKeyEnv ?? "OPENCODE_API_KEY",
        requireApiKey: true,
      });
    case "anthropic":
    case "claude":
    case "claude-api":
      return listAnthropicModels(config);
    case "gemini":
    case "gemini-api":
      return listGeminiModels(config);
    case "ollama":
      return listOllamaModels(config);
    case "codex-cli":
      return listCodexCliModels(config);
    case "opencode":
      return listOpenCodeModels(config);
    default:
      throw new SemanticGateError(`Provider does not support model listing: ${provider}`, "provider");
  }
}

async function listOpenAiCompatibleModels(
  config: SemanticGateConfig,
  defaults: { provider: string; baseUrl: string; apiKeyEnv: string; requireApiKey: boolean },
): Promise<ProviderModel[]> {
  const apiKey = readOptionalApiKey(defaults.provider, defaults.apiKeyEnv, config);
  if (defaults.requireApiKey && !apiKey) {
    throw new SemanticGateError(
      `Missing API key for ${defaults.provider}. Set ${defaults.apiKeyEnv}, or run: semantic-gate auth set ${defaults.provider} --key-stdin`,
      "provider",
    );
  }
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(`${defaults.baseUrl.replace(/\/$/, "")}/models`, {
    headers,
  });
  const json = await parseHttpJson(response);
  const data = jsonPath(json, ["data"]);
  if (!Array.isArray(data)) {
    throw new SemanticGateError("Provider model list response has no data array.", "provider", json);
  }
  return data
    .map((item) => modelFromObject(item, "id"))
    .filter((model): model is ProviderModel => Boolean(model));
}

async function listAnthropicModels(config: SemanticGateConfig): Promise<ProviderModel[]> {
  const apiKey = readApiKey("anthropic", config.apiKeyEnv ?? "ANTHROPIC_API_KEY", config);
  const response = await fetch(`${(config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/models`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  const json = await parseHttpJson(response);
  const data = jsonPath(json, ["data"]);
  if (!Array.isArray(data)) {
    throw new SemanticGateError("Anthropic model list response has no data array.", "provider", json);
  }
  return data
    .map((item) => modelFromObject(item, "id"))
    .filter((model): model is ProviderModel => Boolean(model));
}

async function listGeminiModels(config: SemanticGateConfig): Promise<ProviderModel[]> {
  const apiKey = readApiKey("gemini", config.apiKeyEnv ?? "GEMINI_API_KEY", config);
  const baseUrl = (config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/models?key=${encodeURIComponent(apiKey)}`);
  const json = await parseHttpJson(response);
  const models = jsonPath(json, ["models"]);
  if (!Array.isArray(models)) {
    throw new SemanticGateError("Gemini model list response has no models array.", "provider", json);
  }
  return models
    .map((item) => {
      const model = modelFromObject(item, "name");
      if (!model) {
        return undefined;
      }
      return {
        ...model,
        id: model.id.startsWith("models/") ? model.id.slice("models/".length) : model.id,
      };
    })
    .filter((model): model is ProviderModel => Boolean(model));
}

async function listOllamaModels(config: SemanticGateConfig): Promise<ProviderModel[]> {
  const host = (config.baseUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const response = await fetch(`${host}/api/tags`);
  const json = await parseHttpJson(response);
  const models = jsonPath(json, ["models"]);
  if (!Array.isArray(models)) {
    throw new SemanticGateError("Ollama model list response has no models array.", "provider", json);
  }
  return models
    .map((item) => modelFromObject(item, "name"))
    .filter((model): model is ProviderModel => Boolean(model));
}

async function listCodexCliModels(config: SemanticGateConfig): Promise<ProviderModel[]> {
  const command = config.modelListCommand ?? config.command ?? "codex";
  const args = config.modelListArgs ?? ["debug", "models"];
  const result = await runCommand(command, args, {
    cwd: process.cwd(),
    timeoutMs: config.timeoutMs,
  });
  if (result.code !== 0) {
    throw new SemanticGateError(`Codex CLI model listing exited with ${result.code}.`, "provider", result.stderr);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new SemanticGateError("Codex CLI model listing did not return JSON.", "provider", result.stdout.slice(0, 1000));
  }
  const models = jsonPath(parsed, ["models"]);
  if (!Array.isArray(models)) {
    throw new SemanticGateError("Codex CLI model list response has no models array.", "provider", parsed);
  }
  return models
    .map((item) => {
      const model = modelFromObject(item, "slug");
      if (!model) {
        return undefined;
      }
      if (!model.name && item && typeof item === "object" && !Array.isArray(item)) {
        const displayName = (item as Record<string, unknown>).display_name;
        if (typeof displayName === "string") {
          model.name = displayName;
        }
      }
      return model;
    })
    .filter((model): model is ProviderModel => Boolean(model));
}

async function listOpenCodeModels(config: SemanticGateConfig): Promise<ProviderModel[]> {
  const command = config.modelListCommand ?? config.command ?? "opencode";
  const args = config.modelListArgs ?? ["models"];
  const result = await runCommand(command, args, {
    cwd: process.cwd(),
    timeoutMs: config.timeoutMs,
  });
  if (result.code !== 0) {
    throw new SemanticGateError(`OpenCode model listing exited with ${result.code}.`, "provider", result.stderr);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean)
    .map((id) => ({ id }));
}

function modelFromObject(item: unknown, idKey: string): ProviderModel | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  const id = record[idKey];
  if (typeof id !== "string" || !id) {
    return undefined;
  }
  const model: ProviderModel = { id, raw: item };
  if (typeof record.display_name === "string") {
    model.name = record.display_name;
  } else if (typeof record.name === "string" && record.name !== id) {
    model.name = record.name;
  }
  return model;
}

function readApiKey(provider: string, envName: string, config: SemanticGateConfig): string {
  const value = readOptionalApiKey(provider, envName, config);
  if (!value) {
    throw new SemanticGateError(
      `Missing API key for ${provider}. Set ${envName}, or run: semantic-gate auth set ${provider} --key-stdin`,
      "provider",
    );
  }
  return value;
}

function readOptionalApiKey(provider: string, envName: string, config: SemanticGateConfig): string | undefined {
  const resolveOptions: { provider: string; envName?: string; keyProvider?: string } = {
    provider,
    envName,
  };
  if (config.apiKeyProvider !== undefined) {
    resolveOptions.keyProvider = config.apiKeyProvider;
  }
  return resolveApiKey(resolveOptions);
}

function requireModel(config: SemanticGateConfig): string {
  if (!config.model) {
    throw new SemanticGateError("Provider requires a configured model.", "provider");
  }
  return config.model;
}

async function parseHttpJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new SemanticGateError(`Provider returned non-JSON HTTP response (${response.status}).`, "provider", text);
  }
  if (!response.ok) {
    throw new SemanticGateError(`Provider HTTP error ${response.status}.`, "provider", json);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new SemanticGateError("Provider HTTP response JSON must be an object.", "provider", json);
  }
  return json as Record<string, unknown>;
}

function jsonPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
