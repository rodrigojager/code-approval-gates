# Semantic Gate

`semantic-gate` is an AI-powered semantic review CLI that runs before the deterministic `quality-check`.

It reviews recent Git changes directly from the repository, using an objective supplied by file or stdin. It does not consume the deterministic quality gate summary and it does not rerun build, lint, tests, scanners, PII checks, secret checks, or vulnerability tools.

Intended flow:

```text
coder changes code
semantic-gate run --objective-file objective.md
  -> fix until APPROVED
quality-check .
  -> if approved, create PR
```

## Prerequisites

Use this gate by itself when you want AI semantic review without deterministic Docker analysis.

Required:

- Node.js `>=18.17`.
- A Git repository, because the gate reads staged, unstaged, untracked, or CI range changes.
- An implementation objective, normally `.quality/objective.md`.
- One configured provider and model.
- Network access for hosted providers, unless using a local provider such as Ollama.

For `codex-cli`:

- Codex CLI must be installed and available as `codex`.
- The selected model must be available to that Codex CLI account or API key.
- Local interactive use can rely on `codex login`.
- CI/CD should use a masked secret such as `CODEX_API_KEY` for the single gate invocation. Use `CODEX_ACCESS_TOKEN` only on trusted Business/Enterprise runners that specifically need ChatGPT workspace identity.

Not required:

- Docker.
- `quality-check`.
- Deterministic scanner reports.

## Install

From this repository:

```powershell
npm install --workspaces=false
npm run build
npm install -g .
```

Or run without linking:

```powershell
node dist/cli.js run --objective-file objective.md
```

The CLI is designed for Windows, Linux, and macOS. It uses Node.js process spawning rather than shell-specific quoting.

After package publication, CI and users can install the package directly:

```bash
npm install -g semantic-gate
```

## Configure Once

Recommended interactive setup:

```powershell
semantic-gate setup
```

The setup TUI lets you choose:

- config scope: global user config or project config
- provider or local CLI
- API key source
- model, including provider model list when the provider exposes one
- threshold and context options
- report writing and untracked-file behavior

API keys entered in the TUI are stored only in the user-local secret store, never in `.semantic-gate.json`.

Global config is stored per user:

- Windows: `%APPDATA%\semantic-gate\config.json`
- Linux/macOS: `$XDG_CONFIG_HOME/semantic-gate/config.json` or `~/.config/semantic-gate/config.json`
- Override for tests/automation: `SEMANTIC_GATE_HOME`

Set your provider/model once:

```powershell
semantic-gate config set provider openrouter
semantic-gate config set model anthropic/claude-sonnet-4
semantic-gate config set threshold 90
```

Non-interactive API key setup:

```powershell
$env:OPENROUTER_API_KEY = "..."
```

or store it in the user-local secret store without exposing it in shell history:

```powershell
Get-Content .\openrouter-key.txt -Raw | semantic-gate auth set openrouter --key-stdin
semantic-gate auth list
```

Model discovery and default model selection:

```powershell
semantic-gate models list openrouter
semantic-gate models list opencode-api --base-url https://your-provider.example/v1
semantic-gate models list codex-cli
semantic-gate models list opencode
semantic-gate models set-default openrouter anthropic/claude-sonnet-4
semantic-gate models current
```

Show the effective configuration that will be used by the next run:

```powershell
semantic-gate status
semantic-gate status --json
```

`models list openrouter` uses OpenRouter's public `/models` endpoint and does not require an API key just to list models. `models list opencode-api` uses an OpenAI-compatible `/models` endpoint and `OPENCODE_API_KEY` by default. `models list codex-cli` uses the installed Codex CLI's `codex debug models` command, so it follows the current Codex catalog exposed by that local CLI. `models list opencode` uses the installed OpenCode CLI's `opencode models` command, including OpenCode, OpenCode Go, OpenRouter, and other providers exposed by that CLI. `models set-default` verifies the model against the provider list when the provider supports model listing. Use `--no-verify` for custom providers that do not expose model listing.

Project config is optional:

```powershell
semantic-gate init
semantic-gate config set threshold 92 --project
```

Precedence:

```text
run flags
> environment variables
> .semantic-gate.json in the project
> global user config
> internal defaults
```

API keys are never written by `config set`. Use environment variables:

```text
OPENROUTER_API_KEY
ANTHROPIC_API_KEY
CLAUDE_API_KEY
GEMINI_API_KEY
SEMANTIC_GATE_API_KEY
OPENCODE_API_KEY
```

Environment variables take precedence over stored user-local keys. This keeps CI and temporary overrides predictable.

## Run

Use a file for the objective. This avoids shell escaping issues with long prompts, Markdown, quotes, JSON, or special characters:

```powershell
semantic-gate run --objective-file .quality/objective.md
```

Or stdin:

```powershell
Get-Content .\objective.md -Raw | semantic-gate run --objective-stdin
```

JSON output for agents:

```powershell
semantic-gate run --objective-file .quality/objective.md --json
```

Exit codes:

```text
0 = APPROVED
1 = REJECTED or NEEDS_CHANGES
2 = provider, credential, or model error
3 = usage, objective, Git context, or context-size error
```

Reports are written to `.quality/semantic-gate/` by default:

- `semantic-result.json`
- `semantic-result.md`
- `raw-provider-output.json`

The JSON result contract is documented in `schemas/semantic-result.schema.json`.

## Git Context

`semantic-gate` reads the current repository state:

```bash
git status --short
git diff --stat
git diff --cached --stat
git diff
git diff --cached
git ls-files --others --exclude-standard
```

It includes staged, unstaged, and untracked files by default. In CI, pass a comparison range:

```bash
semantic-gate run \
  --objective-file .quality/objective.md \
  --base "origin/main" \
  --head "$CI_COMMIT_SHA" \
  --ci \
  --json
```

For GitLab Runner, use `GIT_DEPTH: 0` or fetch the target branch before running so the base ref exists.

## Providers

Supported provider names:

- `openrouter`
- `openai`
- `anthropic` / `claude` / `claude-api`
- `openai-compatible`
- `opencode-api`
- `ollama`
- `gemini`
- `gemini-api`
- `command`
- `codex-cli`
- `claude-code`
- `gemini-cli`
- `opencode`

API provider example:

```powershell
semantic-gate config set provider openrouter
semantic-gate config set model anthropic/claude-sonnet-4
$env:OPENROUTER_API_KEY = "..."
```

Claude API example:

```powershell
semantic-gate config set provider anthropic
semantic-gate config set model <claude-model>
$env:ANTHROPIC_API_KEY = "..."
```

`CLAUDE_API_KEY` is also accepted as a fallback for Anthropic/Claude API runs. Stored keys set with `semantic-gate auth set claude --key-stdin`, `semantic-gate auth set claude-api --key-stdin`, or `semantic-gate auth set anthropic --key-stdin` resolve to the same Anthropic credential.

OpenAI-compatible endpoint:

```powershell
semantic-gate config set provider openai-compatible
semantic-gate config set baseUrl https://api.example.com/v1
semantic-gate config set apiKeyEnv MY_PROVIDER_API_KEY
semantic-gate config set model my-model
```

OpenCode API endpoint:

```powershell
semantic-gate config set provider opencode-api
semantic-gate config set baseUrl https://your-provider.example/v1
semantic-gate config set model provider-model
$env:OPENCODE_API_KEY = "..."
```

Use `openai-compatible` with `apiKeyEnv` for any other compatible `/v1` endpoint. Use `opencode` when you want the local OpenCode CLI instead; that path relies on the CLI's own authentication and does not require an API key stored by semantic-gate.

Ollama local:

```powershell
semantic-gate config set provider ollama
semantic-gate config set model llama3.1
semantic-gate config set baseUrl http://127.0.0.1:11434
```

CLI providers are routed through the generic command adapter. Configure once for the exact CLI flags installed on your machine:

```powershell
semantic-gate config set provider command
semantic-gate config set command codex
semantic-gate config set commandArgs '["exec","-"]'
semantic-gate config set commandPromptMode stdin
```

Named CLI providers include default headless command presets for local Codex CLI, Claude Code, and Gemini CLI when those tools are installed:

```powershell
semantic-gate config set provider codex-cli
semantic-gate config set provider claude-code
semantic-gate config set provider gemini-cli
```

Codex CLI also supports model discovery:

```powershell
semantic-gate models list codex-cli
semantic-gate models set-default codex-cli gpt-5.5
```

Codex CLI reasoning effort can be configured without custom command arguments:

```powershell
semantic-gate run --objective-file .quality/objective.md --provider codex-cli --model gpt-5.5 --reasoning-effort high
semantic-gate config set provider codex-cli
semantic-gate config set model gpt-5.5
semantic-gate config set reasoningEffort high
```

Recommended one-shot command for Codex CLI evaluation:

```powershell
semantic-gate run --objective-file .quality/objective.md --provider codex-cli --model gpt-5.5 --reasoning-effort high --json
```

OpenCode CLI also supports model discovery:

```powershell
semantic-gate models list opencode
semantic-gate models set-default opencode opencode/gpt-5.5
semantic-gate models set-default opencode opencode-go/kimi-k2.7-code
```

You can override `command`, `commandArgs`, `commandPromptMode`, `modelListCommand`, and `modelListArgs` for any CLI provider.

## Context Size

Defaults:

```json
{
  "maxContextChars": 160000,
  "maxFileChars": 50000,
  "maxDiffChars": 60000,
  "contextStrategy": "auto"
}
```

When the context is larger than `maxContextChars`, `auto` uses chunked review and a final synthesis call. If a single file block is too large, the CLI fails clearly or reports an explicit truncation warning rather than hiding it silently.

## CI Example

GitLab:

```yaml
semantic_gate:
  stage: test
  image: node:22
  variables:
    GIT_DEPTH: "0"
    CODEX_NON_INTERACTIVE: "1"
  before_script:
    - npm install -g semantic-gate
    - curl -fsSL https://chatgpt.com/codex/install.sh | sh
    - export PATH="$HOME/.local/bin:$PATH"
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
  script:
    - CODEX_API_KEY="$CODEX_API_KEY" semantic-gate run --objective-file .quality/objective.md --provider codex-cli --model gpt-5.5 --reasoning-effort high --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" --head "$CI_COMMIT_SHA" --ci --json
  artifacts:
    when: always
    paths:
      - .quality/semantic-gate/
```

Store provider API keys in CI/CD protected or masked variables. Do not expose `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, or other provider secrets to earlier steps that execute untrusted repository code.

More templates are available in the root `examples/ci/` folder.

## Development

```powershell
npm install --workspaces=false
npm run build
npm test
npm run pack:dry-run
```
