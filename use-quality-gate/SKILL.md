---
name: use-quality-gate
description: Run the deterministic quality-check quality gate before commit, PR, merge, release, or handoff; bootstrap the local wrapper when missing; interpret JSON and Markdown reports; and iteratively fix the repository until quality-check approves without lowering the threshold, relaxing the profile, adding waivers, or disabling checks.
---

# Use Quality Gate

Use this skill to make the deterministic `quality-check` gate pass for the current repository. This gate runs the Docker-based quality sidecar and deterministic tools. It does not use an LLM.

## Agent Operating Contract

When this skill is selected for a code-improvement task, the agent should keep working in a bounded fix loop until the latest full `quality-check` run approves, or until the remaining blocker is external and cannot be fixed in the repository.

The loop is:

1. Run the same full quality gate command.
2. Read the report and identify concrete blockers.
3. Modify the code, tests, configuration, or documentation to address the root cause.
4. Re-run the same gate command.
5. Repeat until approved.

Do not treat a single failed run as the end of the task. Do not pass by weakening the gate: keep the threshold, profile, enabled checks, target, output path, image, and mode stable unless the user explicitly changes them.

## Hard Rules

- Do not lower `threshold`.
- Do not switch to `--profile relaxed` to pass unless the user explicitly requested that profile before the run.
- Do not use `--allow-*`, `--allow-rule`, `--allow-path`, or `--waiver` to hide real findings unless the user explicitly approves that exact waiver.
- Do not use `--mode quick` or `--mode offline` to claim full approval. Those are partial development modes only.
- Do not disable PII or secret checks after the user or project enabled them.
- Do not disable default IaC scanning with `--disable-iac` or `--no-iac` unless the user or repository policy explicitly asks for it.
- Do not remove `--enable-coverage` or lower coverage thresholds after the user or project enabled coverage.
- Do not remove tests, validations, logs, error handling, authorization, or security checks just to pass.
- Preserve the same threshold, profile, enabled optional checks, target, output path, and image across reruns unless the user explicitly changes them.

## Preflight

Run from the repository root unless the user gives another target.

Check whether the wrapper is installed:

```powershell
Get-Command quality-check -ErrorAction SilentlyContinue
```

```bash
command -v quality-check
```

If `quality-check` is missing and the local quality-gate checkout exists, bootstrap the wrapper:

```powershell
Push-Location "C:\Users\Rodrigo\Desktop\harness gates\quality-gate"
npm install --workspaces=false
npm install -g .
Pop-Location
Get-Command quality-check -ErrorAction SilentlyContinue
```

On Linux or macOS, use the same commands from the local `quality-gate` checkout:

```bash
cd "/path/to/harness-gates/quality-gate"
npm install --workspaces=false
npm install -g .
command -v quality-check
```

If Docker is not installed, not running, or inaccessible, `quality-check` exits with operational failure. Start Docker or report the blocker. Do not use quick/offline mode as a substitute for full approval.

If the Docker image is missing or stale and Docker is available, initialize or refresh it with:

```bash
quality-check . --pull --format=json,md
```

## Run Command

Use the repository's required threshold when known. Otherwise use the default or user-specified threshold, commonly `90`:

```bash
quality-check . --threshold 90 --format=json,md --output .quality/reports
```

If the project already has a required profile or optional deterministic checks, keep them on every rerun:

```bash
quality-check . --threshold 90 --profile strict --format=json,md --output .quality/reports
quality-check . --threshold 90 --enable-secrets --format=json,md --output .quality/reports
quality-check . --threshold 90 --enable-pii --format=json,md --output .quality/reports
quality-check . --threshold 90 --enable-coverage --min-line-coverage 80 --format=json,md --output .quality/reports
```

PII and secret checks are optional. Enable them only when requested by the user, CI, repository policy, or prior gate command.

IaC scanning is enabled by default in full mode. Checkov runs only when deterministic detection finds IaC files such as Terraform, Kubernetes manifests, Helm charts, Docker/Compose files, CloudFormation/SAM templates, Serverless files, GitHub Actions, GitLab CI, or Azure Pipelines. If no IaC files are detected, the Checkov tool result is skipped and must not be treated as a blocker. Do not add `--disable-iac` or `--no-iac` unless the user explicitly requested it.

Coverage is opt-in. Use `--enable-coverage` only when requested by the user, CI, repository policy, or prior gate command. Expected report formats include:

- LCOV: `coverage/lcov.info` or `lcov.info`.
- Cobertura XML: `coverage.xml`, `coverage/coverage.xml`, `coverage.cobertura.xml`.
- JaCoCo XML: `target/site/jacoco/jacoco.xml` or `build/reports/jacoco/test/jacocoTestReport.xml`.
- Clover XML: `clover.xml` or `coverage/clover.xml`.
- Go coverprofile: `coverage.out`.

When coverage is enabled and no supported report exists, fix the project test/coverage command so it generates one of those reports. Do not bypass the coverage gate by disabling it.

For debugging only:

```bash
quality-check . --threshold 90 --format=json,md --debug-docker
```

Do not treat a debug command as approval unless it runs the full gate and returns approved.

## Read The Result

Reports are normally written to:

```text
.quality/reports/quality-report.json
.quality/reports/quality-report.md
.quality/reports/raw/
```

Interpret exit codes:

- `0`: approved.
- `1`: rejected by the quality gate.
- `2`: needs changes or human review because analysis was insufficient or a relevant tool failed.
- `3`: local or operational failure, such as Docker not found or inaccessible.

Read `quality-report.json` first when available, then `quality-report.md`, then terminal output. Extract:

- overall status.
- score and threshold.
- blocking findings.
- failed tools or incomplete analyses.
- file paths and line numbers.
- required fixes or categories.

Approval requires exit code `0`, report status approved, score at or above threshold, and no active blockers.

## Fix Loop

When the gate does not approve:

1. If exit code is `3`, fix the operational problem first: missing wrapper, Docker unavailable, image missing, mount problem, or permissions.
2. If reports exist, inspect `quality-report.json` and `quality-report.md`.
3. Fix deterministic blockers before warnings or suggestions.
4. Fix issues in this order: build/test/lint/type failures, security vulnerabilities, IaC findings, coverage findings when enabled, secrets/PII findings when enabled, dependency problems, duplication, maintainability, formatting.
5. Prefer root-cause fixes over suppressions.
6. Add or update tests when the finding reveals a functional regression or missing coverage.
7. Do not lower threshold, change to relaxed profile, add waivers, disable default IaC scanning, disable optional checks that were enabled, lower coverage thresholds, or switch to partial modes to pass.
8. Rerun the exact same quality-check command.
9. Repeat until approved or until the remaining blocker is external and cannot be solved in the repository.

If a finding is a false positive, document why and request explicit user approval before using `--allow-rule`, `--allow-path`, or a waiver file. Never add a waiver silently.

If Docker cannot be started in the current environment, say the gate is not complete and provide the exact command to rerun once Docker is available.

## Completion Criteria

Only report success when the latest full quality-check run returns exit code `0` and the report confirms approval:

```text
Status: approved
Score >= Threshold
No active blockers
```

When this skill is part of a full approval workflow, run it after the semantic-gate skill. Commit, PR, merge, release, or final handoff only after both semantic-gate and quality-check approve.
