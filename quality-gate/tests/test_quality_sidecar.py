from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sidecar"))

from quality_sidecar.detectors import detect_iac_files  # noqa: E402
from quality_sidecar.policy import evaluate_policy  # noqa: E402
from quality_sidecar.tools import run_project_tests  # noqa: E402


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

    def test_quick_mode_ignores_secret_and_pii_unless_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            secret = "abcdefghijkl" + "mnopqrstuvwxyz"
            cpf = "123.456" + ".789-09"
            (target / "sample.txt").write_text(
                f"password = '{secret}'\ncpf = '{cpf}'\n",
                encoding="utf-8",
            )

            result = self.run_sidecar(target, "--threshold", "99")

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report_path = target / ".quality" / "reports" / "quality-report.json"
            markdown_path = target / ".quality" / "reports" / "quality-report.md"
            self.assertTrue(report_path.exists())
            self.assertTrue(markdown_path.exists())

            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "APPROVED")
            self.assertEqual(report["findings"], [])

    def test_quick_mode_rejects_secret_and_pii_when_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            secret = "abcdefghijkl" + "mnopqrstuvwxyz"
            cpf = "123.456" + ".789-09"
            (target / "sample.txt").write_text(
                f"password = '{secret}'\ncpf = '{cpf}'\n",
                encoding="utf-8",
            )

            result = self.run_sidecar(target, "--threshold", "99", "--enable-secrets", "--enable-pii")

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            report = json.loads((target / ".quality" / "reports" / "quality-report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "REJECTED")
            categories = {finding["category"] for finding in report["findings"]}
            self.assertIn("secrets", categories)
            self.assertIn("pii", categories)

    def test_allow_flags_approve_when_all_findings_are_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            secret = "abcdefghijkl" + "mnopqrstuvwxyz"
            cpf = "123.456" + ".789-09"
            (target / "sample.txt").write_text(
                f"password = '{secret}'\ncpf = '{cpf}'\n",
                encoding="utf-8",
            )

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
            report = json.loads((target / ".quality" / "reports" / "quality-report.json").read_text(encoding="utf-8"))
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
            report = json.loads((target / ".quality" / "reports" / "quality-report.json").read_text(encoding="utf-8"))
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
            report = json.loads((target / ".quality" / "reports" / "quality-report.json").read_text(encoding="utf-8"))
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
            report = json.loads((target / ".quality" / "reports" / "quality-report.json").read_text(encoding="utf-8"))
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
