from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

import defusedxml.ElementTree as ET

from .detectors import detect_iac_files
from .findings import Finding, normalize_severity


@dataclass
class ToolResult:
    name: str
    status: str
    command: list[str] = field(default_factory=list)
    exit_code: int | None = None
    duration_ms: int = 0
    output_path: str | None = None
    stdout_path: str | None = None
    stderr_path: str | None = None
    error: str | None = None
    summary: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _relative(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", errors="replace")


def _command_exists(command: str) -> bool:
    return Path(command).exists() if "/" in command else shutil.which(command) is not None


def _resolve_command(command: str) -> str | None:
    if "/" in command or "\\" in command:
        return command if Path(command).exists() else None
    return shutil.which(command)


def run_command(
    name: str,
    command: list[str],
    output_dir: Path,
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    timeout_seconds: int = 1800,
    acceptable_exit_codes: set[int] | None = None,
    output_path: Path | None = None,
    inherit_environment: bool = False,
) -> ToolResult:
    acceptable = acceptable_exit_codes if acceptable_exit_codes is not None else {0}
    executable = command[0]
    resolved_executable = _resolve_command(executable)
    if not resolved_executable:
        return ToolResult(name=name, status="missing", command=command, error=f"Command not found: {executable}")
    resolved_command = [resolved_executable, *command[1:]]

    stdout_path = output_dir / f"{name}.stdout.log"
    stderr_path = output_dir / f"{name}.stderr.log"
    started = time.perf_counter()
    try:
        result = subprocess.run(
            resolved_command,
            cwd=str(cwd),
            env=_subprocess_environment(env, inherit=inherit_environment),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        duration_ms = int((time.perf_counter() - started) * 1000)
        _write_text(stdout_path, error.stdout or "")
        _write_text(stderr_path, error.stderr or f"Timed out after {timeout_seconds} seconds.")
        return ToolResult(
            name=name,
            status="timeout",
            command=resolved_command,
            duration_ms=duration_ms,
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            error=f"Timed out after {timeout_seconds} seconds.",
        )
    except OSError as error:
        duration_ms = int((time.perf_counter() - started) * 1000)
        return ToolResult(name=name, status="error", command=resolved_command, duration_ms=duration_ms, error=str(error))

    duration_ms = int((time.perf_counter() - started) * 1000)
    _write_text(stdout_path, result.stdout)
    _write_text(stderr_path, result.stderr)
    status = "ok" if result.returncode in acceptable else "error"
    if result.returncode not in acceptable:
        error = f"Exit code {result.returncode}"
    else:
        error = None

    return ToolResult(
        name=name,
        status=status,
        command=resolved_command,
        exit_code=result.returncode,
        duration_ms=duration_ms,
        output_path=str(output_path) if output_path else None,
        stdout_path=str(stdout_path),
        stderr_path=str(stderr_path),
        error=error,
    )


SAFE_SUBPROCESS_ENV_NAMES = {
    "ALL_PROXY",
    "COMSPEC",
    "CURL_CA_BUNDLE",
    "DOTNET_ROOT",
    "GIT_SSL_CAINFO",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "JAVA_HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOCALAPPDATA",
    "NODE_EXTRA_CA_CERTS",
    "NO_COLOR",
    "NO_PROXY",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PYTHONIOENCODING",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "TZ",
    "USERPROFILE",
    "WINDIR",
    "XDG_CACHE_HOME",
}


def _subprocess_environment(overrides: dict[str, str] | None, *, inherit: bool) -> dict[str, str]:
    """Build a least-privilege environment for analyzers.

    Project-owned test commands are the sole opt-in caller that inherits the
    complete environment. Security analyzers receive only runtime, locale,
    proxy, and CA settings plus values supplied by this package itself.
    """
    if inherit:
        environment = dict(os.environ)
    else:
        allowed = {name.upper() for name in SAFE_SUBPROCESS_ENV_NAMES}
        environment = {name: value for name, value in os.environ.items() if name.upper() in allowed}
    environment.setdefault("PYTHONIOENCODING", "utf-8")
    environment.setdefault("NO_COLOR", "1")
    environment.update(overrides or {})
    return environment


def _terraform_file_lists(iac_files: list[str]) -> tuple[list[str], list[str]]:
    """Return Terraform entrypoints and the complete safe projection list."""

    primary: list[str] = []
    projection: list[str] = []
    for value in iac_files:
        name = PurePosixPath(value.replace("\\", "/")).name.lower()
        is_primary = name.endswith((".tf", ".tf.json"))
        is_auxiliary = name.endswith((".tfvars", ".tfvars.json")) or name == ".terraform.lock.hcl"
        if is_primary:
            primary.append(value)
        if is_primary or is_auxiliary:
            projection.append(value)
    return sorted(set(primary)), sorted(set(projection))


def run_external_tools(
    root: Path,
    reports_dir: Path,
    mode: str,
    *,
    enable_secrets: bool = False,
    enable_iac: bool = True,
    run_project_tests: bool = False,
) -> tuple[list[ToolResult], list[Finding]]:
    if mode in {"quick", "offline"}:
        return [], []

    raw_dir = reports_dir / "raw"
    _prepare_raw_dir(raw_dir)
    results: list[ToolResult] = []
    findings: list[Finding] = []
    iac_files = detect_iac_files(root)
    terraform_primary_files, terraform_projection_files = _terraform_file_lists(iac_files)
    flavor = _quality_gate_flavor()

    tool_specs = [
        ("megalinter", lambda current_root, current_raw: _run_megalinter(current_root, current_raw)),
        ("semgrep", lambda current_root, current_raw: _run_semgrep(current_root, current_raw)),
        (
            "gitleaks",
            lambda current_root, current_raw: _run_gitleaks(current_root, current_raw)
            if enable_secrets
            else ToolResult(
                name="gitleaks",
                status="skipped",
                summary={"reason": "Secrets scanning disabled. Use --enable-secrets to run Gitleaks."},
            ),
        ),
        ("trivy", lambda current_root, current_raw: _run_trivy(current_root, current_raw, enable_secrets=enable_secrets)),
        (
            "checkov",
            lambda current_root, current_raw: _run_checkov(current_root, current_raw, iac_files)
            if enable_iac and iac_files
            else ToolResult(
                name="checkov",
                status="skipped",
                summary={
                    "reason": "IaC scanning disabled by --disable-iac."
                    if not enable_iac
                    else "No IaC files detected.",
                    "iacFiles": len(iac_files),
                },
            ),
        ),
        ("osv-scanner", lambda current_root, current_raw: _run_osv_scanner(current_root, current_raw)),
        ("jscpd", lambda current_root, current_raw: _run_jscpd(current_root, current_raw)),
    ]
    if flavor == "generic":
        # Terrascan's MegaLinter project adapter recursively inspects every
        # directory, including bin/obj generated concurrently by C# linters.
        # Run it as a first-class tool against a Terraform-only projection so
        # project/cross-file rules remain intact without hiding legitimate
        # source directories from the other language analyzers.
        tool_specs.insert(
            0,
            (
                "terrascan",
                lambda current_root, current_raw: _run_terrascan(
                    current_root,
                    current_raw,
                    terraform_primary_files,
                    terraform_projection_files,
                )
                if enable_iac and terraform_primary_files
                else ToolResult(
                    name="terrascan",
                    status="skipped",
                    summary={
                        "reason": "IaC scanning disabled by --disable-iac."
                        if not enable_iac
                        else "No Terraform configuration files detected.",
                        "iacFiles": len(terraform_primary_files),
                    },
                ),
            ),
        )

    for name, runner in tool_specs:
        result = runner(root, raw_dir)
        parsed_findings = parse_tool_findings(name, result, root)
        if parsed_findings and result.status == "ok":
            result.status = "findings"
        result.summary["findings"] = len(parsed_findings)
        results.append(result)
        findings.extend(parsed_findings)

    if run_project_tests:
        test_result, test_findings = _run_project_tests(root, raw_dir)
        if test_result:
            results.append(test_result)
            findings.extend(test_findings)

    return results, findings


RAW_EVIDENCE_MARKER = ".code-approval-quality-gate-owned"
RAW_EVIDENCE_FILES = {
    "checkov.json",
    "gitleaks.json",
    "osv-scanner.json",
    "semgrep.json",
    "terrascan.json",
    "trivy.json",
    *{
        f"{tool}.{stream}.log"
        for tool in (
            "checkov",
            "gitleaks",
            "jscpd",
            "megalinter",
            "osv-scanner",
            "project-tests",
            "semgrep",
            "terrascan",
            "trivy",
        )
        for stream in ("stdout", "stderr")
    },
}
RAW_EVIDENCE_DIRS = {"jscpd", "megalinter"}


def _prepare_raw_dir(raw_dir: Path) -> None:
    if raw_dir.is_symlink():
        raise RuntimeError(f"Refusing unsafe raw evidence directory symlink: {raw_dir}")
    raw_dir.mkdir(parents=True, exist_ok=True)
    marker = raw_dir / RAW_EVIDENCE_MARKER
    if marker.is_symlink():
        raise RuntimeError(f"Refusing unsafe raw evidence marker symlink: {marker}")

    for name in RAW_EVIDENCE_FILES | RAW_EVIDENCE_DIRS:
        path = raw_dir / name
        if path.is_symlink():
            raise RuntimeError(f"Refusing unsafe raw evidence output symlink: {path}")

    if marker.is_file():
        for name in RAW_EVIDENCE_FILES:
            path = raw_dir / name
            if path.is_file():
                path.unlink()
        for name in RAW_EVIDENCE_DIRS:
            path = raw_dir / name
            if path.is_file():
                path.unlink()
            elif path.is_dir():
                shutil.rmtree(path)

    marker.write_text("Owned by code-approval-quality-gate.\n", encoding="utf-8")


MEGALINTER_ENABLED_LINTERS = ",".join(
    [
        "ACTION_ACTIONLINT",
        "BASH_SHELLCHECK",
        "CSHARP_CSHARPIER",
        "CSHARP_DOTNET_FORMAT",
        "CSHARP_ROSLYNATOR",
        "DOCKERFILE_HADOLINT",
        "HTML_HTMLHINT",
        "JAVASCRIPT_ES",
        "MARKDOWN_MARKDOWNLINT",
        "POWERSHELL_POWERSHELL",
        "TYPESCRIPT_STANDARD",
        "XML_XMLLINT",
        "YAML_YAMLLINT",
    ]
)

MEGALINTER_GENERIC_DUPLICATE_LINTERS = ",".join(
    [
        "COPYPASTE_JSCPD",
        "REPOSITORY_CHECKOV",
        "REPOSITORY_GIT_DIFF",
        "REPOSITORY_GITLEAKS",
        "REPOSITORY_OSV_SCANNER",
        "REPOSITORY_SEMGREP",
        "REPOSITORY_TRIVY",
        "TERRAFORM_TERRASCAN",
    ]
)

INSTALLED_CONFIG_DIR = Path("/opt/quality-sidecar/sidecar/config")
SOURCE_CONFIG_DIR = Path(__file__).resolve().parents[1] / "config"
MEGALINTER_CONFIG_DIR = (INSTALLED_CONFIG_DIR if INSTALLED_CONFIG_DIR.is_dir() else SOURCE_CONFIG_DIR).resolve()
MEGALINTER_ESLINT_CONFIG_DIR = str(MEGALINTER_CONFIG_DIR)
ESLINT_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "eslint.config.mjs")
MEGALINTER_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "megalinter-ci.yml")
CHECKOV_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "checkov-ci.yml")
GITLEAKS_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "gitleaks-ci.toml")
GITLEAKS_TRUSTED_IGNORE = str(MEGALINTER_CONFIG_DIR / "gitleaksignore-ci")
JSCPD_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "jscpd-ci.json")
OSV_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "osv-scanner-ci.toml")
TRIVY_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "trivy-ci.yaml")
TRIVY_TRUSTED_IGNORE = str(MEGALINTER_CONFIG_DIR / "trivyignore-ci")
TFLINT_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "tflint-ci.hcl")
QUALITY_GATE_FLAVOR_FILE = Path("/etc/code-approval/quality-gate-flavor")


def _quality_gate_flavor() -> str:
    if QUALITY_GATE_FLAVOR_FILE.is_file():
        try:
            flavor = QUALITY_GATE_FLAVOR_FILE.read_text(encoding="utf-8").strip().lower()
        except OSError as error:
            raise RuntimeError(f"Unable to read baked quality-gate flavor: {error}") from error
    else:
        # Source-checkout fallback for local development and unit tests. The
        # production image always contains the root-owned file above.
        flavor = os.environ.get("QUALITY_GATE_FLAVOR", "generic").strip().lower()

    if flavor not in {"generic", "dotnetweb"}:
        raise RuntimeError(f"Unsupported quality-gate flavor: {flavor or '<empty>'}")
    return flavor


def _run_megalinter(root: Path, raw_dir: Path) -> ToolResult:
    configured = os.environ.get("MEGALINTER_COMMAND")
    command = [configured] if configured else ["/entrypoint.sh"]
    env = {
        "DEFAULT_WORKSPACE": str(root),
        "GITHUB_WORKSPACE": str(root),
        "REPORT_OUTPUT_FOLDER": str(raw_dir / "megalinter"),
        "VALIDATE_ALL_CODEBASE": "true",
        "APPLY_FIXES": "none",
        "PRINT_ALL_FILES": "false",
        "SHOW_ELAPSED_TIME": "true",
        # MegaLinter otherwise treats formatter failures as warnings. The
        # quality gate must reject unformatted code instead of silently
        # approving it as a successful analyzer run.
        "FORMATTERS_DISABLE_ERRORS": "false",
        "FILTER_REGEX_EXCLUDE": _megalinter_exclude_regex(root),
        "MEGALINTER_CONFIG": MEGALINTER_TRUSTED_CONFIG,
        # MegaLinter's activation probe prepends the workspace even when a
        # rules path is absolute. A generated relative path reaches the same
        # root-owned config from arbitrary GitLab checkout locations.
        "JAVASCRIPT_ES_RULES_PATH": _megalinter_rules_path(root),
        "JAVASCRIPT_ES_CONFIG_FILE": "eslint.config.mjs",
        # An explicit absolute --config prevents a project file with the same
        # name from winning MegaLinter's normal workspace-first lookup.
        "JAVASCRIPT_ES_ARGUMENTS": f"--config {ESLINT_TRUSTED_CONFIG} --no-ignore --no-inline-config",
        "TERRAFORM_TFLINT_RULES_PATH": str(MEGALINTER_CONFIG_DIR),
        "TERRAFORM_TFLINT_CONFIG_FILE": Path(TFLINT_TRUSTED_CONFIG).name,
    }
    # The portable flavor retains MegaLinter's language auto-detection. The
    # smaller dotnetweb flavor is deliberately constrained to linters shipped
    # by that base image so a missing analyzer is an operational error rather
    # than an accidental cross-language promise.
    if _quality_gate_flavor() == "dotnetweb":
        env["ENABLE_LINTERS"] = MEGALINTER_ENABLED_LINTERS
    else:
        # These analyzers run as first-class sidecar tools with normalized
        # findings. Git diff is also incompatible with the metadata-free
        # workspace projection used by the GitLab container contract. Retain
        # automatic language linter discovery in the portable image.
        env["DISABLE_LINTERS"] = MEGALINTER_GENERIC_DUPLICATE_LINTERS
    result = run_command(
        "megalinter",
        command,
        raw_dir,
        cwd=root,
        env=env,
        acceptable_exit_codes={0, 1},
        output_path=raw_dir / "megalinter",
    )
    output_directory = Path(result.output_path or "")
    evidence_logs = _megalinter_evidence_logs(output_directory)
    if result.status not in {"missing", "timeout", "error"} and not evidence_logs:
        result.status = "error"
        result.error = "MegaLinter did not produce the required per-analyzer execution logs."
        result.summary["evidenceValid"] = False
        return result
    if evidence_logs:
        result.summary["evidenceValid"] = True
        result.summary["executedAnalyzers"] = sorted(
            {
                path.stem.removesuffix("-SUCCESS").removesuffix("-ERROR").removesuffix("-suggestions")
                for path in evidence_logs
            }
        )
    if result.exit_code == 1:
        error_logs = _megalinter_error_logs(output_directory)
        fatal_logs = [
            path
            for path in error_logs
            if any(
                marker in _read_text(path)
                for marker in ("Fatal error while calling", "Failed to initialize plugins")
            )
        ]
        if not error_logs:
            result.status = "error"
            result.error = "MegaLinter failed without producing analyzer logs."
        elif fatal_logs:
            result.status = "error"
            result.error = "One or more MegaLinter analyzers could not start."
            result.summary["fatalAnalyzers"] = [path.stem.removesuffix("-ERROR") for path in fatal_logs]
        else:
            result.status = "findings"
        result.summary["failedAnalyzers"] = [path.stem.removesuffix("-ERROR") for path in error_logs]
    return result


def _megalinter_exclude_regex(root: Path) -> str:
    root_text = root.resolve().as_posix().rstrip("/") or "/"
    escaped_root = re.escape(root_text)
    # Match dependency/output directories only below the analyzed root. A
    # plain `tmp/` expression also matched the `/tmp/...` smoke/GitLab mount
    # prefix and silently reduced MegaLinter to a zero-file run.
    return rf"^{escaped_root}/(?:.*?/)?(?:\.quality|node_modules|coverage|dist|tmp)(?:/|$)"


def _megalinter_rules_path(root: Path) -> str:
    """Return a relative config path when the host filesystem permits it."""

    try:
        return os.path.relpath(MEGALINTER_CONFIG_DIR, root)
    except ValueError:
        # Windows cannot express a relative path across drive letters. This
        # branch is useful for source-tree tests/local invocation; the Linux
        # production image always takes the relative-path branch above.
        return str(MEGALINTER_CONFIG_DIR)


def _megalinter_error_logs(output_dir: Path) -> list[Path]:
    logs_dir = output_dir / "linters_logs"
    return sorted(logs_dir.glob("*-ERROR.log")) if logs_dir.is_dir() else []


def _megalinter_evidence_logs(output_dir: Path) -> list[Path]:
    logs_dir = output_dir / "linters_logs"
    if not logs_dir.is_dir() or logs_dir.is_symlink():
        return []
    return sorted(
        path
        for path in logs_dir.glob("*.log")
        if path.is_file() and not path.is_symlink() and path.stat().st_size > 0 and not path.name.endswith("-suggestions.log")
    )


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _run_semgrep(root: Path, raw_dir: Path) -> ToolResult:
    output = raw_dir / "semgrep.json"
    result = run_command(
        "semgrep",
        [
            "semgrep",
            "scan",
            "--config=p/default",
            "--metrics=off",
            "--no-git-ignore",
            "--x-ignore-semgrepignore-files",
            "--disable-nosem",
            "--exclude",
            ".git",
            "--exclude",
            ".quality",
            "--exclude",
            "node_modules",
            "--json",
            "--output",
            str(output),
            str(root),
        ],
        raw_dir,
        cwd=MEGALINTER_CONFIG_DIR,
        acceptable_exit_codes={0, 1},
        output_path=output,
    )
    result.summary["analysisInput"] = {
        "kind": "ruleset",
        "source": "semgrep-registry:p/default",
        "pinned": False,
        "networkRequired": True,
    }
    return result


def _run_gitleaks(root: Path, raw_dir: Path) -> ToolResult:
    output = raw_dir / "gitleaks.json"
    return run_command(
        "gitleaks",
        [
            "gitleaks",
            "--redact=100",
            "--no-banner",
            "--config",
            GITLEAKS_TRUSTED_CONFIG,
            "--gitleaks-ignore-path",
            GITLEAKS_TRUSTED_IGNORE,
            "--ignore-gitleaks-allow",
            "--report-format",
            "json",
            "--report-path",
            str(output),
            "dir",
            str(root),
        ],
        raw_dir,
        cwd=MEGALINTER_CONFIG_DIR,
        acceptable_exit_codes={0, 1},
        output_path=output,
    )


def _run_trivy(root: Path, raw_dir: Path, *, enable_secrets: bool) -> ToolResult:
    output = raw_dir / "trivy.json"
    scanners = "vuln,misconfig,secret" if enable_secrets else "vuln,misconfig"
    skipped_directories = [root / name for name in (".git", ".quality", "node_modules", "vendor")]
    skip_args = [argument for directory in skipped_directories for argument in ("--skip-dirs", str(directory))]
    result = run_command(
        "trivy",
        [
            "trivy",
            "--config",
            TRIVY_TRUSTED_CONFIG,
            "fs",
            "--ignorefile",
            TRIVY_TRUSTED_IGNORE,
            "--show-suppressed",
            "--scanners",
            scanners,
            "--format",
            "json",
            "--output",
            str(output),
            "--exit-code",
            "0",
            *skip_args,
            str(root),
        ],
        raw_dir,
        cwd=MEGALINTER_CONFIG_DIR,
        acceptable_exit_codes={0},
        output_path=output,
    )
    result.summary["analysisInput"] = {
        "kind": "vulnerability-database",
        "source": "ghcr.io/aquasecurity/trivy-db",
        "pinned": False,
        "networkRequired": True,
    }
    return result


def _copy_stdout_to_output(result: ToolResult, output: Path) -> None:
    stdout_path = Path(result.stdout_path) if result.stdout_path else None
    if stdout_path and stdout_path.exists():
        output.write_text(stdout_path.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")


def _safe_projection_path(value: str) -> Path:
    normalized = value.replace("\\", "/")
    relative = PurePosixPath(normalized)
    if (
        not normalized
        or relative.is_absolute()
        or re.match(r"^[A-Za-z]:", normalized)
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        raise ValueError(f"Unsafe Terraform projection path: {value!r}")
    return Path(*relative.parts)


def _copy_terraform_projection(root: Path, destination: Path, files: list[str]) -> set[str]:
    root_resolved = root.resolve(strict=True)
    copied: set[str] = set()
    for value in files:
        relative = _safe_projection_path(value)
        source = root / relative
        current = root
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError(f"Terraform projection source traverses a symbolic link: {value}")
        if not source.is_file():
            raise ValueError(f"Terraform projection source is not a regular file: {value}")
        try:
            source.resolve(strict=True).relative_to(root_resolved)
        except (OSError, ValueError) as error:
            raise ValueError(f"Terraform projection source escapes the analysis root: {value}") from error
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target, follow_symlinks=False)
        copied.add(relative.as_posix())
    return copied


def _add_terraform_projection_anchors(
    destination: Path,
    primary_files: list[str],
    projection_files: list[str],
) -> list[str]:
    """Keep Terrascan project traversal valid when Terraform starts below the root.

    Terrascan 1.19.9 reports scan_errors for every traversed ancestor that has
    no Terraform file of its own. Comment-only anchors make those directories
    valid without changing the analyzed resources or exposing non-IaC files.
    """

    directories_with_config: set[Path] = set()
    traversed_directories: set[Path] = {Path()}
    for value in primary_files:
        relative = _safe_projection_path(value)
        directories_with_config.add(relative.parent)
    for value in projection_files:
        relative = _safe_projection_path(value)
        current = Path()
        for part in relative.parent.parts:
            current = current / part
            traversed_directories.add(current)

    anchors: list[str] = []
    for directory in sorted(traversed_directories - directories_with_config, key=lambda item: item.as_posix()):
        suffix = 0
        while True:
            name = "quality_gate_projection_anchor.tf" if suffix == 0 else f"quality_gate_projection_anchor_{suffix}.tf"
            anchor = destination / directory / name
            if not anchor.exists():
                break
            suffix += 1
        anchor.write_text("# Trusted projection anchor for Terrascan directory traversal.\n", encoding="utf-8")
        anchors.append((directory / name).as_posix())
    return anchors


def _sanitize_terrascan_evidence(payload: Any, projection: Path, allowed_files: set[str]) -> dict[str, Any]:
    _validate_tool_payload("terrascan", payload)
    results = payload["results"]
    summary = results["scan_summary"]
    scan_target = summary.get("file/folder")
    try:
        if not isinstance(scan_target, str) or Path(scan_target).resolve(strict=True) != projection.resolve(strict=True):
            raise ValueError("Terrascan report target does not match the trusted projection")
    except OSError as error:
        raise ValueError("Terrascan report target could not be resolved") from error

    for collection_name in ("violations", "skipped_violations"):
        for item in results.get(collection_name) or []:
            file_value = item.get("file")
            if not isinstance(file_value, str) or not file_value:
                raise ValueError("Terrascan reported a finding without a trusted file path")
            normalized = _safe_projection_path(str(file_value)).as_posix()
            if normalized not in allowed_files:
                raise ValueError(f"Terrascan reported a file outside the trusted projection: {file_value}")
            item["file"] = normalized
    summary["file/folder"] = "."
    return payload


def _run_terrascan(
    root: Path,
    raw_dir: Path,
    primary_files: list[str],
    projection_files: list[str],
) -> ToolResult:
    output = raw_dir / "terrascan.json"
    try:
        with tempfile.TemporaryDirectory(prefix="code-approval-terrascan-") as temporary:
            projection = Path(temporary)
            allowed_files = _copy_terraform_projection(root, projection, projection_files)
            anchors = _add_terraform_projection_anchors(projection, primary_files, projection_files)
            result = run_command(
                "terrascan",
                [
                    "terrascan",
                    "scan",
                    "--iac-type",
                    "terraform",
                    "--iac-dir",
                    str(projection),
                    "--output",
                    "json",
                ],
                raw_dir,
                cwd=MEGALINTER_CONFIG_DIR,
                acceptable_exit_codes={0, 3},
                output_path=output,
            )
            _copy_stdout_to_output(result, output)
            if result.status not in {"missing", "timeout", "error"}:
                payload, evidence_error = _load_json_evidence(str(output))
                if evidence_error is not None:
                    result.status = "error"
                    result.error = f"Invalid analyzer evidence: {evidence_error}."
                    result.summary["evidenceValid"] = False
                else:
                    try:
                        sanitized = _sanitize_terrascan_evidence(payload, projection, allowed_files)
                        output.write_text(
                            json.dumps(sanitized, ensure_ascii=False, separators=(",", ":")) + "\n",
                            encoding="utf-8",
                        )
                    except (TypeError, ValueError) as error:
                        result.status = "error"
                        result.error = f"Invalid analyzer evidence: {error}."
                        result.summary["evidenceValid"] = False
    except (OSError, ValueError) as error:
        return ToolResult(
            name="terrascan",
            status="error",
            output_path=str(output),
            error=f"Unable to build trusted Terraform projection: {error}",
            summary={"evidenceValid": False},
        )

    result.summary.update(
        {
            "analysisInput": {
                "kind": "built-in-policy-bundle",
                "source": "terrascan@1.19.9",
                "pinned": True,
                "networkRequired": False,
            },
            "runtimeInputs": [
                {
                    "kind": "terraform-registry-metadata",
                    "source": "registry.terraform.io",
                    "pinned": False,
                    "networkRequired": True,
                }
            ],
            "iacFiles": len(primary_files),
            "iacFileSamples": primary_files[:20],
            "projectionFiles": len(projection_files),
            "projectionAnchors": len(anchors),
        }
    )
    return result


def _run_checkov(root: Path, raw_dir: Path, iac_files: list[str]) -> ToolResult:
    output = raw_dir / "checkov.json"
    result = run_command(
        "checkov",
        [
            "checkov",
            "--config-file",
            CHECKOV_TRUSTED_CONFIG,
            f"--directory={root}",
            "--output",
            "json",
            "--quiet",
            "--skip-download",
        ],
        raw_dir,
        cwd=MEGALINTER_CONFIG_DIR,
        acceptable_exit_codes={0, 1},
        output_path=output,
    )
    _copy_stdout_to_output(result, output)
    result.summary["iacFiles"] = len(iac_files)
    result.summary["iacFileSamples"] = iac_files[:20]
    return result


def _run_osv_scanner(root: Path, raw_dir: Path) -> ToolResult:
    output = raw_dir / "osv-scanner.json"
    result = run_command(
        "osv-scanner",
        [
            "osv-scanner",
            "scan",
            "source",
            "--recursive",
            "--no-ignore",
            "--allow-no-lockfiles",
            "--config",
            OSV_TRUSTED_CONFIG,
            "--format",
            "json",
            str(root),
        ],
        raw_dir,
        cwd=MEGALINTER_CONFIG_DIR,
        acceptable_exit_codes={0, 1},
        output_path=output,
    )
    _copy_stdout_to_output(result, output)
    stderr_path = Path(result.stderr_path) if result.stderr_path else None
    stderr_text = stderr_path.read_text(encoding="utf-8", errors="replace") if stderr_path and stderr_path.exists() else ""
    if result.status == "error" and "No package sources found" in stderr_text:
        output.write_text('{"results":[]}\n', encoding="utf-8")
        result.status = "ok"
        result.exit_code = 0
        result.error = None
    result.summary["analysisInput"] = {
        "kind": "vulnerability-database",
        "source": "osv.dev",
        "pinned": False,
        "networkRequired": True,
    }
    return result


def _run_jscpd(root: Path, raw_dir: Path) -> ToolResult:
    output_dir = raw_dir / "jscpd"
    result = run_command(
        "jscpd",
        [
            "jscpd",
            "--config",
            JSCPD_TRUSTED_CONFIG,
            "--no-gitignore",
            "--silent",
            "--reporters",
            "json",
            "--ignore",
            "**/*.md,**/.quality/**,**/node_modules/**,**/obj/**,**/bin/**,.quality/**,node_modules/**,obj/**,bin/**",
            "--output",
            str(output_dir),
            str(root),
        ],
        raw_dir,
        cwd=MEGALINTER_CONFIG_DIR,
        acceptable_exit_codes={0, 1},
        output_path=output_dir / "jscpd-report.json",
    )
    report = output_dir / "jscpd-report.json"
    # The exact reporter contract is deliberate. Picking an arbitrary JSON
    # file could normalize unrelated or attacker-controlled evidence.
    result.output_path = str(report)
    return result


SUPPORTED_COVERAGE_PATTERNS = [
    "coverage/lcov.info",
    "lcov.info",
    "coverage.xml",
    "coverage/coverage.xml",
    "**/coverage.cobertura.xml",
    "TestResults/**/coverage.cobertura.xml",
    "target/site/jacoco/jacoco.xml",
    "build/reports/jacoco/test/jacocoTestReport.xml",
    "coverage.out",
    "clover.xml",
    "coverage/clover.xml",
]


@dataclass
class CoverageMetrics:
    line_covered: int = 0
    line_total: int = 0
    branch_covered: int = 0
    branch_total: int = 0

    def add(self, other: "CoverageMetrics") -> None:
        self.line_covered += other.line_covered
        self.line_total += other.line_total
        self.branch_covered += other.branch_covered
        self.branch_total += other.branch_total

    @property
    def line_percent(self) -> float | None:
        if self.line_total <= 0:
            return None
        return self.line_covered / self.line_total * 100

    @property
    def branch_percent(self) -> float | None:
        if self.branch_total <= 0:
            return None
        return self.branch_covered / self.branch_total * 100


def run_coverage_check(
    root: Path,
    reports_dir: Path,
    *,
    report_paths: list[str],
    min_line_coverage: float,
    min_branch_coverage: float | None,
) -> tuple[ToolResult, list[Finding]]:
    raw_dir = reports_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    coverage_files = _resolve_coverage_reports(root, report_paths)
    if not coverage_files:
        return (
            ToolResult(
                name="coverage",
                status="missing",
                summary={
                    "reason": "Coverage was enabled, but no supported coverage report was found.",
                    "searched": report_paths or SUPPORTED_COVERAGE_PATTERNS,
                    "expectedFormats": ["lcov", "cobertura", "jacoco", "clover", "go-coverprofile"],
                },
            ),
            [],
        )

    metrics = CoverageMetrics()
    parsed_files: list[str] = []
    errors: list[str] = []
    for report in coverage_files:
        try:
            report_metrics = _parse_coverage_report(report)
        except (OSError, ET.ParseError, ValueError) as error:
            errors.append(f"{_relative(report, root)}: {error}")
            continue
        if report_metrics.line_total > 0 or report_metrics.branch_total > 0:
            metrics.add(report_metrics)
            parsed_files.append(_relative(report, root))

    if errors and not parsed_files:
        return (
            ToolResult(
                name="coverage",
                status="error",
                summary={"reason": "Coverage reports could not be parsed.", "errors": errors},
            ),
            [],
        )
    if metrics.line_percent is None:
        return (
            ToolResult(
                name="coverage",
                status="error",
                summary={"reason": "Coverage reports did not contain line coverage data.", "files": parsed_files, "errors": errors},
            ),
            [],
        )

    summary: dict[str, Any] = {
        "files": parsed_files,
        "lineCoverage": round(metrics.line_percent, 2),
        "lineCovered": metrics.line_covered,
        "lineTotal": metrics.line_total,
        "minLineCoverage": min_line_coverage,
    }
    if metrics.branch_percent is not None:
        summary.update(
            {
                "branchCoverage": round(metrics.branch_percent, 2),
                "branchCovered": metrics.branch_covered,
                "branchTotal": metrics.branch_total,
            }
        )
    if min_branch_coverage is not None:
        summary["minBranchCoverage"] = min_branch_coverage
    if errors:
        summary["parseWarnings"] = errors

    if min_branch_coverage is not None and metrics.branch_percent is None:
        return (
            ToolResult(
                name="coverage",
                status="error",
                summary={
                    **summary,
                    "reason": "Branch coverage threshold was requested, but no branch coverage data was found.",
                },
            ),
            [],
        )

    findings: list[Finding] = []
    if metrics.line_percent < min_line_coverage:
        findings.append(
            Finding(
                tool="coverage",
                rule="coverage.line-threshold",
                severity="high",
                category="coverage",
                message=(
                    f"Line coverage {metrics.line_percent:.2f}% is below required "
                    f"{min_line_coverage:.2f}%."
                ),
                metadata=summary,
            )
        )
    if min_branch_coverage is not None and metrics.branch_percent is not None and metrics.branch_percent < min_branch_coverage:
        findings.append(
            Finding(
                tool="coverage",
                rule="coverage.branch-threshold",
                severity="high",
                category="coverage",
                message=(
                    f"Branch coverage {metrics.branch_percent:.2f}% is below required "
                    f"{min_branch_coverage:.2f}%."
                ),
                metadata=summary,
            )
        )

    return ToolResult(name="coverage", status="findings" if findings else "ok", summary=summary), findings


def _resolve_coverage_reports(root: Path, report_paths: list[str]) -> list[Path]:
    if report_paths:
        candidates = [(root / item).resolve() if not Path(item).is_absolute() else Path(item) for item in report_paths]
    else:
        candidates = []
        for pattern in SUPPORTED_COVERAGE_PATTERNS:
            candidates.extend(root.glob(pattern))

    resolved: list[Path] = []
    for candidate in candidates:
        if not candidate.exists() or candidate.is_dir():
            continue
        try:
            relative_parts = candidate.resolve().relative_to(root.resolve()).parts
        except ValueError:
            relative_parts = candidate.parts
        if any(part in {".git", ".quality", "node_modules", "vendor", "__pycache__"} for part in relative_parts):
            continue
        if candidate not in resolved:
            resolved.append(candidate)
    return sorted(resolved)


def _parse_coverage_report(path: Path) -> CoverageMetrics:
    name = path.name.lower()
    text = path.read_text(encoding="utf-8", errors="replace")
    stripped = text.lstrip()
    if name == "lcov.info" or stripped.startswith("TN:") or "\nDA:" in stripped:
        return _parse_lcov(text)
    if name == "coverage.out" or stripped.startswith("mode: "):
        return _parse_go_coverprofile(text)
    if stripped.startswith("<"):
        return _parse_xml_coverage(path)
    raise ValueError("unsupported coverage report format")


def _parse_lcov(text: str) -> CoverageMetrics:
    metrics = CoverageMetrics()
    current_lines: dict[int, int] = {}
    current_branches: list[int] = []

    def flush() -> None:
        nonlocal current_lines, current_branches
        metrics.line_total += len(current_lines)
        metrics.line_covered += sum(1 for hits in current_lines.values() if hits > 0)
        metrics.branch_total += len(current_branches)
        metrics.branch_covered += sum(1 for hits in current_branches if hits > 0)
        current_lines = {}
        current_branches = []

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.startswith("DA:"):
            parts = line[3:].split(",")
            if len(parts) >= 2:
                current_lines[int(parts[0])] = int(float(parts[1]))
        elif line.startswith("BRDA:"):
            parts = line[5:].split(",")
            if len(parts) >= 4 and parts[3] != "-":
                current_branches.append(int(float(parts[3])))
        elif line == "end_of_record":
            flush()
    flush()
    return metrics


def _parse_go_coverprofile(text: str) -> CoverageMetrics:
    metrics = CoverageMetrics()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("mode:"):
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        statements = int(parts[1])
        hits = int(parts[2])
        metrics.line_total += statements
        if hits > 0:
            metrics.line_covered += statements
    return metrics


def _parse_xml_coverage(path: Path) -> CoverageMetrics:
    root = ET.parse(path).getroot()
    tag = _xml_tag(root)
    if tag == "report":
        return _parse_jacoco_xml(root)
    if tag == "coverage":
        clover = _parse_clover_xml(root)
        if clover.line_total > 0:
            return clover
        return _parse_cobertura_xml(root)
    raise ValueError(f"unsupported XML coverage root: {tag}")


def _parse_jacoco_xml(root: ET.Element) -> CoverageMetrics:
    metrics = CoverageMetrics()
    for counter in root.iter():
        if _xml_tag(counter) != "counter":
            continue
        counter_type = counter.attrib.get("type")
        missed = int(counter.attrib.get("missed", "0"))
        covered = int(counter.attrib.get("covered", "0"))
        if counter_type == "LINE":
            metrics.line_total += missed + covered
            metrics.line_covered += covered
        elif counter_type == "BRANCH":
            metrics.branch_total += missed + covered
            metrics.branch_covered += covered
    return metrics


def _parse_cobertura_xml(root: ET.Element) -> CoverageMetrics:
    metrics = CoverageMetrics()
    lines_valid = _int_attr(root, "lines-valid")
    lines_covered = _int_attr(root, "lines-covered")
    branches_valid = _int_attr(root, "branches-valid")
    branches_covered = _int_attr(root, "branches-covered")

    if lines_valid is not None and lines_covered is not None:
        metrics.line_total = lines_valid
        metrics.line_covered = lines_covered
    elif "line-rate" in root.attrib:
        metrics.line_total = 10000
        metrics.line_covered = int(float(root.attrib["line-rate"]) * metrics.line_total)

    if branches_valid is not None and branches_covered is not None:
        metrics.branch_total = branches_valid
        metrics.branch_covered = branches_covered
    elif "branch-rate" in root.attrib:
        metrics.branch_total = 10000
        metrics.branch_covered = int(float(root.attrib["branch-rate"]) * metrics.branch_total)
    return metrics


def _parse_clover_xml(root: ET.Element) -> CoverageMetrics:
    metrics = CoverageMetrics()
    metrics_nodes = [item for item in root.iter() if _xml_tag(item) == "metrics"]
    if not metrics_nodes:
        return metrics
    node = metrics_nodes[-1]
    statements = _int_attr(node, "statements")
    covered_statements = _int_attr(node, "coveredstatements")
    conditionals = _int_attr(node, "conditionals")
    covered_conditionals = _int_attr(node, "coveredconditionals")
    if statements is not None and covered_statements is not None:
        metrics.line_total = statements
        metrics.line_covered = covered_statements
    if conditionals is not None and covered_conditionals is not None:
        metrics.branch_total = conditionals
        metrics.branch_covered = covered_conditionals
    return metrics


def _xml_tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _int_attr(element: ET.Element, name: str) -> int | None:
    value = element.attrib.get(name)
    return int(value) if value is not None and value != "" else None


def _missing_npm_workspaces(root: Path, package_json: Path) -> list[str]:
    try:
        package = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    workspaces = package.get("workspaces", [])
    patterns = workspaces.get("packages", []) if isinstance(workspaces, dict) else workspaces
    if not isinstance(patterns, list):
        return []

    missing: list[str] = []
    for pattern in patterns:
        if not isinstance(pattern, str):
            continue
        matches = [path for path in root.glob(pattern) if (path / "package.json").is_file()]
        if not matches:
            missing.append(pattern)
    return missing


def _project_test_outcome(result: ToolResult, *, path: str, message: str) -> tuple[ToolResult, list[Finding]]:
    if result.exit_code in {None, 0}:
        return result, []
    result.status = "findings"
    return result, [
        Finding(
            tool="project-tests",
            rule="tests.failed",
            severity="high",
            category="tests",
            path=path,
            message=message,
        )
    ]


def _run_project_tests(root: Path, raw_dir: Path) -> tuple[ToolResult | None, list[Finding]]:
    package_json = root / "package.json"
    if package_json.exists() and shutil.which("npm"):
        missing_workspaces = _missing_npm_workspaces(root, package_json)
        if missing_workspaces:
            scope = os.environ.get("QUALITY_CHECK_SCOPE", "full")
            if scope not in {"changed", "paths"}:
                return ToolResult(
                    name="project-tests",
                    status="error",
                    error="Project tests cannot run because npm workspaces are absent from the full checkout.",
                    summary={"missingWorkspaces": missing_workspaces},
                ), []
            return ToolResult(
                name="project-tests",
                status="skipped",
                summary={
                    "reason": "Project tests require npm workspaces absent from the analyzed checkout.",
                    "missingWorkspaces": missing_workspaces,
                },
            ), []
        result = run_command(
            "project-tests",
            ["npm", "test", "--if-present"],
            raw_dir,
            cwd=root,
            acceptable_exit_codes={0, 1},
            inherit_environment=True,
        )
        return _project_test_outcome(result, path="package.json", message="Project test command failed.")

    pyproject = root / "pyproject.toml"
    tests_dir = root / "tests"
    if pyproject.exists() and tests_dir.exists() and shutil.which("python"):
        result = run_command(
            "project-tests",
            ["python", "-m", "unittest", "discover"],
            raw_dir,
            cwd=root,
            acceptable_exit_codes={0, 1},
            inherit_environment=True,
        )
        return _project_test_outcome(result, path="tests", message="Python unittest discovery failed.")

    return None, []


def run_project_tests(root: Path, raw_dir: Path) -> tuple[ToolResult | None, list[Finding]]:
    """Run project-owned tests only after an explicit caller opt-in."""
    return _run_project_tests(root, raw_dir)


def parse_json(path: str | None) -> Any | None:
    """Compatibility helper for callers that do not require evidence proof."""
    payload, _ = _load_json_evidence(path)
    return payload


def _load_json_evidence(path: str | None) -> tuple[Any | None, str | None]:
    if not path:
        return None, "the analyzer did not declare an output path"
    file_path = Path(path)
    if not file_path.is_file() or file_path.is_symlink():
        return None, "the analyzer did not produce the expected regular JSON report"
    try:
        text = file_path.read_text(encoding="utf-8", errors="strict").strip()
    except (OSError, UnicodeError):
        return None, "the analyzer JSON report could not be read as UTF-8"
    if not text:
        return None, "the analyzer JSON report is empty"
    try:
        return json.loads(text), None
    except json.JSONDecodeError:
        return None, "the analyzer JSON report is malformed"


def _validate_tool_payload(name: str, payload: Any) -> None:
    if name == "semgrep":
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise ValueError("Semgrep report needs a results array")
    elif name == "gitleaks":
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise ValueError("Gitleaks report needs an array of findings")
    elif name == "trivy":
        if not isinstance(payload, dict) or not isinstance(payload.get("Results"), list):
            raise ValueError("Trivy report needs a Results array")
    elif name == "terrascan":
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), dict):
            raise ValueError("Terrascan report needs a results object")
        results = payload["results"]
        summary = results.get("scan_summary")
        violations = results.get("violations")
        skipped = results.get("skipped_violations")
        scan_errors = results.get("scan_errors")
        counters = ("policies_validated", "violated_policies", "low", "medium", "high")
        if (
            not isinstance(summary, dict)
            or not all(
                isinstance(summary.get(counter), int)
                and not isinstance(summary.get(counter), bool)
                and summary[counter] >= 0
                for counter in counters
            )
            or violations is not None
            and (not isinstance(violations, list) or not all(isinstance(item, dict) for item in violations))
            or skipped is not None
            and (not isinstance(skipped, list) or not all(isinstance(item, dict) for item in skipped))
            or scan_errors is not None
            and (not isinstance(scan_errors, list) or bool(scan_errors))
            or (summary["violated_policies"] == 0) != (not violations)
        ):
            raise ValueError("Terrascan report has an invalid summary or violation list")
    elif name == "checkov":
        documents = payload if isinstance(payload, list) else [payload]
        if not documents or not all(
            isinstance(item, dict)
            and (
                isinstance(item.get("results"), (dict, list))
                or _is_official_empty_checkov_summary(item)
            )
            for item in documents
        ):
            raise ValueError("Checkov report needs results objects or an official empty summary")
    elif name == "osv-scanner":
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise ValueError("OSV-Scanner report needs a results array")
    elif name == "jscpd":
        if not isinstance(payload, dict) or not isinstance(payload.get("duplicates"), list):
            raise ValueError("jscpd report needs a duplicates array")


def _is_official_empty_checkov_summary(payload: dict[str, Any]) -> bool:
    """Recognize Checkov 3.x's real zero-resource JSON contract.

    Checkov omits ``results`` when no checks apply and emits only counters plus
    its version. Accept that exact empty state without treating arbitrary `{}`
    as successful analyzer evidence.
    """
    if "results" in payload:
        return False
    counters = ("passed", "failed", "skipped", "parsing_errors", "resource_count")
    expected_keys = {*counters, "checkov_version"}
    return (
        set(payload) == expected_keys
        and all(isinstance(payload.get(name), int) and not isinstance(payload.get(name), bool) for name in counters)
        and all(payload[name] == 0 for name in counters)
        and isinstance(payload.get("checkov_version"), str)
        and bool(payload["checkov_version"].strip())
    )


def parse_tool_findings(name: str, result: ToolResult, root: Path) -> list[Finding]:
    if result.status in {"missing", "timeout", "error", "skipped"}:
        return []
    if name == "megalinter":
        return _parse_megalinter(result)
    parsers = {
        "semgrep": _parse_semgrep,
        "gitleaks": _parse_gitleaks,
        "terrascan": _parse_terrascan,
        "trivy": _parse_trivy,
        "checkov": _parse_checkov,
        "osv-scanner": _parse_osv,
        "jscpd": _parse_jscpd,
    }
    parser = parsers.get(name)
    if parser is None:
        return []
    payload, error = _load_json_evidence(result.output_path)
    if error is None:
        try:
            _validate_tool_payload(name, payload)
        except (TypeError, ValueError) as validation_error:
            error = str(validation_error)
    if error is not None:
        result.status = "error"
        result.error = f"Invalid analyzer evidence: {error}."
        result.summary["evidenceValid"] = False
        return []
    try:
        findings = parser(payload, root)
    except (AttributeError, TypeError, ValueError):
        result.status = "error"
        result.error = "Invalid analyzer evidence: the report shape could not be normalized."
        result.summary["evidenceValid"] = False
        return []
    result.summary["evidenceValid"] = True
    return findings


def _parse_megalinter(result: ToolResult) -> list[Finding]:
    findings: list[Finding] = []
    for log_path in _megalinter_error_logs(Path(result.output_path or "")):
        analyzer = log_path.stem.removesuffix("-ERROR")
        findings.append(
            Finding(
                tool="megalinter",
                rule=f"megalinter.{analyzer.lower().replace('_', '-')}",
                severity="high",
                category="lint",
                path="",
                message=f"MegaLinter analyzer {analyzer} reported one or more blocking errors.",
                metadata={"log": str(log_path)},
            )
        )
    return findings


def _normalize_path(value: str | None, root: Path) -> str:
    if not value:
        return ""
    path = Path(value)
    if path.is_absolute():
        return _relative(path, root)
    return value.replace("\\", "/")


def _parse_semgrep(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for item in (payload or {}).get("results", []):
        extra = item.get("extra", {})
        start = item.get("start", {})
        findings.append(
            Finding(
                tool="semgrep",
                rule=item.get("check_id", "semgrep"),
                severity=extra.get("severity", "medium"),
                category="code",
                path=_normalize_path(item.get("path"), root),
                line=start.get("line"),
                column=start.get("col"),
                message=extra.get("message", "Semgrep finding."),
                metadata={"metadata": extra.get("metadata", {})},
            )
        )
    return findings


def _parse_gitleaks(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for item in payload or []:
        findings.append(
            Finding(
                tool="gitleaks",
                rule=item.get("RuleID", "gitleaks.secret"),
                severity="critical",
                category="secrets",
                path=_normalize_path(item.get("File"), root),
                line=item.get("StartLine"),
                message=item.get("Description") or "Secret detected by Gitleaks.",
                fingerprint=item.get("Fingerprint", ""),
                metadata={"commit": item.get("Commit")},
            )
        )
    return findings


def _parse_terrascan(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    results = (payload or {}).get("results", {})
    for item in results.get("violations") or []:
        findings.append(
            Finding(
                tool="terrascan",
                rule=item.get("rule_id") or item.get("rule_name") or "terrascan.iac",
                severity=item.get("severity") or "high",
                category="iac",
                path=_normalize_path(item.get("file"), root),
                line=item.get("line") if isinstance(item.get("line"), int) else None,
                message=item.get("description") or "Infrastructure-as-code issue detected by Terrascan.",
                metadata={
                    "ruleName": item.get("rule_name"),
                    "policyCategory": item.get("category"),
                    "resource": item.get("resource_name"),
                    "resourceType": item.get("resource_type"),
                    "module": item.get("module_name"),
                },
            )
        )
    for item in results.get("skipped_violations") or []:
        findings.append(
            Finding(
                tool="terrascan",
                rule=item.get("rule_id") or item.get("rule_name") or "terrascan.suppression",
                severity="high",
                category="policy-suppression",
                path=_normalize_path(item.get("file"), root),
                line=item.get("line") if isinstance(item.get("line"), int) else None,
                message="Project-controlled Terrascan suppression is not trusted.",
                metadata={
                    "ruleName": item.get("rule_name"),
                    "resource": item.get("resource_name"),
                    "suppressedByProject": True,
                },
            )
        )
    return findings


def _parse_trivy(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for result in (payload or {}).get("Results", []):
        target = _normalize_path(result.get("Target"), root)
        for vuln in result.get("Vulnerabilities", []) or []:
            suppressed = _trivy_item_suppressed(vuln)
            findings.append(
                Finding(
                    tool="trivy",
                    rule=vuln.get("VulnerabilityID", "trivy.vulnerability"),
                    severity="high" if suppressed else normalize_severity(vuln.get("Severity")),
                    category="policy-suppression" if suppressed else "vulnerability",
                    path=target,
                    message=(
                        "Project-controlled Trivy suppression is not trusted."
                        if suppressed
                        else vuln.get("Title") or vuln.get("Description") or "Vulnerability detected by Trivy."
                    ),
                    metadata={
                        "package": vuln.get("PkgName"),
                        "installedVersion": vuln.get("InstalledVersion"),
                        "fixedVersion": vuln.get("FixedVersion"),
                        "status": vuln.get("Status"),
                        "suppressedByProject": suppressed,
                    },
                )
            )
        for secret in result.get("Secrets", []) or []:
            suppressed = _trivy_item_suppressed(secret)
            findings.append(
                Finding(
                    tool="trivy",
                    rule=secret.get("RuleID", "trivy.secret"),
                    severity="high" if suppressed else normalize_severity(secret.get("Severity") or "critical"),
                    category="policy-suppression" if suppressed else "secrets",
                    path=target,
                    line=secret.get("StartLine"),
                    message=(
                        "Project-controlled Trivy suppression is not trusted."
                        if suppressed
                        else secret.get("Title") or "Secret detected by Trivy."
                    ),
                    metadata={"status": secret.get("Status"), "suppressedByProject": suppressed},
                )
            )
        for misconfig in result.get("Misconfigurations", []) or []:
            suppressed = _trivy_item_suppressed(misconfig)
            findings.append(
                Finding(
                    tool="trivy",
                    rule=misconfig.get("ID", "trivy.misconfiguration"),
                    severity="high" if suppressed else normalize_severity(misconfig.get("Severity")),
                    category="policy-suppression" if suppressed else "misconfiguration",
                    path=target,
                    message=(
                        "Project-controlled Trivy suppression is not trusted."
                        if suppressed
                        else misconfig.get("Title") or "Misconfiguration detected by Trivy."
                    ),
                    metadata={"status": misconfig.get("Status"), "suppressedByProject": suppressed},
                )
            )
    return findings


def _trivy_item_suppressed(item: dict[str, Any]) -> bool:
    status = str(item.get("Status", "")).upper()
    return status in {"EXCEPTION", "SUPPRESSED"} or item.get("IsSuppressed") is True


def _parse_checkov(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for item in _iter_checkov_failed_checks(payload):
        line_range = item.get("file_line_range") or []
        line = line_range[0] if isinstance(line_range, list) and line_range else None
        findings.append(
            Finding(
                tool="checkov",
                rule=item.get("check_id", "checkov.iac"),
                severity=normalize_severity(item.get("severity") or "medium"),
                category="iac",
                path=_normalize_checkov_path(item, root),
                line=line if isinstance(line, int) else None,
                message=item.get("check_name") or "Infrastructure-as-code issue detected by Checkov.",
                metadata={
                    "resource": item.get("resource"),
                    "guideline": item.get("guideline"),
                    "checkClass": item.get("check_class"),
                },
            )
        )
    for item in _iter_checkov_skipped_checks(payload):
        line_range = item.get("file_line_range") or []
        line = line_range[0] if isinstance(line_range, list) and line_range else None
        findings.append(
            Finding(
                tool="checkov",
                rule=item.get("check_id", "checkov.suppression"),
                severity="high",
                category="policy-suppression",
                path=_normalize_checkov_path(item, root),
                line=line if isinstance(line, int) else None,
                message="Project-controlled Checkov suppression is not trusted.",
                metadata={
                    "resource": item.get("resource"),
                    "suppressedByProject": True,
                    "suppressComment": item.get("suppress_comment"),
                },
            )
        )
    return findings


def _iter_checkov_failed_checks(payload: Any) -> Iterable[dict[str, Any]]:
    if isinstance(payload, list):
        for item in payload:
            yield from _iter_checkov_failed_checks(item)
        return
    if not isinstance(payload, dict):
        return
    results = payload.get("results")
    if isinstance(results, dict):
        failed = results.get("failed_checks") or []
        for item in failed:
            if isinstance(item, dict):
                yield item
    elif isinstance(results, list):
        for item in results:
            yield from _iter_checkov_failed_checks(item)
    failed = payload.get("failed_checks") or []
    for item in failed:
        if isinstance(item, dict):
            yield item


def _iter_checkov_skipped_checks(payload: Any) -> Iterable[dict[str, Any]]:
    if isinstance(payload, list):
        for item in payload:
            yield from _iter_checkov_skipped_checks(item)
        return
    if not isinstance(payload, dict):
        return
    results = payload.get("results")
    if isinstance(results, dict):
        skipped = results.get("skipped_checks") or []
        for item in skipped:
            if isinstance(item, dict):
                yield item
    elif isinstance(results, list):
        for item in results:
            yield from _iter_checkov_skipped_checks(item)
    skipped = payload.get("skipped_checks") or []
    for item in skipped:
        if isinstance(item, dict):
            yield item


def _normalize_checkov_path(item: dict[str, Any], root: Path) -> str:
    absolute = item.get("file_abs_path")
    if isinstance(absolute, str) and absolute:
        return _normalize_path(absolute, root)
    value = item.get("file_path")
    if isinstance(value, str) and value:
        return value.lstrip("/").replace("\\", "/")
    return ""


def _parse_osv(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for result in (payload or {}).get("results", []) or []:
        source = result.get("source", {})
        path = _normalize_path(source.get("path"), root)
        for package in result.get("packages", []) or []:
            package_name = (package.get("package") or {}).get("name")
            for vuln in package.get("vulnerabilities", []) or []:
                findings.append(
                    Finding(
                        tool="osv-scanner",
                        rule=vuln.get("id", "osv.vulnerability"),
                        severity=_osv_severity(vuln),
                        category="vulnerability",
                        path=path,
                        message=vuln.get("summary") or "Vulnerability detected by OSV-Scanner.",
                        metadata={"package": package_name},
                    )
                )
    return findings


def _osv_severity(vuln: dict[str, Any]) -> str:
    severities = vuln.get("severity") or []
    values = " ".join(str(item.get("score", "")) for item in severities if isinstance(item, dict))
    if "CRITICAL" in values.upper():
        return "critical"
    if "HIGH" in values.upper():
        return "high"
    if "LOW" in values.upper():
        return "low"
    return "medium"


def _parse_jscpd(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    duplicates = (payload or {}).get("duplicates", []) or []
    for item in duplicates:
        first = item.get("firstFile") or {}
        second = item.get("secondFile") or {}
        path = _normalize_path(first.get("name") or first.get("path"), root)
        second_path = _normalize_path(second.get("name") or second.get("path"), root)
        lines = item.get("lines") or item.get("fragment", {}).get("lines")
        findings.append(
            Finding(
                tool="jscpd",
                rule="duplication.block",
                severity="medium",
                category="duplication",
                path=path,
                line=_jscpd_line(first),
                message=f"Duplicated code block detected with {second_path}.",
                metadata={"lines": lines, "secondPath": second_path},
            )
        )
    return findings


def _jscpd_line(file_entry: dict[str, Any]) -> int | None:
    start = file_entry.get("start")
    if isinstance(start, int):
        return start
    if isinstance(start, dict):
        line = start.get("line")
        return line if isinstance(line, int) else None

    start_loc = file_entry.get("startLoc")
    if isinstance(start_loc, dict):
        line = start_loc.get("line")
        return line if isinstance(line, int) else None

    return None
