---
name: use-quality-gate
description: Run the deterministic Quality Gate through code-approval-gates in headless mode, choose changed/full/paths scope correctly, read reports, and iterate fixes without weakening threshold, profile, checks, ignores, baseline, or scope.
---

# Use Quality Gate

Use this skill when an agent must run deterministic quality checks, interpret the normalized reports, and keep the same gate configuration across reruns.

## Default Agent Command

Agents should use the unified CLI in headless mode:

```powershell
code-approval-gates quality --scope changed --json --no-interactive --output .quality/reports/latest
```

If the user asks for a full scan:

```powershell
code-approval-gates quality --scope full --format json,md --no-interactive --output .quality/reports/full
```

If the user asks for specific directories:

```powershell
code-approval-gates quality --scope paths --path docs --path apps/web --json --no-interactive --output .quality/reports/paths
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
.quality-gate.ignore
```

CLI excludes and includes are also supported:

```powershell
code-approval-gates quality --scope full --exclude "generated/**" --include "generated/schema.json" --json --no-interactive
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

Use `--non-blocking` only when the caller wants exit code `0` and will decide approval/failure by reading `summary.json` and `quality-report.json`.

## Preflight

Check readiness:

```powershell
code-approval-gates doctor quality --json --no-interactive
```

With explicit user authorization for safe setup fixes:

```powershell
code-approval-gates doctor quality --fix --yes --no-interactive
```

If the unified command is missing but this repository is available, install from the repository root:

```powershell
npm install -g .
```

If Docker is unavailable, report the blocker. Do not use quick/offline mode as a substitute for full approval unless the user explicitly asks for a partial development check.

## Reports

Read these first:

```text
.quality/reports/latest/summary.json
.quality/reports/latest/summary.md
.quality/reports/latest/quality-report.json
.quality/reports/latest/quality-report.md
.quality/reports/latest/raw/
```

Approval requires:

- quality status approved;
- score greater than or equal to threshold;
- no active blockers;
- scope matches what the user requested;
- `scoreAppliesTo` matches the scope being summarized.

Also inspect `quality-report.json.metrics` for effective budgets, observed file/change sizes, diff bytes, binary count, and hotspot evidence. If the project configures `.quality-gate-policy.json`, dependency graphs, JUnit, or neutral evidence reports, rerun with the same files and thresholds; missing requested evidence is not approval.

## Fix Loop

1. Run the same quality command with the same threshold, profile, scope, paths, ignores, optional checks, and baseline.
2. Read `summary.json` and `quality-report.json`.
3. Fix concrete blockers without weakening the gate.
4. Rerun the same command.
5. Repeat until approved or until the blocker is external.

When part of a full approval workflow, prefer:

```powershell
code-approval-gates run --scope changed --json --no-interactive --output .quality/reports/latest
```
