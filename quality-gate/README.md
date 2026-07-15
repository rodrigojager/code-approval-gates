# quality-check

`quality-check` is the deterministic Quality Gate used by Code Approval Gates.

For new workflows, prefer the unified CLI:

```powershell
code-approval-gates quality --scope changed --json --no-interactive --output .quality/reports/latest
```

Full project scan:

```powershell
code-approval-gates quality --scope full --format json,md --output .quality/reports/full
```

Path-scoped scan:

```powershell
code-approval-gates quality --scope paths --path apps/web --path docs
```

GitLab CI:

```powershell
code-approval-gates quality --ci --scope changed --format json,md --output code-approval-report --no-interactive
```

The lower-level wrapper is still available for advanced/debug use and compatibility. Prefer `code-approval-gates quality` for users, agents, and CI:

```powershell
quality-check . --scope changed --threshold 90 --format=json,md --output .quality/reports
quality-check . --scope full --threshold 90 --format=json,md --output .quality/reports/full
quality-check . --scope paths --path docs --threshold 90 --format=json,md --output .quality/reports/docs
```

Docker is the preferred runtime for full scans. When Docker is not installed, running, or accessible, `quality-check` tries to start Docker automatically and waits for the daemon to become ready. If Docker does not come up within the timeout, it runs the bundled Python sidecar locally in `offline` mode. Pass `--no-start-docker` to skip startup, `--docker-start-timeout-ms <ms>` to tune the wait, and `--mode quick`, `--mode offline`, or `--mode full` to choose the sidecar mode explicitly.

`--path` requires `--scope paths`. For `changed` and `full`, use `--exclude`, `--include`, or ignore files to filter.

Reports include `scoreAppliesTo`:

- `changed-files` for `--scope changed`;
- `entire-project` for `--scope full`;
- `selected-paths` for `--scope paths`.

Do not describe a changed-file score as a full-project score.

The unified CLI adds:

- `changed`, `full`, and `paths` scopes;
- `.gitignore`, `.code-approval-gates.ignore`, and `.quality-gate.ignore`, including gitignore-style `!path` re-inclusion;
- headless `--json --no-interactive` mode for agents;
- `doctor` checks;
- consolidated reports under `.quality/reports/latest`;
- baseline support.

## Language-agnostic quality policy

The built-in budget gate runs in `quick`, `offline`, and `full` modes. It does not require a language runtime or external analyzer. It measures:

- file bytes and text lines;
- scoped bytes and lines when configured;
- changed files, additions, deletions, total changed lines, patch bytes, and changed binary files;
- historical Git hotspots for changed files;
- declarative companion-change rules such as "a contract change requires tests, clients, or migrations".

Default profile limits are conservative outlier limits:

| Metric | relaxed | standard | strict |
| --- | ---: | ---: | ---: |
| File bytes | 5 MiB | 2 MiB | 1 MiB |
| File lines | 10,000 | 5,000 | 2,000 |
| Changed files | 250 | 100 | 50 |
| Changed lines | 50,000 | 20,000 | 10,000 |
| Diff bytes | 25 MiB | 10 MiB | 5 MiB |
| Changed binary files | 50 | 20 | 10 |
| Hotspot trigger | 300 commits / 100k churn | 150 / 50k | 75 / 25k |

Every limit can be overridden from the CLI or `quality.budgets` in `.code-approval-gates.json`. A value of `0` disables only that limit:

```powershell
code-approval-gates quality --scope changed --profile strict --max-file-lines 1500 --max-changed-files 40
quality-check . --scope changed --max-diff-bytes 5242880 --max-binary-files 5
```

The JSON and Markdown reports include a `metrics` section with observed values and effective budgets. Budget and policy findings are blockers unless allowed by the existing `--allow-rule`, `--allow-path`, or waiver mechanisms.

## Policy file

Use `.quality-gate-policy.json` by convention or pass `--policy-file <path>`. See `examples/quality-gate-policy.example.json` for the complete shape.

```json
{
  "schemaVersion": 1,
  "budgets": {
    "maxFileLines": 3000,
    "maxChangedLines": 12000
  },
  "changeRequirements": [
    {
      "id": "contract-tests",
      "whenAny": ["contracts/**"],
      "requireAny": ["tests/**", "clients/**", "migrations/**"]
    }
  ]
}
```

Companion-change rules run only for `--scope changed`; a full scan has no change set to compare.

## Neutral evidence contracts

Cyclomatic complexity, mutation execution, and semantic dependency extraction require a language-aware producer. The gate remains language-independent by consuming normalized artifacts and applying one central policy.

Dependency graph JSON accepts string nodes or `{ "id", "layer" }` nodes and `[from, to]` or `{ "from", "to" }` edges. It deterministically checks cycles, fan-in, fan-out, and forbidden layer dependencies:

```powershell
code-approval-gates quality --dependency-graph .quality/evidence/dependency-graph.json
```

Generic quality evidence uses numeric `metrics` and pass/fail `checks`. Policy thresholds under `evidence.requiredMetrics` can enforce values emitted by any adapter, for example `mutation.score`, `complexity.cyclomatic.max`, model size, or a custom risk metric. Failed checks can represent API compatibility, schema migration, deployment dry-run, or another deterministic contract:

```powershell
code-approval-gates quality --evidence-report .quality/evidence/quality-evidence.json
```

JUnit XML is accepted directly for stack-independent test evidence. Failures and errors always block; minimum test count and skipped-test limits are configurable:

```powershell
code-approval-gates quality --test-report .quality/evidence/junit.xml --min-tests 10 --max-skipped-percent 5
```

Explicit artifact paths are projected into changed/path scopes even if their directories are ignored. Paths inside the analyzed project can be relative or absolute; relative paths are portable between local execution and Docker/GitLab.

If a requested evidence file is missing or invalid, the gate returns `NEEDS_CHANGES` with exit code `2`. A policy violation returns `REJECTED` with exit code `1`. Invalid policy syntax returns exit code `3`.
