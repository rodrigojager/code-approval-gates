---
name: use-semantic-gate
description: Run the AI semantic-gate before commit, PR, merge, or handoff; interpret its APPROVED, NEEDS_CHANGES, or REJECTED result; and iteratively fix the repository until semantic-gate approves without lowering the threshold, weakening config, switching to mock, or hiding findings.
---

# Use Semantic Gate

Use this skill to make the AI semantic review pass for the current repository changes. The gate is complementary to deterministic checks: it reviews intent, functional fit, edge cases, tests, maintainability, architecture, and reliability from the changed code and the objective.

## Agent Operating Contract

When this skill is selected for a code-improvement task, the agent should keep working in a bounded fix loop until the latest semantic gate run approves, or until the remaining blocker is external and cannot be fixed in the repository.

The loop is:

1. Run the same semantic gate command with the same objective, provider, model, threshold, and comparison range.
2. Read `semantic-result.json` or `semantic-result.md`.
3. Fix concrete blockers in the code, tests, configuration, or documentation without rewriting the objective to fit the implementation.
4. Re-run the same semantic gate command.
5. Repeat until approved.

Do not treat a single failed run as the end of the task. Do not pass by weakening the gate: keep threshold, provider, model, objective, context, and range stable unless the user explicitly changes them.

## Hard Rules

- Do not lower `threshold`.
- Do not switch provider to `mock` for a real approval.
- Do not edit the objective to make the implemented code look correct.
- Do not remove tests, validations, logs, error handling, authorization, or security checks just to pass.
- Do not hide changed files, shrink context limits, disable report writing, or bypass the gate to claim approval.
- Preserve the same provider, model, threshold, objective, and comparison range across reruns unless the user explicitly asks to change them.

## Preflight

Run from the repository root unless the user gives another target.

Check whether the CLI is installed:

```bash
semantic-gate status
```

If the command is missing and the local source checkout exists, bootstrap the CLI without changing gate behavior:

```powershell
Push-Location "C:\path\to\code-approval-gates\semantic-gate"
npm install --workspaces=false
npm run build --workspaces=false
npm install -g .
Pop-Location
semantic-gate status
```

On Linux or macOS, use the same commands from the local `semantic-gate` checkout:

```bash
cd "/path/to/code-approval-gates/semantic-gate"
npm install --workspaces=false
npm run build --workspaces=false
npm install -g .
semantic-gate status
```

If `semantic-gate status` shows no provider or no model, configure it before running:

```bash
semantic-gate setup
```

For headless automation, use existing project or global config, or set values explicitly:

```bash
semantic-gate config set provider <provider>
semantic-gate config set model <model>
semantic-gate config set threshold 90
```

Do not lower an existing threshold.

Supported hosted API credentials include:

- `openrouter`: `OPENROUTER_API_KEY`.
- `openai`: `OPENAI_API_KEY`.
- `anthropic`, `claude`, or `claude-api`: `ANTHROPIC_API_KEY`, with `CLAUDE_API_KEY` accepted as a fallback.
- `opencode-api`: `OPENCODE_API_KEY` plus a configured `baseUrl` for the OpenAI-compatible `/v1` endpoint.
- `openai-compatible`: `SEMANTIC_GATE_API_KEY` by default, or a custom `apiKeyEnv`.

The `opencode` provider is the local OpenCode CLI preset. Do not confuse it with `opencode-api`; the CLI preset relies on the CLI's own authentication.

For Codex CLI evaluation, the recommended explicit command is:

```bash
semantic-gate run --objective-file .quality/objective.md --provider codex-cli --model gpt-5.5 --reasoning-effort high --json
```

In CI/CD, provide `CODEX_API_KEY` only to the semantic gate invocation, or use `CODEX_ACCESS_TOKEN` only on trusted Business/Enterprise runners that specifically need ChatGPT workspace identity.

## Objective Input

Always provide the implementation objective. Prefer a file because objectives can be long and contain shell-sensitive characters:

```bash
semantic-gate run --objective-file .quality/objective.md
```

If the user provides the objective only in the conversation, create or update `.quality/objective.md` with the user's actual objective before running. Do not rewrite the objective to match the implementation. If the objective is ambiguous enough that approval would be meaningless, ask for clarification before running.

For stdin:

```bash
semantic-gate run --objective-stdin
```

For CI or a merge request range:

```bash
semantic-gate run --objective-file .quality/objective.md --base origin/main --head HEAD --ci --json
```

## Run And Read The Result

Normal local command:

```bash
semantic-gate run --objective-file .quality/objective.md
```

Useful status/config commands:

```bash
semantic-gate status
semantic-gate status --json
semantic-gate models current
semantic-gate config get
```

Reports are normally written to:

```text
.quality/semantic-gate/semantic-result.json
.quality/semantic-gate/semantic-result.md
.quality/semantic-gate/raw-provider-output.json
```

Interpret exit codes:

- `0`: semantic gate approved.
- `1`: semantic gate returned `REJECTED` or `NEEDS_CHANGES`.
- `2`: provider, credential, or model error.
- `3`: usage, objective, Git context, or context-size error.

Interpret the result fields:

- `status`: `APPROVED`, `NEEDS_CHANGES`, or `REJECTED`.
- `score`: numeric score.
- `threshold`: minimum required score.
- `hardBlockers`: approval blockers.
- `findings`: grouped issues with severity and category.
- `requiredFixPlan`: the smallest fix plan needed for approval.
- `contextWarnings`: missing or truncated context that may make the review incomplete.

Approval requires `status=APPROVED`, `score >= threshold`, and no hard blockers.

## Fix Loop

When status is not approved:

1. Read `semantic-result.json` first when available, then `semantic-result.md`, then terminal output.
2. Fix hard blockers before important findings.
3. Fix issues in this order: correctness, test gaps, security, architecture, maintainability, performance, suggestions.
4. Make minimal code changes that address the finding's root cause.
5. Add or update behavior tests when a functional bug, regression, or business-rule gap is identified.
6. Do not change threshold, provider, model, objective, or comparison range to make the gate pass.
7. Rerun the same semantic-gate command.
8. Repeat until approved or until the remaining blocker is external and cannot be solved in the repository.

If the provider or credentials fail, fix configuration or report the missing secret. Do not switch to `mock` or another easier provider unless the user explicitly asks.

If context is too large, prefer the configured chunked behavior or raise context limits only when the current model/provider can support it. Do not exclude relevant files to pass.

## Completion Criteria

Only report success when the latest semantic-gate run returns exit code `0` and the result says:

```text
Status: APPROVED
Score >= Threshold
Hard blockers: none
```

When this skill is part of a full approval workflow, run semantic-gate before deterministic `quality-check`, then use the quality-gate skill and require both gates to pass before commit, PR, merge, release, or final handoff.
