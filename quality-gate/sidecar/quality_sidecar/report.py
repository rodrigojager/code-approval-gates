from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .findings import Finding
from .policy import PolicyResult
from .tools import ToolResult


def build_report(
    *,
    target: Path,
    profile: str,
    mode: str,
    policy: PolicyResult,
    stack: dict[str, Any],
    findings: list[Finding],
    tool_results: list[ToolResult],
) -> dict[str, Any]:
    report = {
        "schemaVersion": "1.0.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "target": str(target),
        "status": policy.status,
        "exitCode": policy.exit_code,
        "profile": profile,
        "mode": mode,
        "score": {
            "value": round(policy.score, 2),
            "threshold": policy.threshold,
            "max": 100,
        },
        "summary": {
            "counts": policy.counts,
            "reasons": policy.reasons,
            "toolErrors": policy.tool_errors,
        },
        "stack": stack,
        "tools": [result.to_dict() for result in tool_results],
        "findings": [finding.to_dict() for finding in findings],
    }
    return report


def write_json_report(report: dict[str, Any], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "quality-report.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def write_markdown_report(report: dict[str, Any], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "quality-report.md"
    lines = [
        "# Quality Gate Report",
        "",
        f"Status: **{report['status']}**",
        f"Score: **{report['score']['value']} / 100**",
        f"Threshold: **{report['score']['threshold']}**",
        f"Mode: `{report['mode']}`",
        f"Profile: `{report['profile']}`",
        "",
    ]
    lines.extend(["## Reasons", ""])
    reasons = report["summary"].get("reasons") or []
    if reasons:
        lines.extend(f"- {reason}" for reason in reasons)
    else:
        lines.append("- No blocking policy reason.")

    lines.extend(["", "## Tools", ""])
    tools = report.get("tools") or []
    if tools:
        lines.append("| Tool | Status | Exit | Findings |")
        lines.append("| --- | --- | ---: | ---: |")
        for tool in tools:
            findings = (tool.get("summary") or {}).get("findings", 0)
            exit_code = tool.get("exit_code")
            lines.append(f"| {tool.get('name')} | {tool.get('status')} | {exit_code if exit_code is not None else ''} | {findings} |")
    else:
        lines.append("- No external tools were executed.")

    lines.extend(["", "## Findings", ""])
    findings = report.get("findings") or []
    if findings:
        lines.append("| Status | Severity | Category | Rule | Path | Message |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for finding in findings[:200]:
            location = finding.get("path") or ""
            if finding.get("line"):
                location = f"{location}:{finding['line']}"
            message = str(finding.get("message", "")).replace("|", "\\|")
            lines.append(
                f"| {finding.get('status')} | {finding.get('severity')} | {finding.get('category')} | "
                f"{finding.get('rule')} | {location} | {message} |"
            )
        if len(findings) > 200:
            lines.append(f"\nOnly first 200 findings shown. Full list is in quality-report.json.")
    else:
        lines.append("- No findings.")

    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
    return path
