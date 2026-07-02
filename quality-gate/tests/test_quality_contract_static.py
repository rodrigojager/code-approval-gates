from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


class StaticQualityGateContractTests(unittest.TestCase):
    def test_dockerfile_contains_complete_sidecar_toolchain(self) -> None:
        dockerfile = read("Dockerfile")
        required_fragments = [
            "FROM ${MEGALINTER_IMAGE}",
            "ghcr.io/oxsecurity/megalinter:v9",
            "pip install --break-system-packages --no-cache-dir semgrep checkov",
            "gitleaks/gitleaks",
            "gitleaks_${version}_linux_${release_arch}.tar.gz",
            "aquasecurity/trivy",
            "google/osv-scanner",
            "osv-scanner_linux_${release_arch}",
            "npm install -g jscpd",
            "ENTRYPOINT [\"/opt/quality-sidecar/entrypoint.sh\"]",
            "CMD [\"check\", \"/workspace\"]",
        ]

        for fragment in required_fragments:
            self.assertIn(fragment, dockerfile)

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

    def test_complementary_skill_does_not_duplicate_deterministic_checks_or_privacy_scans(self) -> None:
        skill = read("skill/quality-gate.md")

        self.assertIn("Complementary Semantic Quality Review", skill)
        self.assertIn("code-approval-gates semantic --scope changed", skill)
        self.assertIn("--objective \"Review architecture, quality, and risks\"", skill)
        self.assertIn("code-approval-gates run --scope changed", skill)
        self.assertIn("--json --no-interactive", skill)
        self.assertIn("--ci --no-interactive", skill)
        self.assertIn("--non-blocking", skill)
        self.assertIn("code-approval-gates doctor --json --no-interactive", skill)
        self.assertIn(".code-approval-gates.ignore", skill)
        self.assertIn(".quality-gate.ignore", skill)
        self.assertIn(".semantic-gate.ignore", skill)
        self.assertIn("The deterministic Quality Gate owns", skill)
        self.assertIn("The semantic gate owns reasoning", skill)
        self.assertNotIn("npm test", skill)
        self.assertNotIn("sanitized quality gate summary", skill)


if __name__ == "__main__":
    unittest.main()
