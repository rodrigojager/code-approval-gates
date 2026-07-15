from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sidecar"))

from quality_sidecar.detectors import detect_iac_files  # noqa: E402
from quality_sidecar.policy import evaluate_policy  # noqa: E402
from quality_sidecar.tools import (  # noqa: E402
    ToolResult,
    _parse_megalinter,
    _prepare_raw_dir,
    _run_gitleaks,
    _run_megalinter,
    _run_semgrep,
    _run_trivy,
    run_project_tests,
)


class QualitySidecarCliTests(unittest.TestCase):
    def run_sidecar(self, target: Path, *args: str) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "PYTHONPATH": str(ROOT / "sidecar")}
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "quality_sidecar",
                "check",
                str(target),
                "--mode",
                "quick",
                "--format",
                "json,md",
                *args,
            ],
            cwd=str(ROOT),
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

    @staticmethod
    def write_privacy_fixture(target: Path) -> None:
        secret = "abcdefghijkl" + "mnopqrstuvwxyz"
        cpf = "123.456" + ".789-09"
        (target / "sample.txt").write_text(
            f"password = '{secret}'\ncpf = '{cpf}'\n",
            encoding="utf-8",
        )

    @staticmethod
    def read_report(target: Path) -> dict[str, object]:
        report_path = target / ".quality" / "reports" / "quality-report.json"
        return json.loads(report_path.read_text(encoding="utf-8"))

    def test_quick_mode_ignores_secret_and_pii_unless_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            self.write_privacy_fixture(target)

            result = self.run_sidecar(target, "--threshold", "99")

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report_path = target / ".quality" / "reports" / "quality-report.json"
            markdown_path = target / ".quality" / "reports" / "quality-report.md"
            self.assertTrue(report_path.exists())
            self.assertTrue(markdown_path.exists())

            report = self.read_report(target)
            self.assertEqual(report["status"], "APPROVED")
            self.assertEqual(report["findings"], [])

    def test_quick_mode_rejects_secret_and_pii_when_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            self.write_privacy_fixture(target)

            result = self.run_sidecar(target, "--threshold", "99", "--enable-secrets", "--enable-pii")

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            report = self.read_report(target)
            self.assertEqual(report["status"], "REJECTED")
            categories = {finding["category"] for finding in report["findings"]}
            self.assertIn("secrets", categories)
            self.assertIn("pii", categories)

    def test_allow_flags_approve_when_all_findings_are_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            self.write_privacy_fixture(target)

            result = self.run_sidecar(
                target,
                "--threshold",
                "99",
                "--enable-secrets",
                "--enable-pii",
                "--allow-secrets",
                "--allow-pii",
                "--waiver-reason",
                "Synthetic fixture",
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = self.read_report(target)
            self.assertEqual(report["status"], "APPROVED")
            self.assertTrue(all(finding["status"] == "allowed" for finding in report["findings"]))

    def test_coverage_enabled_rejects_when_line_coverage_is_below_threshold(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            coverage_dir = target / "coverage"
            coverage_dir.mkdir()
            (coverage_dir / "lcov.info").write_text(
                "\n".join(
                    [
                        "TN:",
                        "SF:src/app.js",
                        "DA:1,1",
                        "DA:2,0",
                        "LF:2",
                        "LH:1",
                        "end_of_record",
                    ]
                ),
                encoding="utf-8",
            )

            result = self.run_sidecar(target, "--enable-coverage", "--min-line-coverage", "80")

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            report = self.read_report(target)
            self.assertEqual(report["status"], "REJECTED")
            coverage = next(tool for tool in report["tools"] if tool["name"] == "coverage")
            self.assertEqual(coverage["status"], "findings")
            self.assertEqual(coverage["summary"]["lineCoverage"], 50.0)
            self.assertTrue(any(finding["rule"] == "coverage.line-threshold" for finding in report["findings"]))

    def test_coverage_enabled_without_report_needs_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)

            result = self.run_sidecar(target, "--enable-coverage")

            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            report = self.read_report(target)
            self.assertEqual(report["status"], "NEEDS_CHANGES")
            coverage = next(tool for tool in report["tools"] if tool["name"] == "coverage")
            self.assertEqual(coverage["status"], "missing")
            self.assertIn("Coverage analysis was requested", report["summary"]["reasons"][0])

    def test_coverage_enabled_accepts_cobertura_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / "coverage.xml").write_text(
                '<coverage lines-covered="9" lines-valid="10" branches-covered="7" branches-valid="10"></coverage>',
                encoding="utf-8",
            )

            result = self.run_sidecar(
                target,
                "--enable-coverage",
                "--min-line-coverage",
                "80",
                "--min-branch-coverage",
                "60",
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = self.read_report(target)
            coverage = next(tool for tool in report["tools"] if tool["name"] == "coverage")
            self.assertEqual(coverage["summary"]["lineCoverage"], 90.0)
            self.assertEqual(coverage["summary"]["branchCoverage"], 70.0)


class QualityDetectorTests(unittest.TestCase):
    def test_detect_iac_files_finds_common_iac_without_matching_plain_yaml(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / "main.tf").write_text("resource \"aws_s3_bucket\" \"x\" {}\n", encoding="utf-8")
            (target / "deployment.yaml").write_text("apiVersion: apps/v1\nkind: Deployment\n", encoding="utf-8")
            (target / "notes.yaml").write_text("name: just-notes\n", encoding="utf-8")

            files = detect_iac_files(target)

            self.assertIn("main.tf", files)
            self.assertIn("deployment.yaml", files)
            self.assertNotIn("notes.yaml", files)


class QualityPolicyTests(unittest.TestCase):
    @staticmethod
    def create_megalinter_error_log(temp: str, content: str) -> tuple[Path, Path]:
        target = Path(temp)
        raw = target / "raw"
        logs = raw / "megalinter" / "linters_logs"
        logs.mkdir(parents=True)
        (logs / "YAML_YAMLLINT-ERROR.log").write_text(content, encoding="utf-8")
        return target, raw

    @staticmethod
    def create_incomplete_npm_workspace(temp: str) -> tuple[Path, Path]:
        target = Path(temp)
        raw = target / "raw"
        raw.mkdir()
        (target / "package.json").write_text(
            json.dumps({"workspaces": ["semantic-gate", "quality-gate"]}),
            encoding="utf-8",
        )
        present_workspace = target / "quality-gate"
        present_workspace.mkdir()
        (present_workspace / "package.json").write_text("{}\n", encoding="utf-8")
        return target, raw

    def test_non_default_output_cleanup_preserves_project_owned_raw_content(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            raw = Path(temp) / "custom-output" / "raw"
            raw.mkdir(parents=True)
            project_owned = raw / "project-owned.txt"
            project_owned.write_text("preservar\n", encoding="utf-8")

            _prepare_raw_dir(raw)

            self.assertTrue(raw.is_dir())
            self.assertEqual(project_owned.read_text(encoding="utf-8"), "preservar\n")

    def test_raw_evidence_cleanup_removes_only_known_gate_outputs_after_marking(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            raw = Path(temp) / "raw"
            _prepare_raw_dir(raw)
            (raw / "semgrep.json").write_text("{}\n", encoding="utf-8")
            (raw / "megalinter").mkdir()
            (raw / "megalinter" / "result.log").write_text("stale\n", encoding="utf-8")
            project_owned = raw / "project-owned.txt"
            project_owned.write_text("preservar\n", encoding="utf-8")

            _prepare_raw_dir(raw)

            self.assertFalse((raw / "semgrep.json").exists())
            self.assertFalse((raw / "megalinter").exists())
            self.assertEqual(project_owned.read_text(encoding="utf-8"), "preservar\n")

    def test_raw_evidence_cleanup_rejects_known_output_symlink_before_marking(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()
            outside = target / "outside.json"
            outside.write_text("preservar\n", encoding="utf-8")
            try:
                (raw / "semgrep.json").symlink_to(outside)
            except OSError as error:
                self.skipTest(f"Symbolic links are unavailable in this environment: {error}")

            with self.assertRaisesRegex(RuntimeError, "output symlink"):
                _prepare_raw_dir(raw)

            self.assertEqual(outside.read_text(encoding="utf-8"), "preservar\n")

    def test_megalinter_exit_one_becomes_structured_findings(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target, raw = self.create_megalinter_error_log(temp, "invalid YAML\n")

            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(
                    name="megalinter",
                    status="ok",
                    exit_code=1,
                    output_path=str(raw / "megalinter"),
                ),
            ) as run_command_mock:
                result = _run_megalinter(target, raw)

            findings = _parse_megalinter(result)
            environment = run_command_mock.call_args.kwargs["env"]
            self.assertEqual(result.status, "findings")
            self.assertEqual(result.summary["failedAnalyzers"], ["YAML_YAMLLINT"])
            self.assertEqual(len(findings), 1)
            self.assertEqual(findings[0].rule, "megalinter.yaml-yamllint")
            self.assertEqual(findings[0].category, "lint")
            self.assertEqual(findings[0].severity, "high")
            policy = evaluate_policy(
                findings,
                [result],
                profile="standard",
                threshold=90,
                mode="full",
                fail_on_tool_error=True,
            )
            self.assertEqual(policy.status, "REJECTED")
            self.assertEqual(policy.exit_code, 1)
            self.assertIn("CSHARP_DOTNET_FORMAT", environment["ENABLE_LINTERS"])
            self.assertNotIn("REPOSITORY_TRIVY", environment["ENABLE_LINTERS"])

    def test_megalinter_fatal_analyzer_error_is_operational_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target, raw = self.create_megalinter_error_log(
                temp,
                "Fatal error while calling yamllint: command not found\n",
            )

            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(
                    name="megalinter",
                    status="ok",
                    exit_code=1,
                    output_path=str(raw / "megalinter"),
                ),
            ):
                result = _run_megalinter(target, raw)

            self.assertEqual(result.status, "error")
            self.assertIn("YAML_YAMLLINT", result.summary["fatalAnalyzers"])

    def test_trivy_skips_gate_reports_and_dependency_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / ".quality" / "reports" / "raw"
            raw.mkdir(parents=True)

            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(name="trivy", status="ok", exit_code=0),
            ) as run_command_mock:
                _run_trivy(target, raw, enable_secrets=True)

            command = run_command_mock.call_args.args[1]
            self.assertIn("vuln,misconfig,secret", command)
            for directory in (".git", ".quality", "node_modules", "vendor"):
                expected = str(target / directory)
                index = command.index(expected)
                self.assertEqual(command[index - 1], "--skip-dirs")

    def test_gitleaks_redacts_secrets_in_raw_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()

            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(name="gitleaks", status="ok", exit_code=0),
            ) as run_command_mock:
                _run_gitleaks(target, raw)

            command = run_command_mock.call_args.args[1]
            self.assertIn("--redact=100", command)

    def test_semgrep_skips_gate_outputs_and_dependencies(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()

            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(name="semgrep", status="ok", exit_code=0),
            ) as run_command_mock:
                _run_semgrep(target, raw)

            command = run_command_mock.call_args.args[1]
            for directory in (".git", ".quality", "node_modules"):
                index = command.index(directory)
                self.assertEqual(command[index - 1], "--exclude")

    def test_project_tests_skip_when_scoped_checkout_omits_npm_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target, raw = self.create_incomplete_npm_workspace(temp)

            with (
                patch.dict(os.environ, {"QUALITY_CHECK_SCOPE": "changed"}),
                patch("quality_sidecar.tools.shutil.which", return_value="npm"),
                patch("quality_sidecar.tools.run_command") as run_command_mock,
            ):
                result, findings = run_project_tests(target, raw)

            self.assertIsNotNone(result)
            self.assertEqual(result.status, "skipped")
            self.assertEqual(result.summary["missingWorkspaces"], ["semantic-gate"])
            self.assertEqual(findings, [])
            run_command_mock.assert_not_called()

    def test_project_tests_error_when_full_checkout_omits_npm_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target, raw = self.create_incomplete_npm_workspace(temp)

            with (
                patch.dict(os.environ, {"QUALITY_CHECK_SCOPE": "full"}),
                patch("quality_sidecar.tools.shutil.which", return_value="npm"),
                patch("quality_sidecar.tools.run_command") as run_command_mock,
            ):
                result, findings = run_project_tests(target, raw)

            self.assertIsNotNone(result)
            self.assertEqual(result.status, "error")
            self.assertEqual(result.summary["missingWorkspaces"], ["semantic-gate"])
            self.assertEqual(findings, [])
            run_command_mock.assert_not_called()

    def test_full_mode_tool_error_uses_needs_changes_status(self) -> None:
        result = evaluate_policy(
            [],
            [SimpleNamespace(name="semgrep", status="missing")],
            profile="standard",
            threshold=None,
            mode="full",
            fail_on_tool_error=False,
        )

        self.assertEqual(result.status, "NEEDS_CHANGES")
        self.assertEqual(result.exit_code, 2)

    def test_project_test_failure_is_a_finding_not_tool_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()
            (target / "package.json").write_text(
                json.dumps({"scripts": {"test": "node -e \"process.exit(1)\""}}),
                encoding="utf-8",
            )

            result, findings = run_project_tests(target, raw)

            self.assertIsNotNone(result)
            assert result is not None
            self.assertEqual(result.status, "findings")
            self.assertEqual(len(findings), 1)
            self.assertEqual(findings[0].category, "tests")

    def test_coverage_tool_error_always_needs_changes(self) -> None:
        result = evaluate_policy(
            [],
            [SimpleNamespace(name="coverage", status="missing")],
            profile="standard",
            threshold=None,
            mode="quick",
            fail_on_tool_error=False,
        )

        self.assertEqual(result.status, "NEEDS_CHANGES")
        self.assertEqual(result.exit_code, 2)


if __name__ == "__main__":
    unittest.main()
