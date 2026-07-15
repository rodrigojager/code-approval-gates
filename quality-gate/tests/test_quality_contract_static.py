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
            "FROM ghcr.io/oxsecurity/megalinter-dotnetweb:v9.6.0@sha256:",
            '"semgrep==${SEMGREP_INSTALL_VERSION}"',
            '"checkov==${CHECKOV_INSTALL_VERSION}"',
            "gitleaks/gitleaks",
            "gitleaks_${version}_linux_${release_arch}.tar.gz",
            "aquasecurity/trivy",
            "google/osv-scanner",
            "osv-scanner_linux_${release_arch}",
            'npm install -g "jscpd@${JSCPD_INSTALL_VERSION}"',
            "sha256sum -c -",
            "USER quality",
            "HEALTHCHECK",
            "ENTRYPOINT [\"/opt/quality-sidecar/entrypoint.sh\"]",
            "CMD [\"check\", \"/workspace\"]",
        ]

        for fragment in required_fragments:
            self.assertIn(fragment, dockerfile)

        self.assertNotIn("INSTALL_VERSION=latest", dockerfile)

    def test_dockerfile_installs_bash_before_using_bash_shell(self) -> None:
        dockerfile = read("Dockerfile")
        bash_package_index = dockerfile.index("bash")
        shell_index = dockerfile.index("SHELL [\"/bin/bash\"")

        self.assertLess(bash_package_index, shell_index)

    def test_entrypoint_accepts_quality_check_alias_and_check_command(self) -> None:
        entrypoint = read("docker/entrypoint.sh")

        self.assertIn("quality-sidecar", entrypoint)
        self.assertIn("quality-check", entrypoint)
        self.assertIn("exec python3 -m quality_sidecar", entrypoint)

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

        self.assertIn('"**/*.md,**/.quality/**', tools)

    def test_megalinter_uses_the_bundled_eslint_policy(self) -> None:
        tools = read("sidecar/quality_sidecar/tools.py")
        eslint_policy = read("sidecar/config/eslint.config.mjs")

        self.assertIn('"JAVASCRIPT_ES"', tools)
        self.assertIn('"JAVASCRIPT_ES_CONFIG_FILE": "eslint.config.mjs"', tools)
        self.assertIn("js.configs.recommended", eslint_policy)

    def test_gitlab_template_runs_the_published_sidecar_without_nested_docker(self) -> None:
        template = (ROOT.parent / "examples" / "ci" / "gitlab-quality-gate.yml").read_text(encoding="utf-8")

        self.assertIn("ghcr.io/rodrigojager/code-approval-quality-gate:0.2.0", template)
        self.assertIn('entrypoint: [""]', template)
        self.assertIn('quality-sidecar "$@"', template)
        self.assertIn('docker:\n      user: "0"', template)
        self.assertIn('--mode full', template)
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
        self.assertIn("packages: write", workflow)
        self.assertIn("secrets.GITHUB_TOKEN", workflow)
        self.assertIn("provenance: mode=max", workflow)
        self.assertIn("sbom: true", workflow)
        self.assertIn("flavor: |\n            latest=false", workflow)
        self.assertIn("load: true", workflow)
        self.assertIn("Smoke test image runtime and report writes", workflow)
        self.assertIn("--user 0", workflow)
        self.assertIn("quality-report.json", workflow)
        self.assertIn("quality-report.md", workflow)
        self.assertIn('git merge-base --is-ancestor "$GITHUB_SHA"', workflow)
        self.assertIn('"examples/ci/gitlab-quality-gate.yml"', workflow)
        self.assertIn('"docs/plano-gitlab-quality-gate.md"', workflow)
        self.assertIn('"docs/proximos-passos-publicacao-segura.md"', workflow)
        self.assertNotIn(":latest", workflow)

        action_references = re.findall(r"uses:\s+[^@\s]+@([^\s#]+)", workflow)
        self.assertTrue(action_references)
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{40}", reference) for reference in action_references))

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
