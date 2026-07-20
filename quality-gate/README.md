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

GitLab CI uses the standalone image and its container-native entrypoint (after governed policy/image variables are configured centrally):

```bash
/usr/local/bin/quality-ci check
```

The lower-level wrapper is still available for advanced/debug use and compatibility. Prefer `code-approval-gates quality` for users, agents, and CI:

```powershell
quality-check . --scope changed --threshold 90 --format=json,md --output .quality/reports
quality-check . --scope full --threshold 90 --format=json,md --output .quality/reports/full
quality-check . --scope paths --path docs --threshold 90 --format=json,md --output .quality/reports/docs
```

Docker is the preferred runtime for full scans. Local wrappers may select UID 0 only inside their isolated analysis container so reports can be written to bind mounts; the published corporate image remains unprivileged. The default `full` mode fails explicitly when required tools are unavailable and never downgrades itself to an offline approval. Pass `--no-start-docker` to skip Docker startup, `--docker-start-timeout-ms <ms>` to tune the wait, and select `--mode quick` or `--mode offline` explicitly only for local/diagnostic use.

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

Those overrides are for local/general CLI use. The corporate `quality-ci` boundary deliberately does not expose budget-disable or ad-hoc allow flags and rejects policy values that weaken its selected standard/strict profile.

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

## Standalone GitLab container

The image contains a dedicated, fixed-contract `quality-ci` entrypoint for GitLab Docker executors. It never starts Docker itself:

```bash
/usr/local/bin/quality-ci check
```

The corporate launcher accepts no project-controlled scope/path/output/enablement/report flags. It derives repository root and head from the current Git checkout, rejects mismatching GitLab context, and resolves base only from `refs/remotes/origin/$CODE_APPROVAL_QUALITY_TARGET_BRANCH`. It ignores `CI_MERGE_REQUEST_DIFF_BASE_SHA` as authority and fails with operational exit `3` when the governed ref or merge-base is unavailable.

The GitLab template calls `/usr/local/bin/quality-ci` by absolute path so a file or `PATH` entry from the Merge Request cannot replace the image-installed launcher.

Tracked source must match the commit. Symlinks and gitlinks are rejected, untracked files are excluded and counted, and changed files plus support manifests are materialized directly from the commit with `git archive` into a temporary projection without `.git`. The launcher never deliberately invokes project tests/build scripts; analyzers can still evaluate MR-controlled configs/toolchains/MSBuild, so the initial rollout remains advisory.

The initial corporate boundary deliberately does not accept JUnit, coverage, dependency, or evidence paths from job/MR variables. Keep those signals in GitLab/Sonar until mappings are supplied by root-owned configuration or governed policy. Job/MR waivers are also rejected.

Corporate CI requires an explicit `schemaVersion: 1` policy plus its SHA-256. The regular file must be outside the analyzed checkout and must not traverse symlink components. `quality-ci` uses the fixed standard/90 contract and rejects disabled or weakened budgets:

```text
CODE_APPROVAL_QUALITY_POLICY_FILE=/etc/code-approval-gates/company-policy.json
CODE_APPROVAL_QUALITY_POLICY_SHA256=<sha256>
```

The release workflow builds `generic` and `dotnetweb` flavors. The initial published .NET artifact is named `0.2.1-dotnetweb`, but production GitLab jobs must pin its published digest:

```text
ghcr.io/rodrigojager/code-approval-quality-gate@sha256:<published-dotnetweb-digest>
```

Use `examples/ci/gitlab-quality-gate.yml`. The image runs as UID/GID `10001`; the job uses no root override, DinD, privileged runner, Docker socket, npm install, or Semantic Gate and uploads only normalized JSON, Markdown, and scope-manifest artifacts. `examples/ci/gitlab-quality-and-sonarqube.yml` is an overlay that must extend the company's hardened Sonar job.

The initial rollout is non-blocking. Ordinary repository YAML is not an enforcement boundary; use Pipeline Execution Policy/compliance CI before blocking. MegaLinter per-analyzer configs/suppressions and C#/MSBuild behavior still require an inventory and full image smoke. The complete PT-BR tutorial is `docs/plano-gitlab-quality-gate.md`; English is `docs/gitlab-quality-gate.en.md`; safe release steps are in `docs/proximos-passos-publicacao-segura.md`.
