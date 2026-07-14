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

Docker is the preferred runtime for full scans. The local wrappers select UID 0 only inside the isolated analysis container so reports can be written to bind mounts regardless of host ownership; the published image remains unprivileged by default. When Docker is not installed, running, or accessible, `quality-check` tries to start Docker automatically and waits for the daemon to become ready. If Docker does not come up within the timeout, it runs the bundled Python sidecar locally in `offline` mode. Pass `--no-start-docker` to skip startup, `--docker-start-timeout-ms <ms>` to tune the wait, and `--mode quick`, `--mode offline`, or `--mode full` to choose the sidecar mode explicitly.

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

## Standalone GitLab container

The repository publishes the deterministic gate as a standalone, versioned image:

```text
ghcr.io/rodrigojager/code-approval-quality-gate:0.2.0
```

The GitHub workflow `.github/workflows/quality-gate-image.yml` validates image builds in Pull Requests with read-only repository permissions. It publishes to GHCR only for `quality-v*` tags, using the job-scoped `GITHUB_TOKEN`; no personal access token is required for publication.

Use `examples/ci/gitlab-quality-gate.yml` to run the image directly with the GitLab Docker executor. The job calls `quality-sidecar` inside the container and does not require Docker-in-Docker, a privileged runner, the Docker socket, npm installation, or the Semantic Gate.

The image defaults to the unprivileged `quality` user. The GitLab template explicitly selects UID 0 only inside the isolated job container so it can write reports to checkout mounts with different host ownership models. This requires a GitLab/Runner version that supports `image:docker:user`. It does not grant host-level root access: the supported runner contract keeps `privileged = false`, does not mount the Docker socket, and restricts the allowed image. The template uploads only the normalized JSON and Markdown reports; raw scanner evidence remains local to the job and Gitleaks redacts detected values.

The sidecar accepts the deterministic policy options used by the template:

- `--threshold <number>`;
- `--profile relaxed|standard|strict`;
- `--enable-secrets`;
- `--enable-pii`;
- `--enable-coverage`;
- `--coverage-report <path>`;
- `--min-line-coverage <number>`;
- `--min-branch-coverage <number>`;
- `--fail-on-tool-error`.

jscpd evaluates source-code duplication and excludes Markdown documentation. This avoids treating intentionally repeated bilingual command examples as production code clones while keeping duplication checks active for implementation files.

The initial GitLab rollout is non-blocking so the team can establish a baseline. Set `CODE_APPROVAL_QUALITY_BLOCKING` to `"true"` only after operational errors and legacy findings have been reviewed. See `docs/plano-gitlab-quality-gate.md` and `docs/proximos-passos-publicacao-segura.md` for the rollout and credential-handling procedures.
