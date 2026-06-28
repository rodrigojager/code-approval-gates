# Code Approval Quality Gate

This repository implements the `quality-gate.txt` contract:

- `quality-check` is a thin local wrapper.
- `quality-check .` runs Docker by default.
- The complete analysis happens inside `code-approval-gates/quality-sidecar`.
- Local native fallback is not used silently.
- The npm package includes the sidecar Docker build context, so local and Git installs can build the default image without a separate registry push.

## Prerequisites

Use this gate by itself when you want deterministic quality enforcement without an AI provider.

Required:

- Node.js `>=18`.
- Docker Desktop or Docker Engine installed, running, and accessible from the current shell or CI runner.
- Network access on first image build or pull, unless `code-approval-gates/quality-sidecar:latest` or your custom image already exists locally.

Not required:

- Codex CLI.
- OpenAI, OpenRouter, Anthropic, Gemini, or other model-provider credentials.
- A semantic objective file.

Full approval requires the Docker-backed default `full` mode. `--mode quick` and `--mode offline` are explicit partial development modes; do not use them as final PR, merge, or release approval.

## Components

### `quality-check`

The wrapper validates Docker, resolves the target folder, creates `.quality/reports`, mounts the project in `/workspace`, and runs:

```powershell
docker run --rm `
  -v "${PWD}:/workspace" `
  -v "${PWD}/.quality/reports:/workspace/.quality/reports" `
  -w /workspace `
  code-approval-gates/quality-sidecar:latest `
  check /workspace
```

If `code-approval-gates/quality-sidecar:latest` is not available locally, the wrapper builds the bundled image automatically from this package before running the check. This keeps local-folder and Git-based installs self-contained.

Available local wrapper flags:

- `--image <image>`: defaults to `code-approval-gates/quality-sidecar:latest`.
- `--pull`: runs `docker pull` before analysis.
- `--no-pull`: disables a requested pull.
- `--build`: forces auto-build behavior when the image is missing.
- `--no-build`: disables auto-build; useful when a prebuilt image must already exist.
- `--docker-arg <arg>`: appends one extra argument to `docker run`; repeat as needed.
- `--debug-docker`: prints the final Docker command.

All remaining flags are passed to the container command `check /workspace`.

### `quality-sidecar`

The sidecar runs:

- MegaLinter
- Semgrep
- Checkov IaC scanning by default when IaC files are detected
- Gitleaks when `--enable-secrets` is set
- Trivy vulnerability and misconfiguration scanning
- OSV-Scanner
- jscpd
- built-in stack detection
- deterministic IaC file detection
- optional built-in secret and PII checks
- optional project tests when a supported stack is detected
- optional coverage gate for existing coverage reports
- report normalization
- waivers and allow rules
- score calculation
- `quality-report.json`
- `quality-report.md`

## Usage

Install both gates from the Code Approval Gates repository root:

```powershell
git clone https://github.com/rodrigojager/code-approval-gates.git
cd code-approval-gates
npm install -g .
```

Install from this local `quality-gate` folder during development:

```powershell
npm install --workspaces=false
npm install -g .
```

The repository root install exposes `quality-check` globally. Direct standalone npm package publication is optional and is not required for GitHub-based use.

```bash
quality-check .
```

PowerShell from a project folder:

```powershell
quality-check .
```

Installed npm binary:

```powershell
quality-check .
quality-check . --threshold 90
quality-check . --profile strict
quality-check . --enable-secrets --allow-secrets --allow-path "samples/**"
quality-check . --enable-coverage --min-line-coverage 80
quality-check . --disable-iac
quality-check . --format=json,md
quality-check . --output .quality/reports
quality-check . --image code-approval-gates/quality-sidecar:dev
quality-check . --pull --debug-docker
```

PowerShell users can use either `--format json,md` or `--format=json,md`; the wrapper normalizes both forms before invoking the Docker sidecar.

## Exit Codes

- `0`: approved.
- `1`: rejected by the quality gate.
- `2`: needs changes or human review because analysis was insufficient or a relevant tool failed.
- `3`: local or operational failure, such as Docker not found or inaccessible.

## Container Command

The Docker image exposes:

```bash
quality-sidecar check /workspace
```

Flags accepted by the sidecar:

- `--threshold <number>`
- `--profile relaxed|standard|strict`
- `--enable-pii`
- `--enable-secrets`
- `--disable-iac`
- `--no-iac`
- `--enable-coverage`
- `--coverage-report <path>`
- `--min-line-coverage <number>`
- `--min-branch-coverage <number>`
- `--allow-pii`
- `--allow-secrets`
- `--allow-rule <rule>`
- `--allow-path <glob>`
- `--waiver <file>`
- `--waiver-reason <text>`
- `--waiver-expires <yyyy-mm-dd>`
- `--format=json,md`
- `--output .quality/reports`
- `--fail-on-tool-error`
- `--mode full|quick|offline`

`full` is the default and requires the bundled tools to run. `quick` and `offline` are explicit partial modes for local development and tests; they skip external scanners and run only built-in checks plus explicitly requested coverage report parsing. They are not a silent fallback for `quality-check .`.

IaC scanning is enabled by default in full mode:

- Checkov runs only when deterministic file detection finds IaC files.
- Detected IaC includes Terraform, Kubernetes manifests, Helm charts, Docker/Compose files, CloudFormation/SAM templates, Serverless files, GitHub Actions, GitLab CI, and Azure Pipelines files.
- If no IaC files are detected, Checkov is recorded as skipped and does not block approval.
- Use `--disable-iac` or `--no-iac` only when the user or repository policy explicitly disables IaC scanning.

Coverage checks are opt-in:

- `--enable-coverage` reads existing coverage reports and applies coverage thresholds.
- `--min-line-coverage` defaults to `80` when coverage is enabled.
- `--min-branch-coverage` is optional; when set, branch coverage data must exist.
- `--coverage-report <path>` can be repeated to provide explicit report paths.
- Without explicit paths, the sidecar searches common locations such as `coverage/lcov.info`, `lcov.info`, `coverage.xml`, `coverage/coverage.xml`, `**/coverage.cobertura.xml`, `target/site/jacoco/jacoco.xml`, `build/reports/jacoco/test/jacocoTestReport.xml`, `coverage.out`, `clover.xml`, and `coverage/clover.xml`.
- Supported formats are LCOV, Cobertura XML, JaCoCo XML, Clover XML, and Go coverprofile.
- If coverage is enabled and no supported report is found, the gate returns `NEEDS_CHANGES`.
- If coverage is below the requested threshold, the active coverage finding blocks approval.

PII and secret checks are opt-in:

- `--enable-pii` enables built-in PII pattern checks.
- `--enable-secrets` enables built-in secret patterns, Gitleaks, and Trivy secret scanning.
- `--allow-pii` and `--allow-secrets` only waive findings after those checks have been enabled or produced by another enabled deterministic tool.

## Complementary Skill

The deterministic quality gate does not call an LLM. A separate complementary skill lives at `skill/quality-gate.md` for semantic review by an agent or human reviewer.

That skill is independent from the deterministic report: it reviews the current repository diff and recently modified files directly, then emits an additional semantic approval result. It intentionally avoids deterministic responsibilities such as scanners, build, lint, test execution, vulnerability checks, duplication checks, PII checks, secrets checks, and report generation.

## Build Image

```powershell
docker build -t code-approval-gates/quality-sidecar:latest .
npm run build:image
```

The Dockerfile uses `ghcr.io/oxsecurity/megalinter:v9` as the base image and adds the sidecar entrypoint plus the required external tools that are not guaranteed by the base image.

End-to-end Docker verification from this repository checkout:

```powershell
.\scripts\verify-docker.ps1
```

The script builds `code-approval-gates/quality-sidecar:local`, runs a smoke `check /workspace`, and verifies that `quality-report.json` is created.

Run the sidecar directly:

```powershell
docker run --rm `
  -v "${PWD}:/workspace" `
  -v "${PWD}/.quality/reports:/workspace/.quality/reports" `
  -w /workspace `
  code-approval-gates/quality-sidecar:latest `
  check /workspace --threshold 90
```

## Reports

Reports are written to `.quality/reports` by default:

- `quality-report.json`: machine-readable normalized report.
- `quality-report.md`: human-readable summary.
- `raw/`: raw tool stdout, stderr, and native JSON reports.

In CI/CD, publish `.quality/reports/` as an artifact with `when: always` so rejected runs still expose diagnostics.

## CI/CD

`quality-check` fails the job automatically through exit codes. A rejected gate returns non-zero and can block a pull request or merge request.

GitLab example with Docker-in-Docker:

```yaml
quality_gate:
  stage: test
  image: docker:28
  services:
    - name: docker:28-dind
      command: ["--tls=false"]
  variables:
    DOCKER_HOST: tcp://docker:2375
    DOCKER_TLS_CERTDIR: ""
  before_script:
    - apk add --no-cache nodejs npm
    - npm install -g quality-check
  script:
    - quality-check . --threshold 90 --format=json,md --output .quality/reports
  artifacts:
    when: always
    paths:
      - .quality/reports/
```

GitHub Actions example:

```yaml
quality_gate:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v5
    - uses: actions/setup-node@v4
      with:
        node-version: "22"
    - run: npm install -g quality-check
    - run: quality-check . --threshold 90 --format=json,md --output .quality/reports
    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: quality-gate
        path: .quality/reports/
```

## Waivers

Waivers can be supplied with `--waiver path/to/waivers.json`.

See [examples/waivers.example.json](examples/waivers.example.json).

## Development

Run tests:

```powershell
npm test
```

Run the full offline verification suite, without requiring Docker:

```powershell
.\scripts\verify-offline.ps1
```

This validates the wrappers, sidecar CLI, static Docker contract, package metadata, Python packaging, and a quick self-check report.

Run the sidecar without Docker in explicit partial mode:

```powershell
$env:PYTHONPATH = "sidecar"
python -m quality_sidecar check . --mode quick --format=json,md
```

The repository-level `examples/ci/github-actions-both-gates.yml` template shows how to wire this gate into GitHub Actions. Use `examples/ci/gitlab-quality-gate.yml` for a minimal GitLab job.
