from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def read_repo(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


class StaticQualityGateContractTests(unittest.TestCase):
    def test_dockerfile_contains_complete_sidecar_toolchain(self) -> None:
        dockerfile = read("Dockerfile")
        required_fragments = [
            "ARG MEGALINTER_IMAGE=ghcr.io/oxsecurity/megalinter:v9.5.0@sha256:00830d91da662d05221c1c0005f9010416030bd1da89afbcb55a9c52945ebd48",
            "ARG QUALITY_GATE_FLAVOR=generic",
            '"semgrep==${SEMGREP_INSTALL_VERSION}"',
            '"checkov==${CHECKOV_INSTALL_VERSION}"',
            "/opt/venvs/semgrep/bin/pip check",
            "/opt/venvs/checkov/bin/pip check",
            "/opt/venvs/quality-sidecar/bin/pip check",
            "gitleaks/gitleaks",
            "gitleaks_${version}_linux_${release_arch}.tar.gz",
            "ARG GITLEAKS_INSTALL_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
            "ARG TRIVY_INSTALL_SHA256=bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea",
            "ARG OSV_SCANNER_INSTALL_SHA256=15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0",
            "aquasecurity/trivy",
            "google/osv-scanner",
            "osv-scanner_linux_${release_arch}",
            'npm install -g "jscpd@${JSCPD_INSTALL_VERSION}"',
            "apk upgrade --no-cache",
            "chmod 0555 /usr/bin/hadolint",
            "cp -al /root/.dotnet/tools/. /opt/megalinter-dotnet-tools/",
            "cp -al /root/.composer/vendor/. /opt/megalinter-composer/vendor/",
            "cp -al /root/.rustup/toolchains/stable-x86_64-unknown-linux-musl/. /opt/megalinter-rust-toolchain/",
            "aa3808d2dbb71e8522c274ace56b86bddbd6e41e8c93e1626fe8c0693c5ab72a",
            "54ccd8bc063777753f3f55b8d61cd85c6fa972c140729ad939225ee60db94d20",
            "tee /dev/stderr",
            'ENV PATH="/usr/local/bin:/opt/megalinter-dotnet-tools:/opt/megalinter-composer/vendor/bin:/opt/megalinter-rust-toolchain/bin:${PATH}"',
            "append_trusted_path",
            "case \"${candidate}\" in /*)",
            "[0-7][0145][15]",
            "test ! -e /opt/megalinter-composer/auth.json",
            'test "$(command -v jscpd)" = "/usr/local/bin/jscpd"',
            "sha256sum -c -",
            'test "${TARGETARCH}" = "amd64"',
            "USER quality",
            "HEALTHCHECK",
            "ENTRYPOINT [\"/opt/quality-sidecar/entrypoint.sh\"]",
            "CMD [\"check\", \"/workspace\"]",
        ]

        for fragment in required_fragments:
            self.assertIn(fragment, dockerfile)

        self.assertNotIn("INSTALL_VERSION=latest", dockerfile)
        self.assertNotIn('arm64)', dockerfile)

    def test_dockerfile_installs_bash_before_using_bash_shell(self) -> None:
        dockerfile = read("Dockerfile")
        bash_package_index = dockerfile.index("bash")
        shell_index = dockerfile.index("SHELL [\"/bin/bash\"")

        self.assertLess(bash_package_index, shell_index)

    def test_entrypoint_accepts_quality_check_alias_and_check_command(self) -> None:
        entrypoint = read("docker/entrypoint.sh")

        self.assertTrue(entrypoint.startswith("#!/bin/sh"))
        self.assertIn("/etc/code-approval/quality-gate-path", entrypoint)
        self.assertIn("PATH=$QUALITY_ENTRYPOINT_PATH", entrypoint)
        self.assertNotIn("BASH_ENV", entrypoint)
        self.assertIn("quality-sidecar", entrypoint)
        self.assertIn("quality-check", entrypoint)
        self.assertIn("quality-ci", entrypoint)
        self.assertIn('exec /usr/local/bin/quality-ci "$@"', entrypoint)
        self.assertIn("exec /opt/venvs/quality-sidecar/bin/python -m quality_sidecar", entrypoint)

    def test_image_smokes_prove_jscpd_scans_sources_and_detects_duplicates(self) -> None:
        smoke = read("tests/image-smoke.sh")

        self.assertIn(".statistics.total.sources > 0", smoke)
        self.assertIn(".statistics.total.lines > 0", smoke)
        self.assertIn('.name == \\"jscpd\\"', smoke)
        self.assertIn('.status == \\"findings\\" and .summary.findings > 0', smoke)
        self.assertIn("quality-path-shadow", smoke)
        self.assertIn("pathlib.Path(resolved).is_absolute()", smoke)
        self.assertIn("cargo clippy", smoke)

    def test_gitlab_launcher_scrubs_environment_before_python(self) -> None:
        launcher = read("docker/quality-ci")

        self.assertTrue(launcher.startswith("#!/bin/sh"))
        self.assertIn('exec /usr/bin/env -i "$@"', launcher)
        self.assertIn('QUALITY_CI_PATH_FILE="/etc/code-approval/quality-gate-path"', launcher)
        self.assertIn('"PATH=$QUALITY_CI_PATH"', launcher)
        self.assertIn('"HOME=$QUALITY_CI_HOME"', launcher)
        for allowed in (
            "CI_COMMIT_SHA",
            "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
            "CODE_APPROVAL_QUALITY_TARGET_BRANCH",
            "CODE_APPROVAL_QUALITY_POLICY_FILE",
            "CODE_APPROVAL_QUALITY_POLICY_SHA256",
            "CODE_APPROVAL_QUALITY_LOCALE",
        ):
            self.assertIn(allowed, launcher)

        for forbidden in (
            "CI_JOB_TOKEN",
            "GIT_ASKPASS",
            "PYTHONPATH",
            "PYTHONHOME",
            "LD_PRELOAD",
            "BASH_ENV",
        ):
            self.assertNotIn(forbidden, launcher)

        copied_environment = launcher.split("done < /proc/self/environ", maxsplit=1)[0].rsplit(
            "while IFS= read -r -d '' entry; do", maxsplit=1
        )[1]
        for forbidden_input in (
            "CI_PROJECT_DIR",
            "CI_MERGE_REQUEST_DIFF_BASE_SHA",
            "CODE_APPROVAL_QUALITY_*",
            "CODE_APPROVAL_QUALITY_BASE",
            "CODE_APPROVAL_QUALITY_HEAD",
            "CODE_APPROVAL_QUALITY_SCOPE",
            "CODE_APPROVAL_QUALITY_PATHS",
            "CODE_APPROVAL_QUALITY_WAIVERS",
            "CODE_APPROVAL_QUALITY_PROFILE",
            "CODE_APPROVAL_QUALITY_THRESHOLD",
            "CODE_APPROVAL_MAX_EVIDENCE_AGE_SECONDS",
            "HTTP_PROXY",
            "SSL_CERT_FILE",
        ):
            self.assertNotIn(forbidden_input, copied_environment)

        self.assertIn('QUALITY_CI_TRANSPORT_FILE="/etc/code-approval/quality-gate-transport.env"', launcher)
        self.assertIn('trusted transport file must be owned by root:root', launcher)
        self.assertIn('trusted transport file mode must be 0444', launcher)
        self.assertIn('must not contain proxy credentials', launcher)
        self.assertIn("HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY", launcher)
        self.assertIn("SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE", launcher)
        self.assertNotIn("GIT_SSL_NO_VERIFY", launcher)

    def test_image_bakes_immutable_flavor_path_and_config(self) -> None:
        dockerfile = read("Dockerfile")
        tools = read("sidecar/quality_sidecar/tools.py")

        self.assertIn("COPY docker/quality-ci /usr/local/bin/quality-ci", dockerfile)
        self.assertIn("/etc/code-approval/quality-gate-flavor", dockerfile)
        self.assertIn("/etc/code-approval/quality-gate-path", dockerfile)
        self.assertIn("/etc/code-approval/quality-gate-transport.env", dockerfile)
        self.assertIn("chmod 0444 /etc/code-approval/quality-gate-flavor", dockerfile)
        self.assertIn("chmod 0444 /etc/code-approval/quality-gate-path", dockerfile)
        self.assertIn("chmod 0444 /etc/code-approval/quality-gate-transport.env", dockerfile)
        self.assertNotIn("QUALITY_SIDECAR_CONFIG_DIR=", dockerfile)
        self.assertNotIn("QUALITY_GATE_FLAVOR=${QUALITY_GATE_FLAVOR}", dockerfile)
        self.assertNotIn("ln -sf /opt/venvs/quality-sidecar/bin/quality-ci", dockerfile)

        self.assertIn('Path("/opt/quality-sidecar/sidecar/config")', tools)
        self.assertIn('Path("/etc/code-approval/quality-gate-flavor")', tools)
        self.assertNotIn('os.environ.get(\n        "QUALITY_SIDECAR_CONFIG_DIR"', tools)

    def test_node_wrapper_is_thin_and_docker_first(self) -> None:
        wrapper = read("bin/quality-check.js")
        forbidden_tool_impls = ["semgrep", "gitleaks", "trivy", "osv-scanner", "megalinter", "jscpd", "checkov"]

        self.assertIn("docker", wrapper)
        self.assertIn("check", wrapper)
        self.assertIn("/workspace", wrapper)
        for tool in forbidden_tool_impls:
            self.assertNotIn(tool, wrapper.lower())

    def test_powershell_wrapper_is_thin_and_docker_first(self) -> None:
        wrapper = read("quality-check.ps1")

        self.assertIn("& docker @RunArgs", wrapper)
        self.assertIn('"check"', wrapper)
        self.assertIn('"/workspace"', wrapper)
        self.assertIn(".quality/reports", wrapper)
        self.assertIn('$RunArgs.Add("--user")', wrapper)
        self.assertIn('$RunArgs.Add("0")', wrapper)
        self.assertIn('$RunArgs.Add("QUALITY_CHECK_SCOPE=full")', wrapper)

    def test_npm_package_includes_bundled_sidecar_build_context(self) -> None:
        package = json.loads(read("package.json"))

        self.assertEqual(package["bin"]["quality-check"], "bin/quality-check.js")
        for required in ["Dockerfile", "docker/", "sidecar/", "pyproject.toml", "bin/", "quality-check.ps1", "tests/"]:
            self.assertIn(required, package["files"])

    def test_documentation_keeps_container_first_contract(self) -> None:
        readme = read("README.md")

        self.assertIn("code-approval-gates quality --scope changed", readme)
        self.assertIn("code-approval-gates quality --scope full", readme)
        self.assertIn("code-approval-gates quality --scope paths", readme)
        self.assertIn("quality-check . --scope changed", readme)
        self.assertIn("Prefer `code-approval-gates quality`", readme)
        self.assertIn("headless `--json --no-interactive` mode for agents", readme)
        self.assertIn("gitignore-style `!path` re-inclusion", readme)
        self.assertIn("baseline support", readme)

    def test_duplication_scan_targets_source_code_not_markdown_examples(self) -> None:
        tools = read("sidecar/quality_sidecar/tools.py")
        jscpd_policy = read("sidecar/config/jscpd-ci.json")

        self.assertIn('"**/*.md,**/.quality/**', tools)
        self.assertIn("**/obj/**", tools)
        self.assertIn("**/bin/**", tools)
        self.assertIn('"**/obj/**"', jscpd_policy)
        self.assertIn('"**/bin/**"', jscpd_policy)

    def test_megalinter_uses_the_bundled_eslint_policy(self) -> None:
        tools = read("sidecar/quality_sidecar/tools.py")
        eslint_policy = read("sidecar/config/eslint.config.mjs")
        trusted_megalinter_config = read("sidecar/config/megalinter-ci.yml")

        self.assertIn('"JAVASCRIPT_ES"', tools)
        self.assertIn('"JAVASCRIPT_ES_CONFIG_FILE": "eslint.config.mjs"', tools)
        self.assertIn('"MEGALINTER_CONFIG": MEGALINTER_TRUSTED_CONFIG', tools)
        self.assertIn("js.configs.recommended", eslint_policy)
        self.assertIn('createRequire("/node-deps/package.json")', eslint_policy)
        self.assertIn('"TERRAFORM_TFLINT_RULES_PATH"', tools)
        self.assertIn('"TERRAFORM_TFLINT_CONFIG_FILE"', tools)
        self.assertIn('"TERRAFORM_TERRASCAN"', tools)
        self.assertIn('"terrascan",', tools)
        self.assertIn('"--iac-dir",', tools)
        self.assertNotIn('"TERRAFORM_TERRASCAN_CLI_LINT_MODE"', tools)
        self.assertIn("tflint-ci.hcl", tools)
        self.assertIn("{}", trusted_megalinter_config)

    def test_gitlab_template_runs_the_published_sidecar_without_nested_docker(self) -> None:
        template = (ROOT.parent / "examples" / "ci" / "gitlab-quality-gate.yml").read_text(encoding="utf-8")

        self.assertIn('name: "$CODE_APPROVAL_QUALITY_IMAGE"', template)
        self.assertIn("*@sha256:*", template)
        self.assertIn('entrypoint: [""]', template)
        self.assertIn('/usr/local/bin/quality-ci check', template)
        self.assertIn('before_script: []', template)
        self.assertNotIn('docker:', template)
        self.assertNotIn('user: "0"', template)
        self.assertIn('allow_failure: false', template)
        self.assertIn('allow_failure: true', template)
        self.assertIn('.quality/reports/quality-report.json', template)
        self.assertIn('.quality/reports/quality-report.md', template)
        self.assertNotIn('.quality/reports/raw', template)
        self.assertNotIn("docker:dind", template)
        self.assertNotIn("DOCKER_HOST", template)
        self.assertNotIn("npm install", template)

    def test_github_workflow_publishes_versioned_quality_image_to_ghcr(self) -> None:
        workflow = (ROOT.parent / ".github" / "workflows" / "quality-gate-image.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn("ghcr.io/rodrigojager/code-approval-quality-gate", workflow)
        self.assertIn('context: ./quality-gate', workflow)
        self.assertIn('tags:', workflow)
        self.assertIn('"quality-v*"', workflow)
        self.assertIn("^quality-v(0|[1-9][0-9]*)", workflow)
        self.assertIn("packages: write", workflow)
        self.assertIn("secrets.GITHUB_TOKEN", workflow)
        self.assertIn("release-candidate:", workflow)
        self.assertIn("provenance: mode=max", workflow)
        self.assertIn("sbom: true", workflow)
        self.assertIn("load: true", workflow)
        self.assertIn("QUALITY_GATE_FLAVOR=${{ matrix.flavor }}", workflow)
        self.assertIn("validated-dotnetweb-digest", workflow)
        self.assertIn("docker buildx imagetools create", workflow)
        self.assertIn('[[ "$actual_digest" == "$validated_digest" ]]', workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("Load the exact candidate by immutable digest", workflow)
        self.assertIn("Refusing to overwrite an existing release tag", workflow)
        self.assertIn("docker logout ghcr.io", workflow)
        self.assertIn('case "$status" in', workflow)
        self.assertIn("404)", workflow)
        self.assertIn("GHCR manifest lookup", workflow)
        self.assertIn(".SchemaVersion == 2", workflow)
        self.assertIn('any(.Results[]; .Class == "os-pkgs")', workflow)
        self.assertEqual(workflow.count("docker/build-push-action@"), 2)
        validate_section = workflow.split("\n  validate:\n", 1)[1].split("\n  release-candidate:\n", 1)[0]
        self.assertNotIn("packages: write", validate_section)
        self.assertNotIn("secrets.GITHUB_TOKEN", validate_section)
        publish_section = workflow.split("\n  publish:\n", 1)[1]
        self.assertNotIn("docker/build-push-action@", publish_section)
        self.assertIn("linux/amd64", workflow)
        self.assertNotIn("linux/arm64", workflow)
        self.assertIn("image-smoke.sh", workflow)
        self.assertIn("full-finding", workflow)
        self.assertIn("full-clean", workflow)
        self.assertIn("tool-error", workflow)
        self.assertIn("aquasecurity/trivy-action@", workflow)
        self.assertIn("Enforce no fixed critical OS vulnerabilities", workflow)
        self.assertIn("Block releases on any fixed critical vulnerability", workflow)
        self.assertIn("trivy-critical-${{ matrix.flavor }}", workflow)
        self.assertIn('release_version="${RELEASE_TAG#quality-v}"', workflow)
        self.assertIn("require('./package.json').version", workflow)
        self.assertIn("require('./quality-gate/package.json').version", workflow)
        self.assertIn("quality-gate/pyproject.toml", workflow)
        self.assertIn("quality-gate/sidecar/quality_sidecar/__init__.py", workflow)
        self.assertIn('if [[ "$GITHUB_SHA" != "$main_sha" ]]', workflow)
        self.assertNotIn('git merge-base --is-ancestor "$GITHUB_SHA"', workflow)
        self.assertIn('"examples/ci/gitlab-quality-gate.yml"', workflow)
        self.assertIn('"docs/plano-gitlab-quality-gate.md"', workflow)
        self.assertIn('"docs/proximos-passos-publicacao-segura.md"', workflow)
        self.assertNotIn(":latest", workflow)
        self.assertNotIn("--user 0", workflow)

        action_references = re.findall(r"uses:\s+[^@\s]+@([^\s#]+)", workflow)
        self.assertTrue(action_references)
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{40}", reference) for reference in action_references))

    def test_repository_secret_scan_ignores_checkout_controlled_suppressions(self) -> None:
        workflow = (ROOT.parent / ".github" / "workflows" / "repository-ci.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn("useDefault = true", workflow)
        self.assertIn("551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb", workflow)
        self.assertIn("$RUNNER_TEMP/code-approval-gitleaks", workflow)
        self.assertIn("--config \"$TRUSTED_GITLEAKS_CONFIG\"", workflow)
        self.assertIn("--gitleaks-ignore-path \"$TRUSTED_GITLEAKS_IGNORE\"", workflow)
        self.assertIn("--ignore-gitleaks-allow", workflow)
        self.assertIn("--redact=100", workflow)
        self.assertIn('git . --log-opts="--all"', workflow)
        self.assertIn("dir .", workflow)
        self.assertNotIn(".gitleaks.toml", workflow)
        self.assertNotIn(".gitleaksignore", workflow)

    def test_complementary_skill_does_not_duplicate_deterministic_checks_or_privacy_scans(self) -> None:
        quality_skill = read("skill/quality-gate.md")
        semantic_skill = read_repo("use-semantic-gate/SKILL.md")
        semantic_rubric = read_repo("semantic-gate/templates/semantic-review-skill.md")

        self.assertIn("Complementary Semantic Quality Review", semantic_rubric)
        self.assertIn("code-approval-gates semantic --scope changed", semantic_skill)
        self.assertIn("--objective \"Review architecture, quality, and risks\"", semantic_skill)
        self.assertIn("code-approval-gates run --scope changed", semantic_skill)
        self.assertIn("--json --no-interactive", semantic_skill)
        self.assertIn("--ci --no-interactive", semantic_skill)
        self.assertIn("--non-blocking", semantic_skill)
        self.assertIn("code-approval-gates doctor semantic --json --no-interactive", semantic_skill)
        self.assertIn(".code-approval-gates.ignore", semantic_skill)
        self.assertIn(".quality-gate.ignore", quality_skill)
        self.assertIn(".semantic-gate.ignore", semantic_skill)
        self.assertIn("The deterministic Quality Gate owns", quality_skill)
        self.assertIn("The Semantic Gate owns reasoning", quality_skill)
        self.assertNotIn("code-approval-gates semantic --scope changed", quality_skill)
        self.assertNotIn("npm test", quality_skill + semantic_skill)
        self.assertNotIn("sanitized quality gate summary", semantic_rubric)


if __name__ == "__main__":
    unittest.main()
