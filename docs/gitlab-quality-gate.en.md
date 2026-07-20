# Tutorial: advisory GitLab Quality Gate alongside SonarQube

This is the canonical English guide for the first corporate pilot. It assumes a .NET web application, merge requests targeting `develop`, a GitLab Docker executor, and an existing hardened SonarQube job.

> Current status: implementation exists on `final`, but the image is not published and no production digest exists. Keep the pilot advisory until image, scanner, GitLab, and governance validation is complete.

## Pilot architecture

```text
GitHub Actions -> GHCR image by digest -> dedicated GitLab Runner
                                               |
.NET test job ---------------------------------+-> corporate Sonar job
                                               |
immutable Git commit projection ---------------+-> advisory Quality Gate
```

- No Docker-in-Docker, privileged runner, Docker socket, or Compose.
- The image runs as UID/GID `10001`, not root.
- The launcher rebuilds a fixed `PATH` from root-owned toolchain directories; it does not inherit job/MR `PATH` or command overrides, and scanners remain non-root.
- In the `generic` flavor, `TERRAFORM_TERRASCAN` is disabled inside MegaLinter. The runtime runs Terrascan v1.19.9 separately in project mode over a temporary projection of the selected Terraform files. Comment-only synthetic anchors make ancestor directories without their own configuration valid; any non-empty `scan_errors` fails closed. This preserves cross-file rules and nested layouts without ignoring legitimate directories named `bin` or `obj`.

> **Maintenance risk:** the [official Terrascan repository was archived on November 20, 2025](https://github.com/tenable/terrascan). Version 1.19.9 remains pinned in this first delivery to preserve coverage. Evaluate a maintained replacement in shadow mode and remove Terrascan only after proving parity for cross-file rules, evidence format, and fail-closed behavior.
- Semantic Gate is not installed or used by this pilot.
- `quality-ci` never deliberately invokes project build/test scripts. Analyzers may still invoke toolchains or evaluate MR-controlled config/MSBuild, which is why the pilot remains non-root and advisory.
- The initial boundary does not accept JUnit, coverage, evidence, or dependency paths from job/MR variables. GitLab and Sonar retain those signals until mappings are root-owned or policy-governed.
- The only corporate command is `/usr/local/bin/quality-ci check`; additional flags are rejected.

## 1. Actual trust boundary

An ordinary repository template can be edited by an MR, and job variables can override GitLab predefined variables. Blocking therefore requires a mandatory Pipeline Execution Policy, compliance pipeline, or equivalent central include that the MR author cannot remove.

Administer image, policy, policy digest, runner tag, target branch, timeout, and blocking mode at group/project/policy level. Protected variables are often unavailable to MR pipelines from unprotected branches, so test the company instance rather than copying values into MR YAML. A protected template plus higher-precedence variables is useful for an advisory pilot, but does not by itself make the job mandatory.

The runtime provides defense in depth, not central enforcement. MegaLinter remains a pilot limitation: `MEGALINTER_CONFIG` does not automatically neutralize per-analyzer config, inline suppressions, and ignore mechanisms. C# analyzers may evaluate MR-controlled MSBuild. Inventory and pin each active analyzer and detect unsafe suppressions before blocking merges.

## 2. Runner boundary

Confirm:

- dedicated `linux/amd64` Docker executor locked to authorized projects/groups;
- `privileged = false` and no `/var/run/docker.sock` mount;
- UID `10001` can write the checkout's `.quality/reports`;
- controlled egress to GHCR and required scanner data sources, including Terrascan and Terraform Registry;
- scanner/registry cache writable by UID `10001`, without sharing credentials with the checkout or MR-controlled code;
- centrally governed timeout (the example starts at `2h`);
- sufficient CPU and memory for the measured pilot.

```toml
[runners.docker]
  privileged = false
  pull_policy = "always"
  allowed_images = [
    "ghcr.io/rodrigojager/code-approval-quality-gate@sha256:*",
    "mcr.microsoft.com/dotnet/sdk:*"
  ]
  volumes = ["/cache"]
```

Do not use root, DinD, or a Docker socket as an ownership workaround.

## 3. Publish and pin the image

The first .NET flavor is located by:

```text
ghcr.io/rodrigojager/code-approval-quality-gate:0.2.0-dotnetweb
```

The base is temporarily pinned by digest to MegaLinter v9.5.0/Alpine 3.23. MegaLinter v9.6/Alpine 3.24 with musl 1.2.6 triggered `Failed to allocate signal stack for domain 0` in Semgrep on affected Intel CPUs, related to [ocaml/ocaml#14933](https://github.com/ocaml/ocaml/pull/14933), with the fix merged in [semgrep/ocaml#21](https://github.com/semgrep/ocaml/pull/21). Upgrade only after a Semgrep release contains the fix and both flavors pass build, quick smoke, and full-image smokes again in CI.

The workflow now implements promotion without a divergent rebuild, but this path has not been exercised by a real tag and no tag/release should be created at this stage:

1. on pushes and pull requests, the `validate` matrix builds and runs smokes read-only, without logging in or writing to GHCR;
2. on a future `quality-v*` tag, `release-candidate` builds and pushes an intermediate `validation-*` tag, captures the produced digest, pulls that exact digest, and repeats the smokes;
3. the same candidate runs the full Trivy scan, blocks every fixed `CRITICAL` vulnerability, and uploads the report as an audit artifact;
4. only after that validation, `publish` promotes the same digest to final tags with `docker buildx imagetools create`; the job does not rebuild the image.

Intermediate `validation-*` and `promotion-*` tags remain an operational risk. Keep the package private and define retention/cleanup before operating releases continuously; do not delete a reference required by an in-progress run.

The 2026-07-15 local full scan found zero fixed `CRITICAL` vulnerabilities in Alpine packages, but 13 occurrences in the `dotnetweb` flavor's embedded toolchains/libraries (and 18 in `generic`). They include inherited Node, Go, and .NET components. This does not invalidate the functional smokes or local pilot, but it **correctly blocks the first versioned tag/image**: remediate and repeat the full scan until it reaches zero; do not weaken `release-candidate` policy to bypass the result.

Run the final GitLab job by immutable digest:

```text
CODE_APPROVAL_QUALITY_IMAGE=ghcr.io/rodrigojager/code-approval-quality-gate@sha256:REAL_DIGEST
```

Do not use `latest`, `0.2.0`, or a mutable flavor tag in production. Keep the first package private while reviewing layers, labels, SBOM, and provenance. If private, use a read-only `read:packages` service account stored in the runner/vault, never in repository YAML, image layers, artifacts, or logs. Making a GHCR package public is irreversible.

## 4. Governed policy

The runtime requires an explicit `schemaVersion: 1` policy and matching SHA-256:

```text
CODE_APPROVAL_QUALITY_POLICY_FILE=/etc/code-approval-gates/company-policy.json
CODE_APPROVAL_QUALITY_POLICY_SHA256=<64 lowercase hexadecimal characters>
```

Prefer a read-only runner mount, then a group/project GitLab File variable whose temporary file stays outside the checkout. The policy must be a regular file outside the analyzed tree and no path component may be a symlink; do not download it as an artifact under `$CI_PROJECT_DIR`. The initial corporate contract fixes profile `standard`, threshold `90`, secrets enabled, and sidecar `full --fail-on-tool-error`. Policy budgets cannot be disabled or weakened above standard ceilings. Job/MR-supplied waivers are rejected; review exceptions into the governed policy.

Minimal policy, deliberately without test/evidence requirements:

```json
{
  "schemaVersion": 1,
  "budgets": {
    "maxFileBytes": 2097152,
    "maxFileLines": 5000,
    "maxChangedFiles": 100,
    "maxChangedLines": 20000,
    "maxDiffBytes": 10485760,
    "maxBinaryFiles": 20
  }
}
```

## 5. Trusted source selection

The launcher does not use `CI_PROJECT_DIR`, `CI_COMMIT_SHA`, or `CI_MERGE_REQUEST_DIFF_BASE_SHA` as source authority. It:

1. derives the repository root from the current directory with Git;
2. derives head from the checked-out `HEAD` and rejects mismatching GitLab context;
3. requires a centrally governed `CODE_APPROVAL_QUALITY_TARGET_BRANCH`;
4. resolves base only from `refs/remotes/origin/<target-branch>` and validates the MR target when present;
5. requires a valid merge base and fails operationally when the remote ref is unavailable;
6. validates tracked/index state;
7. rejects tracked/untracked symlinks, gitlinks/submodules, and symlinked `.quality`/output components;
8. materializes regular files directly from the commit tree with `git archive`;
9. excludes untracked files and records their count;
10. scans changed files plus support manifests in a temporary projection without `.git` or the original checkout.

The GitLab contract is fixed to `changed`. Internal/local resolution still supports `full` and `paths`, but the corporate launcher accepts no scope, path, output, enablement, or report-path flags. If the governed `origin/<target>` ref is not ready, keep the pilot non-blocking; introduce a full-scan alternative only through immutable central configuration.

The scope manifest records commit/range, `targetBranch`, `sourceMaterialization: git-archive`, selected/support files, diff/history, policy, and `excludedUntrackedCount`.

## 6. GitLab and Sonar integration

Include `examples/ci/gitlab-quality-gate.yml` centrally and administer:

| Variable | Authority |
| --- | --- |
| `CODE_APPROVAL_QUALITY_IMAGE` | immutable digest in group/project/policy |
| `CODE_APPROVAL_QUALITY_POLICY_FILE` | governed mount/File variable |
| `CODE_APPROVAL_QUALITY_POLICY_SHA256` | group/project/policy |
| `CODE_APPROVAL_QUALITY_RUNNER_TAG` | group/project/policy |
| `CODE_APPROVAL_QUALITY_TARGET_BRANCH` | group/project/policy |
| `CODE_APPROVAL_QUALITY_BLOCKING` | central policy; `false` in pilot |

The job uses full Git history, `before_script: []`, a `2h` timeout, the image's non-root user, and an absolute launcher path. It uploads only normalized JSON, Markdown, and scope-manifest reports.

`examples/ci/gitlab-quality-and-sonarqube.yml` is an overlay. Tests produce JUnit/coverage; Quality waits without downloading those artifacts; Sonar extends the placeholder `.company_sonarqube_dotnet`. Replace it with the company's hardened central job, which owns scanner installation, token handling, coverage mappings, and MR/protected-branch rules. Do not expose `SONAR_TOKEN` to a generic build job executing MR code. The combined file is not standalone until the corporate hidden job is included.

Run CI Lint on the real company instance.

## 7. Root-owned proxy/CA transport

Job/MR proxy and CA variables are ignored. If required, mount:

```text
/etc/code-approval/quality-gate-transport.env
```

It must be exactly `root:root` mode `0444` so UID `10001` can read it. It accepts comments and `NAME=value` for HTTP/HTTPS/ALL/NO proxy variables (upper/lowercase) plus `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, and `GIT_SSL_CAINFO`.

The transport must contain no secret. Proxy URLs with userinfo or `@` are rejected because MR analyzers could read/exfiltrate credentials. Public CA files must be root-owned under `/etc/code-approval/ca`, `/etc/ssl`, or `/usr/local/share/ca-certificates`; never mount a private key.

Executables are pinned — including Terrascan v1.19.9 — but the `semgrep --config=p/default` ruleset, Trivy databases, OSV data, and Terraform Registry metadata remain mutable network inputs. Reports record the pinned Terrascan bundle separately from `registry.terraform.io`, which is unpinned/network-required. Allow only required destinations and plan a persistent cache writable by UID `10001` to reduce variability and outages; do not place registry tokens in that cache. Do not claim fully reproducible or offline analysis.

## 8. Pilot and rollback

| Exit | Machine status | Meaning |
| ---: | --- | --- |
| 0 | `APPROVED` | policy satisfied |
| 1 | `REJECTED` | finding/policy rejected the change |
| 2 | `NEEDS_CHANGES` | mandatory tool missing/inconclusive |
| 3 | operational error | Git/config/policy/runtime invalid |

IDs, JSON keys, statuses, and exits remain language-independent. `CODE_APPROVAL_QUALITY_LOCALE=en` or `pt-BR` changes supported human text only.

Start with `CODE_APPROVAL_QUALITY_BLOCKING=false` and run three representative MRs. Record digest, duration, CPU/memory, network behavior, findings, false positives, analyzer configs/suppressions, Sonar behavior, and uploaded artifacts.

Enable central blocking only after real full-image smoke, analyzer/MSBuild hardening, CI Lint plus mandatory enforcement, accepted advisory MRs, and resource calibration. Keep the previous digest. Roll back by changing the central image variable to that digest and validating an MR; never move release tags.

## Acceptance checklist

- [ ] Dedicated `linux/amd64`, UID `10001`, unprivileged runner without socket.
- [ ] `dotnetweb` image published, inspected, and pinned by digest.
- [ ] MegaLinter v9.5.0/Alpine 3.23 base confirmed by digest; any upgrade reran the complete matrix.
- [x] The workflow promotes the exact validated digest without a publication-job rebuild.
- [ ] The full scan reached zero fixed `CRITICAL` toolchain/library findings (local state: 13 in `dotnetweb`).
- [ ] A real tag demonstrated candidate validation, the Trivy report artifact, and promotion of the same digest.
- [ ] Retention/cleanup is defined for private `validation-*` and `promotion-*` tags.
- [ ] External `schemaVersion: 1` policy and digest governed outside MR YAML.
- [ ] Target branch governed and `refs/remotes/origin/<target>` available.
- [ ] Mandatory execution policy/compliance path ready before blocking.
- [ ] Optional transport root-owned `0444`, CA-only, no proxy credential.
- [ ] CI Lint passes with the real corporate Sonar include.
- [ ] Full image smoke and required scanners validated.
- [ ] The `generic` flavor confirmed 20 MegaLinter analyzers + 8 tools; dedicated Terrascan v1.19.9 runs in project mode over a Terraform-only projection.
- [ ] Egress and caching for Terrascan/Terraform Registry were tested without exposing credentials to the MR.
- [ ] A maintained replacement for archived Terrascan is being evaluated in shadow mode, with no switch before proven parity.
- [ ] Analyzer configs, suppressions, and C#/MSBuild behavior inventoried.
- [ ] Three advisory MRs completed and resources calibrated.
- [ ] Previous digest recorded for rollback.
- [ ] JUnit/coverage remain in GitLab/Sonar until mappings are governed.
- [ ] Blocking enabled only after explicit pilot acceptance.
