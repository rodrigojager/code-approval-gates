#!/usr/bin/env node
import process from "node:process";
import { parseCli, parseScalar } from "./args.js";
import {
  configTargetScope,
  findProjectConfig,
  globalConfigPath,
  initProjectConfig,
  loadEffectiveConfig,
  readJsonIfExists,
  unsetConfigValue,
  writeConfigValue,
} from "./config.js";
import {
  listStoredApiKeys,
  setStoredApiKey,
  unsetStoredApiKey,
} from "./credentials.js";
import { exitCodeForError, SemanticGateError } from "./errors.js";
import { readObjective } from "./objective.js";
import { listProviderModels } from "./providers.js";
import { renderMarkdown } from "./report.js";
import { runSemanticGate } from "./run.js";
import { readStdin } from "./stdin.js";
import { buildStatusSummary, renderStatus } from "./status.js";
import { runSetupWizard } from "./tui.js";

async function main(): Promise<number> {
  const parsed = parseCli(process.argv.slice(2));
  const cwd = String(parsed.options.cwd ?? process.cwd());

  switch (parsed.command) {
    case "help":
      process.stdout.write(helpText());
      return 0;
    case "version":
      process.stdout.write("0.1.0\n");
      return 0;
    case "init": {
      const filePath = initProjectConfig(cwd);
      process.stdout.write(`Created ${filePath}\n`);
      return 0;
    }
    case "config":
      return handleConfig(parsed, cwd);
    case "auth":
      return handleAuth(parsed);
    case "models":
      return handleModels(parsed, cwd);
    case "setup": {
      const config = loadEffectiveConfig(cwd, parsed.options);
      await runSetupWizard(cwd, parsed.options, config);
      return 0;
    }
    case "status": {
      const config = loadEffectiveConfig(cwd, parsed.options);
      const summary = buildStatusSummary(cwd, config);
      if (parsed.options.json) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else {
        process.stdout.write(renderStatus(summary));
      }
      return 0;
    }
    case "run": {
      const config = loadEffectiveConfig(cwd, parsed.options);
      const objective = await readObjective(parsed.options);
      const { result, reports } = await runSemanticGate({ cwd, config, objective });
      if (config.output === "json") {
        process.stdout.write(`${JSON.stringify({ ...result, reports }, null, 2)}\n`);
      } else {
        process.stdout.write(renderMarkdown(result));
        if (reports) {
          process.stdout.write(`\nReports: ${reports.jsonPath}\n`);
        }
      }
      return result.status === "APPROVED" ? 0 : 1;
    }
    default:
      throw new SemanticGateError("Unhandled command.", "usage");
  }
}

async function handleAuth(parsed: ReturnType<typeof parseCli>): Promise<number> {
  const [provider] = parsed.positional;
  switch (parsed.subcommand) {
    case "set": {
      if (!provider) {
        throw new SemanticGateError("Usage: semantic-gate auth set <provider> --key-stdin", "usage");
      }
      if (!parsed.options.keyStdin) {
        throw new SemanticGateError("Use --key-stdin so the key is not exposed in shell history.", "usage");
      }
      const apiKey = (await readStdin()).trim();
      if (!apiKey) {
        throw new SemanticGateError("No API key received on stdin.", "usage");
      }
      const filePath = setStoredApiKey(provider, apiKey);
      process.stdout.write(`Stored API key for ${provider} in ${filePath}\n`);
      return 0;
    }
    case "list": {
      const list = listStoredApiKeys();
      process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      return 0;
    }
    case "unset": {
      if (!provider) {
        throw new SemanticGateError("Usage: semantic-gate auth unset <provider>", "usage");
      }
      const filePath = unsetStoredApiKey(provider);
      process.stdout.write(`Removed stored API key for ${provider} from ${filePath}\n`);
      return 0;
    }
    default:
      throw new SemanticGateError("Unknown auth subcommand. Use set, list, or unset.", "usage");
  }
}

async function handleModels(parsed: ReturnType<typeof parseCli>, cwd: string): Promise<number> {
  switch (parsed.subcommand) {
    case "list": {
      const provider = parsed.positional[0] ?? String(parsed.options.provider ?? "");
      const config = loadEffectiveConfig(cwd, {
        ...parsed.options,
        ...(provider ? { provider } : {}),
      });
      const models = await listProviderModels(config);
      if (parsed.options.json) {
        process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
      } else {
        process.stdout.write(models.map((model) => model.id).join("\n") + "\n");
      }
      return 0;
    }
    case "set-default": {
      const provider = parsed.positional[0] ?? String(parsed.options.provider ?? "");
      const model = parsed.positional[1] ?? String(parsed.options.model ?? "");
      if (!provider || !model) {
        throw new SemanticGateError("Usage: semantic-gate models set-default <provider> <model> [--project|--global] [--no-verify]", "usage");
      }
      const shouldVerify = parsed.options.verify !== false;
      if (shouldVerify) {
        const config = loadEffectiveConfig(cwd, { ...parsed.options, provider });
        const models = await listProviderModels(config);
        if (!models.some((item) => item.id === model)) {
          throw new SemanticGateError(`Model not found for ${provider}: ${model}`, "provider");
        }
      }
      const scope = configTargetScope(parsed.options);
      const providerPath = writeConfigValue(cwd, scope, "provider", provider);
      writeConfigValue(cwd, scope, "model", model);
      process.stdout.write(`Updated ${providerPath}\nDefault provider/model: ${provider} / ${model}\n`);
      return 0;
    }
    case "current": {
      const config = loadEffectiveConfig(cwd, parsed.options);
      process.stdout.write(
        `${JSON.stringify({ provider: config.provider ?? null, model: config.model ?? null }, null, 2)}\n`,
      );
      return 0;
    }
    default:
      throw new SemanticGateError("Unknown models subcommand. Use list, set-default, or current.", "usage");
  }
}

async function handleConfig(parsed: ReturnType<typeof parseCli>, cwd: string): Promise<number> {
  const scope = configTargetScope(parsed.options);
  const [key, rawValue] = parsed.positional;
  switch (parsed.subcommand) {
    case "path": {
      const projectPath = findProjectConfig(cwd);
      process.stdout.write(
        JSON.stringify(
          {
            global: globalConfigPath(),
            project: projectPath ?? null,
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    case "get": {
      const effective = loadEffectiveConfig(cwd, {});
      if (key) {
        process.stdout.write(`${JSON.stringify((effective as unknown as Record<string, unknown>)[key], null, 2)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(effective, null, 2)}\n`);
      }
      return 0;
    }
    case "set": {
      if (!key || rawValue === undefined) {
        throw new SemanticGateError("Usage: semantic-gate config set <key> <value> [--project|--global]", "usage");
      }
      const filePath = writeConfigValue(cwd, scope, key, parseScalar(rawValue));
      process.stdout.write(`Updated ${filePath}\n`);
      return 0;
    }
    case "unset": {
      if (!key) {
        throw new SemanticGateError("Usage: semantic-gate config unset <key> [--project|--global]", "usage");
      }
      const filePath = unsetConfigValue(cwd, scope, key);
      process.stdout.write(`Updated ${filePath}\n`);
      return 0;
    }
    default:
      throw new SemanticGateError("Unknown config subcommand. Use get, set, unset, or path.", "usage");
  }
}

function helpText(): string {
  return `semantic-gate

Usage:
  semantic-gate setup
  semantic-gate status
  semantic-gate init
  semantic-gate config set provider openrouter
  semantic-gate config set model anthropic/claude-sonnet-4
  semantic-gate run --objective-file objective.md
  semantic-gate run --objective-stdin --json --ci

Commands:
  run       Review recent git changes with the configured provider.
  setup     Interactive TUI for provider, model, API key, and options.
  status    Show the effective provider, model, threshold, context, and credential status.
  init      Create .semantic-gate.json in the current project.
  config    Manage persistent config. Subcommands: get, set, unset, path.
  auth      Manage user-local API keys. Subcommands: set, list, unset.
  models    List provider models or set the default model.

Important run flags:
  --objective-file <path>       Read the objective from a UTF-8 file.
  --objective-stdin             Read the objective from stdin.
  --json                        Force JSON output.
  --ci                          CI/headless mode; implies JSON output.
  --provider <name>             openrouter, openai, anthropic/claude, openai-compatible, opencode-api, ollama, gemini/gemini-api, command, codex-cli, claude-code, gemini-cli, opencode.
  --model <name>                Provider model name.
  --reasoning-effort <level>    Reasoning effort for CLI providers that support it, such as codex-cli.
  --base <ref> --head <ref>     Compare a CI/MR range, e.g. origin/main...HEAD.

Examples:
  semantic-gate setup
  semantic-gate auth set openrouter --key-stdin
  semantic-gate models list openrouter
  semantic-gate models list opencode
  semantic-gate models list opencode-api --base-url https://your-provider.example/v1
  semantic-gate models set-default openrouter anthropic/claude-sonnet-4
`;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(formatError(error));
    process.exitCode = exitCodeForError(error);
  });

function formatError(error: unknown): string {
  if (error instanceof SemanticGateError) {
    return `semantic-gate ${error.kind} error: ${error.message}${formatErrorDetails(error.details)}`;
  }
  if (error instanceof Error) {
    return `semantic-gate error: ${error.message}\n`;
  }
  return `semantic-gate error: ${String(error)}\n`;
}

function formatErrorDetails(details: unknown): string {
  if (details === undefined || details === null || details === "") {
    return "\n";
  }
  const text = typeof details === "string" ? details : JSON.stringify(details, null, 2);
  const trimmed = text.trim();
  if (!trimmed) {
    return "\n";
  }
  const maxChars = 4000;
  const body =
    trimmed.length > maxChars
      ? `${trimmed.slice(0, 1800)}\n...<truncated ${trimmed.length - maxChars} chars>...\n${trimmed.slice(-2200)}`
      : trimmed;
  return `\n${body}\n`;
}
