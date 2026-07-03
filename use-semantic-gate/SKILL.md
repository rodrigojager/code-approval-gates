---
name: use-semantic-gate
description: Run the AI semantic gate through code-approval-gates in headless mode, choose changed/full/paths scope correctly, read semantic reports, and iterate fixes without weakening provider, model, objective, threshold, scope, or baseline rules.
---

# Use Semantic Gate

Use this skill when an agent must run the semantic AI review for a repository, interpret the report, and keep the same gate configuration across reruns.

## Default Agent Command

Agents should use the unified CLI in headless mode:

```powershell
code-approval-gates semantic --scope changed --json --no-interactive --output .quality/reports/latest
```

If the user asks for a full audit:

```powershell
code-approval-gates semantic --scope full --format json,md --no-interactive --output .quality/reports/full
```

If the user asks for specific directories:

```powershell
code-approval-gates semantic --scope paths --path docs --path apps/web --json --no-interactive --output .quality/reports/paths
```

If the objective is provided in the conversation, pass it through stdin:

```powershell
"<objective>" | code-approval-gates semantic --scope changed --objective-stdin --json --no-interactive
```

If the objective is short, passing it directly is also valid:

```powershell
code-approval-gates semantic --scope changed --objective "Review architecture, quality, and risks" --json --no-interactive
```

If an objective file exists:

```powershell
code-approval-gates semantic --scope changed --objective-file .quality/objective.md --json --no-interactive
```

## Scope Rules

- Use `--scope changed` by default for daily work and merge requests.
- Use `--scope full` for first audit, baseline, release, or when the user explicitly asks for the whole project.
- Use `--scope paths` when the user names directories or files.
- Use `--path` only with `--scope paths`; for `changed` and `full`, filter with `--exclude`, `--include`, or ignore files.
- Never present a changed-scope score as a full-project score.
- Always report the scope, `scoreAppliesTo`, and report paths back to the user.
- Interpret `scoreAppliesTo=changed-files` as a diff/change score, not a whole-project score.

## Ignores

The gate supports gitignore-style files:

```text
.code-approval-gates.ignore
.semantic-gate.ignore
```

Use command-level excludes/includes when the user asks for a temporary filter:

```powershell
code-approval-gates semantic --scope full --exclude "generated/**" --include "generated/schema.json" --json --no-interactive
```

## Headless Rules

Agents must prefer:

```powershell
--json --no-interactive
```

In CI use:

```powershell
--ci --no-interactive
```

Do not open wizard/TUI from an agent unless the user explicitly asks for interactive mode.

Use `--non-blocking` only when the caller wants exit code `0` and will decide approval/failure by reading `summary.json` and `semantic-report.json`.

## Preflight

Check readiness:

```powershell
code-approval-gates doctor semantic --json --no-interactive
```

With explicit user authorization for safe setup fixes:

```powershell
code-approval-gates doctor semantic --fix --yes --no-interactive
```

If Codex CLI works normally but the gate reports provider network errors, check and repair local Windows firewall rules with explicit user authorization:

```powershell
code-approval-gates doctor semantic --fix-network --yes --no-interactive
```

On Windows, this tries to relaunch itself elevated through UAC when it is not already running as admin. It only applies to local Windows firewall access for the Codex/Node runtime; it cannot override a parent sandbox, VPN, corporate proxy, or external firewall.

If the unified command is missing but this repository is available, install from the repository root:

```powershell
npm install -g .
```

Provider/model can be set in config or passed explicitly:

```powershell
code-approval-gates semantic --provider codex-cli --model gpt-5.5 --reasoning-effort high --scope changed --json --no-interactive
```

Do not lower the threshold, switch to an easier provider, rewrite the objective, hide files, or remove relevant context to pass.

## Reports

Read these first:

```text
.quality/reports/latest/summary.json
.quality/reports/latest/summary.md
.quality/reports/latest/semantic-report.json
.quality/reports/latest/semantic-report.md
```

Approval requires:

- semantic status approved;
- score greater than or equal to threshold;
- no hard blockers;
- scope matches what the user requested;
- `scoreAppliesTo` matches the scope being summarized.

## Fix Loop

1. Run the same semantic command with the same objective, provider, model, threshold, scope, paths, ignores, and baseline.
2. Read `summary.json` and `semantic-report.json`.
3. Fix concrete blockers without weakening the gate.
4. Rerun the same command.
5. Repeat until approved or until the blocker is external.

When part of a full approval workflow, prefer:

```powershell
code-approval-gates run --scope changed --json --no-interactive --output .quality/reports/latest
```
