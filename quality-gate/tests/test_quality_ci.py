from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sidecar"))

from quality_sidecar import ci  # noqa: E402
from quality_sidecar.metrics import load_scope_manifest  # noqa: E402


class QualityCiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_cwd = Path.cwd()
        self.managed_environment = (
            "CODE_APPROVAL_QUALITY_POLICY_FILE",
            "CODE_APPROVAL_QUALITY_POLICY_SHA256",
            "CODE_APPROVAL_QUALITY_TARGET_BRANCH",
            "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
            "CI_PROJECT_DIR",
            "CI_COMMIT_SHA",
        )
        self.previous_environment = {name: os.environ.get(name) for name in self.managed_environment}
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.email", "quality-ci@example.invalid")
        self.git("config", "user.name", "Quality CI Tests")
        (self.repo / "README.md").write_text("fixture\n", encoding="utf-8")
        source = self.repo / "src"
        source.mkdir()
        (source / "app.py").write_text("print('base')\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-m", "base")
        self.base = self.git("rev-parse", "HEAD").stdout.strip()

        (source / "app.py").write_text("print('changed')\n", encoding="utf-8")
        (source / "new.py").write_text("VALUE = 1\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-m", "change")
        self.head = self.git("rev-parse", "HEAD").stdout.strip()
        self.git("update-ref", "refs/remotes/origin/develop", self.base)

        self.policy = self.root / "corporate-policy.json"
        self.write_policy({"schemaVersion": 1, "budgets": {}})
        os.environ.update({
            "CODE_APPROVAL_QUALITY_TARGET_BRANCH": "develop",
            "CI_MERGE_REQUEST_TARGET_BRANCH_NAME": "develop",
            "CI_PROJECT_DIR": str(self.repo),
            "CI_COMMIT_SHA": self.head,
        })
        os.chdir(self.repo)

    def tearDown(self) -> None:
        os.chdir(self.previous_cwd)
        for name, value in self.previous_environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        self.temp.cleanup()

    def git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args],
            cwd=self.repo,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=True,
        )

    def write_policy(self, payload: dict[str, object]) -> None:
        self.policy.write_text(json.dumps(payload), encoding="utf-8")
        os.environ["CODE_APPROVAL_QUALITY_POLICY_FILE"] = str(self.policy)
        os.environ["CODE_APPROVAL_QUALITY_POLICY_SHA256"] = hashlib.sha256(self.policy.read_bytes()).hexdigest()

    def policy_digest(self) -> str:
        return hashlib.sha256(self.policy.read_bytes()).hexdigest()

    def base_args(self) -> list[str]:
        return ["check"]

    def sync_head_environment(self) -> str:
        head = self.git("rev-parse", "HEAD").stdout.strip()
        os.environ["CI_COMMIT_SHA"] = head
        return head

    def changed_environment(self, *, base: str | None = None, head: str | None = None) -> dict[str, str]:
        if base is not None:
            self.git("update-ref", "refs/remotes/origin/develop", base)
        return {
            "CODE_APPROVAL_QUALITY_TARGET_BRANCH": "develop",
            "CI_MERGE_REQUEST_TARGET_BRANCH_NAME": "develop",
            "CI_COMMIT_SHA": head or self.git("rev-parse", "HEAD").stdout.strip(),
        }

    def test_changed_scope_uses_governed_remote_target_and_preserves_sidecar_exit_code(self) -> None:
        captured: dict[str, object] = {}

        def fake_sidecar(arguments: list[str]) -> int:
            captured["arguments"] = arguments
            manifest_path = Path(arguments[arguments.index("--scope-manifest") + 1])
            captured["manifest"] = json.loads(manifest_path.read_text(encoding="utf-8"))
            scan_target = Path(arguments[1])
            self.assertEqual(
                load_scope_manifest(scan_target, str(manifest_path)),
                captured["manifest"],
            )
            self.assertTrue((scan_target / "src" / "app.py").is_file())
            self.assertTrue((scan_target / "README.md").is_file())
            return 1

        environment = self.changed_environment(base=self.base, head=self.head)
        with patch.dict(os.environ, environment, clear=False), patch(
            "quality_sidecar.ci.sidecar_entrypoint", side_effect=fake_sidecar
        ):
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, 1)
        manifest = captured["manifest"]
        assert isinstance(manifest, dict)
        self.assertEqual(manifest["scope"], "changed")
        self.assertEqual(manifest["sourceCommit"], self.head)
        self.assertEqual(manifest["base"], self.base)
        self.assertEqual(manifest["diff"]["status"], "available")
        self.assertEqual(manifest["diff"]["fileCount"], 2)
        self.assertEqual(manifest["selectedFiles"], ["src/app.py", "src/new.py"])
        self.assertEqual(manifest["policy"]["sha256"], self.policy_digest())
        arguments = captured["arguments"]
        assert isinstance(arguments, list)
        self.assertIn("--fail-on-tool-error", arguments)
        self.assertIn("--enable-secrets", arguments)
        self.assertIn("--require-policy", arguments)
        self.assertEqual(arguments[arguments.index("--policy-sha256") + 1], self.policy_digest())
        self.assertIn("--require-evidence-provenance", arguments)
        self.assertEqual(arguments[arguments.index("--expected-source-commit") + 1], self.head)
        self.assertEqual(arguments[arguments.index("--max-evidence-age-seconds") + 1], "86400")
        self.assertNotIn("--run-project-tests", arguments)
        self.assertEqual(arguments[arguments.index("--mode") + 1], "full")

    def test_missing_governed_base_fails_closed_without_calling_sidecar(self) -> None:
        self.git("update-ref", "-d", "refs/remotes/origin/develop")
        with patch("quality_sidecar.ci.sidecar_entrypoint") as sidecar:
            with patch.dict(os.environ, self.changed_environment(), clear=False):
                result = ci.entrypoint(self.base_args())

        self.assertEqual(result, ci.OPERATIONAL_ERROR)
        sidecar.assert_not_called()

    def test_project_code_execution_is_not_enabled_by_quality_ci(self) -> None:
        def fake_sidecar(arguments: list[str]) -> int:
            self.assertNotIn("--run-project-tests", arguments)
            scan_target = Path(arguments[1])
            self.assertNotEqual(scan_target, self.repo)
            self.assertFalse((scan_target / ".git").exists())
            self.assertTrue((scan_target / "src" / "app.py").is_file())
            return 2

        with patch("quality_sidecar.ci.sidecar_entrypoint", side_effect=fake_sidecar):
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, 2)

    def test_sidecar_environment_does_not_receive_ci_credentials_or_command_override(self) -> None:
        original_run_git = ci._run_git

        def guarded_git(*args: object, **kwargs: object) -> subprocess.CompletedProcess[object]:
            self.assertNotIn("CI_JOB_TOKEN", os.environ)
            self.assertNotIn("GIT_EXTERNAL_DIFF", os.environ)
            return original_run_git(*args, **kwargs)

        def fake_sidecar(arguments: list[str]) -> int:
            self.assertNotIn("CI_JOB_TOKEN", os.environ)
            self.assertNotIn("MEGALINTER_COMMAND", os.environ)
            self.assertNotIn("SONAR_TOKEN", os.environ)
            self.assertNotIn("AWS_ACCESS_KEY_ID", os.environ)
            self.assertNotIn("AWS_SECRET_ACCESS_KEY", os.environ)
            self.assertNotIn("GOOGLE_APPLICATION_CREDENTIALS", os.environ)
            self.assertNotIn("NPM_CONFIG_USERCONFIG", os.environ)
            self.assertNotIn("GIT_ASKPASS", os.environ)
            self.assertEqual(os.environ.get("HTTPS_PROXY"), "http://proxy.example.invalid:8080")
            self.assertEqual(os.environ.get("SSL_CERT_FILE"), "/etc/company/ca.pem")
            return 0

        sensitive = {
            "CI_JOB_TOKEN": "job-secret",
            "MEGALINTER_COMMAND": "unexpected-command",
            "SONAR_TOKEN": "sonar-secret",
            "AWS_ACCESS_KEY_ID": "synthetic-access-key",
            "AWS_SECRET_ACCESS_KEY": "synthetic-secret-key",
            "GOOGLE_APPLICATION_CREDENTIALS": "/tmp/synthetic-google-credentials.json",
            "NPM_CONFIG_USERCONFIG": "/tmp/synthetic-npmrc",
            "GIT_ASKPASS": "/tmp/synthetic-askpass",
            "GIT_EXTERNAL_DIFF": "/tmp/synthetic-external-diff",
            "HTTPS_PROXY": "http://proxy.example.invalid:8080",
            "SSL_CERT_FILE": "/etc/company/ca.pem",
        }
        with patch.dict(os.environ, sensitive, clear=False), patch(
            "quality_sidecar.ci._run_git", side_effect=guarded_git
        ), patch("quality_sidecar.ci.sidecar_entrypoint", side_effect=fake_sidecar):
            result = ci.entrypoint(self.base_args())
            self.assertEqual(os.environ["CI_JOB_TOKEN"], "job-secret")
            self.assertEqual(os.environ["MEGALINTER_COMMAND"], "unexpected-command")
            self.assertEqual(os.environ["SONAR_TOKEN"], "sonar-secret")
            self.assertEqual(os.environ["AWS_ACCESS_KEY_ID"], "synthetic-access-key")
            self.assertEqual(os.environ["GOOGLE_APPLICATION_CREDENTIALS"], "/tmp/synthetic-google-credentials.json")

        self.assertEqual(result, 0)

    def test_unexpected_sidecar_exception_is_an_operational_error_without_traceback(self) -> None:
        stderr = io.StringIO()
        with patch(
            "quality_sidecar.ci.sidecar_entrypoint",
            side_effect=RuntimeError("synthetic sensitive runtime detail"),
        ), redirect_stderr(stderr):
            result = ci.entrypoint(self.base_args())

        output = stderr.getvalue()
        self.assertEqual(result, ci.OPERATIONAL_ERROR)
        self.assertIn("Unexpected runtime failure (RuntimeError)", output)
        self.assertNotIn("synthetic sensitive runtime detail", output)
        self.assertNotIn("Traceback", output)

    def test_full_scope_rejects_symlink_that_resolves_outside_checkout(self) -> None:
        outside = self.root / "outside.txt"
        outside.write_text("outside\n", encoding="utf-8")
        link = self.repo / "outside-link.txt"
        try:
            link.symlink_to(outside)
        except OSError as error:
            self.skipTest(f"Symbolic links are unavailable: {error}")
        self.git("add", "outside-link.txt")
        self.git("commit", "-m", "add forbidden symlink")
        self.sync_head_environment()

        with patch("quality_sidecar.ci.sidecar_entrypoint") as sidecar:
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, ci.OPERATIONAL_ERROR)
        sidecar.assert_not_called()

    def test_gitlink_or_submodule_entry_fails_closed(self) -> None:
        self.git(
            "update-index",
            "--add",
            "--cacheinfo",
            f"160000,{self.base},vendor/submodule",
        )
        self.git("commit", "-m", "add forbidden gitlink")
        self.sync_head_environment()

        with patch("quality_sidecar.ci.sidecar_entrypoint") as sidecar:
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, ci.OPERATIONAL_ERROR)
        sidecar.assert_not_called()

    def test_policy_cannot_disable_or_weaken_mandatory_budgets(self) -> None:
        policies = [
            {"budgets": {}},
            {"schemaVersion": 1, "budgets": {"enabled": False}},
            {"schemaVersion": 1, "budgets": {"maxChangedFiles": 101}},
            {"schemaVersion": 1, "budgets": {"maxChangedLines": 0}},
        ]
        for policy in policies:
            with self.subTest(policy=policy):
                self.write_policy(policy)
                with patch("quality_sidecar.ci.sidecar_entrypoint") as sidecar:
                    result = ci.entrypoint(self.base_args())
                self.assertEqual(result, ci.OPERATIONAL_ERROR)
                sidecar.assert_not_called()

    def test_policy_digest_is_mandatory(self) -> None:
        with patch.dict(os.environ, {
            "CODE_APPROVAL_QUALITY_POLICY_FILE": str(self.policy),
            "CODE_APPROVAL_QUALITY_POLICY_SHA256": "",
        }, clear=False), patch("quality_sidecar.ci.sidecar_entrypoint") as sidecar:
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, ci.OPERATIONAL_ERROR)
        sidecar.assert_not_called()

    def test_policy_must_be_outside_checkout(self) -> None:
        local_policy = self.repo / ".company-policy.json"
        local_policy.write_text('{"schemaVersion":1,"budgets":{}}\n', encoding="utf-8")
        self.git("add", ".company-policy.json")
        self.git("commit", "-m", "add untrusted local policy")
        self.sync_head_environment()
        environment = {
            "CODE_APPROVAL_QUALITY_POLICY_FILE": str(local_policy),
            "CODE_APPROVAL_QUALITY_POLICY_SHA256": hashlib.sha256(local_policy.read_bytes()).hexdigest(),
        }
        with patch.dict(os.environ, environment, clear=False), patch(
            "quality_sidecar.ci.sidecar_entrypoint"
        ) as sidecar:
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, ci.OPERATIONAL_ERROR)
        sidecar.assert_not_called()

    def test_policy_path_cannot_traverse_symlink_component(self) -> None:
        real_directory = self.root / "real-policy"
        real_directory.mkdir()
        real_policy = real_directory / "policy.json"
        real_policy.write_text('{"schemaVersion":1,"budgets":{}}\n', encoding="utf-8")
        linked_directory = self.root / "linked-policy"
        try:
            linked_directory.symlink_to(real_directory, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"Symbolic links are unavailable: {error}")
        linked_policy = linked_directory / "policy.json"
        environment = {
            "CODE_APPROVAL_QUALITY_POLICY_FILE": str(linked_policy),
            "CODE_APPROVAL_QUALITY_POLICY_SHA256": hashlib.sha256(real_policy.read_bytes()).hexdigest(),
        }
        with patch.dict(os.environ, environment, clear=False), patch(
            "quality_sidecar.ci.sidecar_entrypoint"
        ) as sidecar:
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, ci.OPERATIONAL_ERROR)
        sidecar.assert_not_called()

    def test_gitlab_boundary_rejects_waiver_even_with_matching_digest(self) -> None:
        waiver = self.root / "waiver.json"
        waiver.write_text("{}\n", encoding="utf-8")
        environment = {
            "CODE_APPROVAL_QUALITY_WAIVERS": str(waiver),
            "CODE_APPROVAL_QUALITY_WAIVER_SHA256": hashlib.sha256(waiver.read_bytes()).hexdigest(),
        }
        with patch.dict(os.environ, environment, clear=False), patch(
            "quality_sidecar.ci.sidecar_entrypoint"
        ) as sidecar:
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, ci.OPERATIONAL_ERROR)
        sidecar.assert_not_called()

    def test_paths_scope_projects_only_requested_path_plus_support(self) -> None:
        resolution = ci.resolve_scope(self.repo, "paths", None, self.head, ["src"])
        try:
            self.assertEqual(resolution.manifest["scope"], "paths")
            self.assertEqual(resolution.manifest["selectedFiles"], ["src/app.py", "src/new.py"])
            self.assertIn("README.md", resolution.manifest["supportFiles"])
        finally:
            if resolution.projection_root:
                import shutil
                shutil.rmtree(resolution.projection_root, ignore_errors=True)

    def test_changed_dotnet_file_projects_unchanged_project_manifest_as_support(self) -> None:
        project = self.repo / "src" / "Sample.csproj"
        project.write_text('<Project Sdk="Microsoft.NET.Sdk" />\n', encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-m", "add dotnet project")
        base = self.git("rev-parse", "HEAD").stdout.strip()
        (self.repo / "src" / "Program.cs").write_text("class Program {}\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-m", "change dotnet source")
        head = self.git("rev-parse", "HEAD").stdout.strip()
        captured: dict[str, object] = {}

        def fake_sidecar(arguments: list[str]) -> int:
            manifest_path = Path(arguments[arguments.index("--scope-manifest") + 1])
            captured.update(json.loads(manifest_path.read_text(encoding="utf-8")))
            scan_target = Path(arguments[1])
            self.assertTrue((scan_target / "src" / "Sample.csproj").is_file())
            return 0

        with patch.dict(os.environ, self.changed_environment(base=base, head=head), clear=False), patch(
            "quality_sidecar.ci.sidecar_entrypoint", side_effect=fake_sidecar
        ):
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, 0)
        self.assertEqual(captured["selectedFiles"], ["src/Program.cs"])
        self.assertIn("src/Sample.csproj", captured["supportFiles"])

    def test_tracked_worktree_change_fails_closed(self) -> None:
        (self.repo / "src" / "app.py").write_text("print('dirty')\n", encoding="utf-8")
        with patch("quality_sidecar.ci.sidecar_entrypoint") as sidecar:
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, ci.OPERATIONAL_ERROR)
        sidecar.assert_not_called()

    def test_projection_reads_commit_tree_not_worktree_after_validation(self) -> None:
        original_validation = ci._validate_clean_checkout

        def mutate_after_validation(target: Path) -> int:
            excluded = original_validation(target)
            (target / "src" / "app.py").write_text("print('post-validation mutation')\n", encoding="utf-8")
            return excluded

        def fake_sidecar(arguments: list[str]) -> int:
            scan_target = Path(arguments[1])
            self.assertEqual(
                (scan_target / "src" / "app.py").read_text(encoding="utf-8"),
                "print('changed')\n",
            )
            manifest_path = Path(arguments[arguments.index("--scope-manifest") + 1])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["sourceMaterialization"], "git-archive")
            return 0

        with patch("quality_sidecar.ci._validate_clean_checkout", side_effect=mutate_after_validation), patch(
            "quality_sidecar.ci.sidecar_entrypoint", side_effect=fake_sidecar
        ):
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, 0)

    def test_untracked_test_artifacts_are_recorded_and_excluded_from_projection(self) -> None:
        results = self.repo / "TestResults" / "run"
        results.mkdir(parents=True)
        coverage = results / "coverage.cobertura.xml"
        coverage.write_text('<coverage line-rate="1" />\n', encoding="utf-8")
        (results / "sample-junit.xml").write_text("<testsuites />\n", encoding="utf-8")

        def fake_sidecar(arguments: list[str]) -> int:
            scan_target = Path(arguments[1])
            self.assertFalse((scan_target / "TestResults").exists())
            self.assertNotIn("--coverage-report", arguments)
            manifest_path = Path(arguments[arguments.index("--scope-manifest") + 1])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["excludedUntrackedCount"], 2)
            return 0

        with patch("quality_sidecar.ci.sidecar_entrypoint", side_effect=fake_sidecar):
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, 0)

    def test_project_controlled_runtime_flags_are_rejected(self) -> None:
        with patch("quality_sidecar.ci.sidecar_entrypoint") as sidecar:
            result = ci.entrypoint(["check", "--scope", "full"])

        self.assertEqual(result, ci.OPERATIONAL_ERROR)
        sidecar.assert_not_called()

    def test_spoofed_predefined_gitlab_context_fails_closed(self) -> None:
        cases = [
            {"CI_PROJECT_DIR": str(self.root), "CI_COMMIT_SHA": self.head},
            {"CI_PROJECT_DIR": str(self.repo), "CI_COMMIT_SHA": self.base},
            {
                "CI_PROJECT_DIR": str(self.repo),
                "CI_COMMIT_SHA": self.head,
                "CI_MERGE_REQUEST_TARGET_BRANCH_NAME": "main",
            },
        ]
        for environment in cases:
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=False), patch(
                "quality_sidecar.ci.sidecar_entrypoint"
            ) as sidecar:
                result = ci.entrypoint(self.base_args())
                self.assertEqual(result, ci.OPERATIONAL_ERROR)
                sidecar.assert_not_called()

    def test_spoofed_diff_base_is_ignored_in_favor_of_governed_remote_ref(self) -> None:
        captured: dict[str, object] = {}

        def fake_sidecar(arguments: list[str]) -> int:
            manifest_path = Path(arguments[arguments.index("--scope-manifest") + 1])
            captured.update(json.loads(manifest_path.read_text(encoding="utf-8")))
            return 0

        environment = self.changed_environment(base=self.base, head=self.head)
        environment["CI_MERGE_REQUEST_DIFF_BASE_SHA"] = self.head
        with patch.dict(os.environ, environment, clear=False), patch(
            "quality_sidecar.ci.sidecar_entrypoint", side_effect=fake_sidecar
        ):
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, 0)
        self.assertEqual(captured["base"], self.base)
        self.assertEqual(captured["selectedFiles"], ["src/app.py", "src/new.py"])

    def test_tracked_build_outputs_logs_and_databases_are_not_implicitly_ignored(self) -> None:
        fixtures = {
            "build/generated.cs": "class Generated {}\n",
            "dist/bundle.js": "console.log('bundle');\n",
            "coverage/raw.txt": "tracked coverage input\n",
            "runtime.log": "tracked log\n",
            "state.db": "tracked database bytes\n",
        }
        for relative, content in fixtures.items():
            path = self.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-m", "add tracked generated-looking sources")
        self.sync_head_environment()

        def fake_sidecar(arguments: list[str]) -> int:
            scan_target = Path(arguments[1])
            for relative in fixtures:
                self.assertTrue((scan_target / relative).is_file(), relative)
            return 0

        with patch("quality_sidecar.ci.sidecar_entrypoint", side_effect=fake_sidecar):
            result = ci.entrypoint(self.base_args())

        self.assertEqual(result, 0)


if __name__ == "__main__":
    unittest.main()
