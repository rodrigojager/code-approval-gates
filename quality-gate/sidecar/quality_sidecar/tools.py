from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

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
            env={**os.environ, **(env or {})},
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


def run_external_tools(
    root: Path,
    reports_dir: Path,
    mode: str,
    *,
    enable_secrets: bool = False,
    enable_iac: bool = True,
) -> tuple[list[ToolResult], list[Finding]]:
    if mode in {"quick", "offline"}:
        return [], []

    raw_dir = reports_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    results: list[ToolResult] = []
    findings: list[Finding] = []
    iac_files = detect_iac_files(root)

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

    for name, runner in tool_specs:
        result = runner(root, raw_dir)
        parsed_findings = parse_tool_findings(name, result, root)
        if parsed_findings and result.status == "ok":
            result.status = "findings"
        result.summary["findings"] = len(parsed_findings)
        results.append(result)
        findings.extend(parsed_findings)

    test_result, test_findings = run_project_tests(root, raw_dir)
    if test_result:
        results.append(test_result)
        findings.extend(test_findings)

    return results, findings


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
        "FILTER_REGEX_EXCLUDE": r"(\.quality/|node_modules/|coverage/|dist/|tmp/)",
    }
    return run_command(
        "megalinter",
        command,
        raw_dir,
        cwd=root,
        env=env,
        acceptable_exit_codes={0, 1},
        output_path=raw_dir / "megalinter",
    )


def _run_semgrep(root: Path, raw_dir: Path) -> ToolResult:
    output = raw_dir / "semgrep.json"
    return run_command(
        "semgrep",
        ["semgrep", "scan", "--config=auto", "--json", "--output", str(output), str(root)],
        raw_dir,
        cwd=root,
        acceptable_exit_codes={0, 1},
        output_path=output,
    )


def _run_gitleaks(root: Path, raw_dir: Path) -> ToolResult:
    output = raw_dir / "gitleaks.json"
    return run_command(
        "gitleaks",
        [
            "gitleaks",
            "detect",
            "--source",
            str(root),
            "--report-format",
            "json",
            "--report-path",
            str(output),
            "--no-git",
        ],
        raw_dir,
        cwd=root,
        acceptable_exit_codes={0, 1},
        output_path=output,
    )


def _run_trivy(root: Path, raw_dir: Path, *, enable_secrets: bool) -> ToolResult:
    output = raw_dir / "trivy.json"
    scanners = "vuln,misconfig,secret" if enable_secrets else "vuln,misconfig"
    return run_command(
        "trivy",
        [
            "trivy",
            "fs",
            "--scanners",
            scanners,
            "--format",
            "json",
            "--output",
            str(output),
            "--exit-code",
            "0",
            str(root),
        ],
        raw_dir,
        cwd=root,
        acceptable_exit_codes={0},
        output_path=output,
    )


def _run_checkov(root: Path, raw_dir: Path, iac_files: list[str]) -> ToolResult:
    output = raw_dir / "checkov.json"
    result = run_command(
        "checkov",
        ["checkov", "-d", str(root), "-o", "json", "--quiet"],
        raw_dir,
        cwd=root,
        acceptable_exit_codes={0, 1},
        output_path=output,
    )
    stdout_path = Path(result.stdout_path) if result.stdout_path else None
    if stdout_path and stdout_path.exists():
        output.write_text(stdout_path.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
    result.summary["iacFiles"] = len(iac_files)
    result.summary["iacFileSamples"] = iac_files[:20]
    return result


def _run_osv_scanner(root: Path, raw_dir: Path) -> ToolResult:
    output = raw_dir / "osv-scanner.json"
    result = run_command(
        "osv-scanner",
        ["osv-scanner", "--recursive", "--format", "json", str(root)],
        raw_dir,
        cwd=root,
        acceptable_exit_codes={0, 1},
        output_path=output,
    )
    stdout_path = Path(result.stdout_path) if result.stdout_path else None
    if stdout_path and stdout_path.exists():
        output.write_text(stdout_path.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
    stderr_path = Path(result.stderr_path) if result.stderr_path else None
    stderr_text = stderr_path.read_text(encoding="utf-8", errors="replace") if stderr_path and stderr_path.exists() else ""
    if result.status == "error" and "No package sources found" in stderr_text:
        output.write_text('{"results":[]}\n', encoding="utf-8")
        result.status = "ok"
        result.exit_code = 0
        result.error = None
    return result


def _run_jscpd(root: Path, raw_dir: Path) -> ToolResult:
    output_dir = raw_dir / "jscpd"
    result = run_command(
        "jscpd",
        [
            "jscpd",
            "--silent",
            "--reporters",
            "json",
            "--ignore",
            "**/.quality/**,**/node_modules/**,.quality/**,node_modules/**",
            "--output",
            str(output_dir),
            ".",
        ],
        raw_dir,
        cwd=root,
        acceptable_exit_codes={0, 1},
        output_path=output_dir / "jscpd-report.json",
    )
    report = output_dir / "jscpd-report.json"
    if not report.exists():
        matches = list(output_dir.rglob("*.json")) if output_dir.exists() else []
        if matches:
            result.output_path = str(matches[0])
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


def run_project_tests(root: Path, raw_dir: Path) -> tuple[ToolResult | None, list[Finding]]:
    package_json = root / "package.json"
    if package_json.exists() and shutil.which("npm"):
        result = run_command(
            "project-tests",
            ["npm", "test", "--if-present"],
            raw_dir,
            cwd=root,
            acceptable_exit_codes={0, 1},
        )
        findings = []
        if result.exit_code not in {None, 0}:
            result.status = "findings"
            findings.append(
                Finding(
                    tool="project-tests",
                    rule="tests.failed",
                    severity="high",
                    category="tests",
                    path="package.json",
                    message="Project test command failed.",
                )
            )
        return result, findings

    pyproject = root / "pyproject.toml"
    tests_dir = root / "tests"
    if pyproject.exists() and tests_dir.exists() and shutil.which("python"):
        result = run_command(
            "project-tests",
            ["python", "-m", "unittest", "discover"],
            raw_dir,
            cwd=root,
            acceptable_exit_codes={0, 1},
        )
        findings = []
        if result.exit_code not in {None, 0}:
            result.status = "findings"
            findings.append(
                Finding(
                    tool="project-tests",
                    rule="tests.failed",
                    severity="high",
                    category="tests",
                    path="tests",
                    message="Python unittest discovery failed.",
                )
            )
        return result, findings

    return None, []


def parse_json(path: str | None) -> Any | None:
    if not path:
        return None
    try:
        file_path = Path(path)
        if file_path.is_dir():
            matches = sorted(file_path.rglob("*.json"))
            file_path = matches[0] if matches else file_path
        if not file_path.exists() or file_path.is_dir():
            return None
        text = file_path.read_text(encoding="utf-8", errors="replace").strip()
        if not text:
            return None
        return json.loads(text)
    except (OSError, json.JSONDecodeError):
        return None


def parse_tool_findings(name: str, result: ToolResult, root: Path) -> list[Finding]:
    if result.status in {"missing", "timeout", "error"}:
        return []
    if name == "semgrep":
        return _parse_semgrep(parse_json(result.output_path), root)
    if name == "gitleaks":
        return _parse_gitleaks(parse_json(result.output_path), root)
    if name == "trivy":
        return _parse_trivy(parse_json(result.output_path), root)
    if name == "checkov":
        return _parse_checkov(parse_json(result.output_path), root)
    if name == "osv-scanner":
        return _parse_osv(parse_json(result.output_path), root)
    if name == "jscpd":
        return _parse_jscpd(parse_json(result.output_path), root)
    return []


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


def _parse_trivy(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for result in (payload or {}).get("Results", []):
        target = _normalize_path(result.get("Target"), root)
        for vuln in result.get("Vulnerabilities", []) or []:
            findings.append(
                Finding(
                    tool="trivy",
                    rule=vuln.get("VulnerabilityID", "trivy.vulnerability"),
                    severity=normalize_severity(vuln.get("Severity")),
                    category="vulnerability",
                    path=target,
                    message=vuln.get("Title") or vuln.get("Description") or "Vulnerability detected by Trivy.",
                    metadata={
                        "package": vuln.get("PkgName"),
                        "installedVersion": vuln.get("InstalledVersion"),
                        "fixedVersion": vuln.get("FixedVersion"),
                    },
                )
            )
        for secret in result.get("Secrets", []) or []:
            findings.append(
                Finding(
                    tool="trivy",
                    rule=secret.get("RuleID", "trivy.secret"),
                    severity=normalize_severity(secret.get("Severity") or "critical"),
                    category="secrets",
                    path=target,
                    line=secret.get("StartLine"),
                    message=secret.get("Title") or "Secret detected by Trivy.",
                )
            )
        for misconfig in result.get("Misconfigurations", []) or []:
            findings.append(
                Finding(
                    tool="trivy",
                    rule=misconfig.get("ID", "trivy.misconfiguration"),
                    severity=normalize_severity(misconfig.get("Severity")),
                    category="misconfiguration",
                    path=target,
                    message=misconfig.get("Title") or "Misconfiguration detected by Trivy.",
                )
            )
    return findings


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
