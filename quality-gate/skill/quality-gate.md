---
name: deterministic-quality-gate
description: Deterministic quality review executed through code-approval-gates, with explicit changed/full/paths scope, headless JSON mode for agents, and separation from the AI Semantic Gate.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

# Deterministic Quality Gate

Use this skill when an agent needs deterministic quality evidence: lint, format, tests, dependency checks, vulnerability scans, duplication checks, optional secret/PII checks, and normalized quality scoring.

The preferred execution path is the unified CLI:

```powershell
code-approval-gates quality --scope changed --json --no-interactive --output .quality/reports/latest
```

For a full project audit:

```powershell
code-approval-gates quality --scope full --format json,md --no-interactive --output .quality/reports/full
```

For selected paths:

```powershell
code-approval-gates quality --scope paths --path docs --path apps/web --json --no-interactive --output .quality/reports/paths
```

For a complete approval workflow with both gates:

```powershell
code-approval-gates run --scope changed --json --no-interactive --output .quality/reports/latest
```

## Scope Contract

- `changed` is the default and checks recent Git changes.
- `full` checks the whole project after ignore rules.
- `paths` checks only explicit files or directories.
- Use `--path` only with `--scope paths`; for `changed` and `full`, filter with `--exclude`, `--include`, or ignore files.
- Never describe a changed-scope score as a full-project score.
- Always report the scope, `scoreAppliesTo`, and report paths.

## Headless Contract

Agents and CI must use headless mode:

```powershell
--json --no-interactive
```

CI should use:

```powershell
--ci --no-interactive
```

The tool must not open TUI, ask questions, or print decorative output in JSON mode.

Use `--non-blocking` only when the caller wants exit code `0` and will decide approval/failure by reading `summary.json` and the gate reports.

Do not open wizard/TUI from an agent unless the user explicitly asks for interactive mode.

## Ignores

The gate supports gitignore-style files:

```text
.gitignore
.code-approval-gates.ignore
.quality-gate.ignore
```

Use `--exclude`, `--include`, and `--ignore-file` for temporary filters that should not be committed.

## Readiness Check

Before a real run, use doctor when setup is uncertain:

```powershell
code-approval-gates doctor quality --json --no-interactive
```

For a broader readiness check:

```powershell
code-approval-gates doctor --json --no-interactive
```

Use `code-approval-gates doctor --fix` only when the user authorizes safe local setup changes.
For scripts, CI, or other headless callers, make that authorization explicit:

```powershell
code-approval-gates doctor quality --fix --yes --no-interactive
```

## Boundary with Semantic Gate

The deterministic Quality Gate owns:

- lint, format, type, build, and test command evidence;
- dependency and vulnerability scanners;
- duplication detection;
- IaC scanners;
- optional secret/PII checks;
- normalized deterministic scoring.

The Semantic Gate owns reasoning about:

- whether the code satisfies the objective;
- functional gaps;
- architecture and integration risk;
- behavior-level test gaps;
- contextual security risk;
- maintainability, performance, and reliability concerns.

Do not ask the quality gate to judge objective satisfaction. Use `code-approval-gates run` or `code-approval-gates semantic` when semantic reasoning is required.

## Reports

Read:

```text
.quality/reports/latest/summary.json
.quality/reports/latest/quality-report.json
.quality/reports/latest/quality-report.md
```

Approval requires:

- `status=APPROVED`;
- `score >= threshold`;
- no hard blockers;
- requested scope was actually analyzed;
- `scoreAppliesTo` matches the scope being reported.

## Fix Loop

1. Run the same quality command.
2. Read `summary.json` and `quality-report.json`.
3. Fix blockers first.
4. Do not lower thresholds, hide files, remove checks, delete tests, disable scanners, or add broad ignores to pass.
5. Rerun the same command until approved or blocked by an external issue.
