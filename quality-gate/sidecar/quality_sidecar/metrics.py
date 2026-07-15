from __future__ import annotations

import fnmatch
import json
from pathlib import Path
from typing import Any

from .detectors import is_probably_text, iter_project_files, relative_path
from .findings import Finding


DEFAULT_POLICY_FILE = ".quality-gate-policy.json"

# Defaults catch clear outliers while remaining usable across stacks and monorepos.
PROFILE_BUDGETS: dict[str, dict[str, int]] = {
    "relaxed": {
        "maxFileBytes": 5 * 1024 * 1024,
        "maxFileLines": 10_000,
        "maxScopeBytes": 0,
        "maxScopeLines": 0,
        "maxChangedFiles": 250,
        "maxChangedLines": 50_000,
        "maxDiffBytes": 25 * 1024 * 1024,
        "maxBinaryFiles": 50,
        "hotspotMinCommits": 300,
        "hotspotMinChurn": 100_000,
    },
    "standard": {
        "maxFileBytes": 2 * 1024 * 1024,
        "maxFileLines": 5_000,
        "maxScopeBytes": 0,
        "maxScopeLines": 0,
        "maxChangedFiles": 100,
        "maxChangedLines": 20_000,
        "maxDiffBytes": 10 * 1024 * 1024,
        "maxBinaryFiles": 20,
        "hotspotMinCommits": 150,
        "hotspotMinChurn": 50_000,
    },
    "strict": {
        "maxFileBytes": 1024 * 1024,
        "maxFileLines": 2_000,
        "maxScopeBytes": 250 * 1024 * 1024,
        "maxScopeLines": 1_000_000,
        "maxChangedFiles": 50,
        "maxChangedLines": 10_000,
        "maxDiffBytes": 5 * 1024 * 1024,
        "maxBinaryFiles": 10,
        "hotspotMinCommits": 75,
        "hotspotMinChurn": 25_000,
    },
}
BUDGET_KEYS = tuple(PROFILE_BUDGETS["standard"])


def _under_root(root: Path, value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else root / path


def load_quality_policy(root: Path, policy_file: str | None) -> tuple[dict[str, Any], str | None]:
    explicit = bool(policy_file)
    path = _under_root(root, policy_file or DEFAULT_POLICY_FILE)
    if not path.exists():
        if explicit:
            raise ValueError(f"Policy file not found: {path}")
        return {}, None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Invalid quality policy {path}: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError(f"Invalid quality policy {path}: root value must be an object")
    if payload.get("schemaVersion", 1) != 1:
        raise ValueError(f"Unsupported quality policy schemaVersion: {payload.get('schemaVersion')}")
    return payload, relative_path(path, root)


def load_scope_manifest(root: Path, scope_manifest: str | None) -> dict[str, Any]:
    if not scope_manifest:
        return {}
    path = _under_root(root, scope_manifest)
    if not path.exists():
        raise ValueError(f"Scope manifest not found: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Invalid scope manifest {path}: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError(f"Invalid scope manifest {path}: root value must be an object")
    return payload


def resolve_budgets(
    profile: str,
    policy: dict[str, Any],
    overrides: dict[str, int | None],
    *,
    disabled: bool,
) -> dict[str, int]:
    configured = policy.get("budgets") or {}
    if not isinstance(configured, dict):
        raise ValueError("quality policy budgets must be an object")
    if disabled or configured.get("enabled") is False:
        return {key: 0 for key in BUDGET_KEYS}
    budgets = dict(PROFILE_BUDGETS.get(profile, PROFILE_BUDGETS["standard"]))
    for source in (configured, overrides):
        for key in BUDGET_KEYS:
            value = source.get(key)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value or value < 0:
                raise ValueError(f"Budget {key} must be a non-negative integer")
            budgets[key] = int(value)
    return budgets


def _line_count(path: Path) -> int | None:
    if not is_probably_text(path):
        return None
    try:
        count = 0
        last = b""
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                count += chunk.count(b"\n")
                last = chunk[-1:]
        return count + (1 if last and last != b"\n" else 0)
    except OSError:
        return None


def collect_file_metrics(root: Path) -> tuple[list[dict[str, Any]], dict[str, int]]:
    files: list[dict[str, Any]] = []
    totals = {"files": 0, "bytes": 0, "textFiles": 0, "binaryFiles": 0, "lines": 0}
    for path in iter_project_files(root):
        try:
            size = path.stat().st_size
        except OSError:
            continue
        lines = _line_count(path)
        files.append({"path": relative_path(path, root), "sizeBytes": size, "lines": lines, "binary": lines is None})
        totals["files"] += 1
        totals["bytes"] += size
        if lines is None:
            totals["binaryFiles"] += 1
        else:
            totals["textFiles"] += 1
            totals["lines"] += lines
    return files, totals


def _finding(rule: str, value: int, limit: int, message: str, path: str = "", **metadata: Any) -> Finding:
    return Finding(
        tool="quality-budget",
        rule=rule,
        severity="high" if limit and value >= limit * 2 else "medium",
        category="quality-budget",
        path=path,
        message=message,
        metadata={"observed": value, "limit": limit, **metadata},
    )


def _exceeds(value: int | None, limit: int) -> bool:
    return limit > 0 and value is not None and value > limit


def analyze_quality_budgets(
    root: Path,
    *,
    scope: dict[str, Any],
    profile: str,
    policy: dict[str, Any],
    overrides: dict[str, int | None],
    disabled: bool = False,
) -> tuple[dict[str, Any], list[Finding]]:
    budgets = resolve_budgets(profile, policy, overrides, disabled=disabled)
    files, totals = collect_file_metrics(root)
    findings: list[Finding] = []
    for item in files:
        size, lines, file_path = int(item["sizeBytes"]), item["lines"], str(item["path"])
        if _exceeds(size, budgets["maxFileBytes"]):
            findings.append(_finding("budget.file-bytes", size, budgets["maxFileBytes"], f"File size {size} bytes exceeds budget {budgets['maxFileBytes']}.", file_path))
        if isinstance(lines, int) and _exceeds(lines, budgets["maxFileLines"]):
            findings.append(_finding("budget.file-lines", lines, budgets["maxFileLines"], f"File length {lines} lines exceeds budget {budgets['maxFileLines']}.", file_path))
    if _exceeds(totals["bytes"], budgets["maxScopeBytes"]):
        findings.append(_finding("budget.scope-bytes", totals["bytes"], budgets["maxScopeBytes"], f"Scoped content size {totals['bytes']} bytes exceeds budget {budgets['maxScopeBytes']}."))
    if _exceeds(totals["lines"], budgets["maxScopeLines"]):
        findings.append(_finding("budget.scope-lines", totals["lines"], budgets["maxScopeLines"], f"Scoped content length {totals['lines']} lines exceeds budget {budgets['maxScopeLines']}."))

    scope_kind = str(scope.get("scope") or "full")
    diff = scope.get("diff") if isinstance(scope.get("diff"), dict) else {}
    change = {
        "status": diff.get("status", "unavailable"),
        "files": int(diff.get("fileCount") or scope.get("selectedFileCount") or 0),
        "additions": int(diff.get("additions") or 0),
        "deletions": int(diff.get("deletions") or 0),
        "changedLines": int(diff.get("changedLines") or 0),
        "patchBytes": int(diff.get("patchBytes") or 0),
        "binaryFiles": int(diff.get("binaryFiles") or 0),
    }
    if scope_kind == "changed" and change["status"] in {"available", "partial"}:
        checks = (
            ("maxChangedFiles", "files", "budget.changed-files", "Changed file count"),
            ("maxChangedLines", "changedLines", "budget.changed-lines", "Changed line count"),
            ("maxDiffBytes", "patchBytes", "budget.diff-bytes", "Diff size"),
            ("maxBinaryFiles", "binaryFiles", "budget.binary-files", "Changed binary file count"),
        )
        for budget_key, metric_key, rule, label in checks:
            value, limit = int(change[metric_key]), budgets[budget_key]
            if _exceeds(value, limit):
                findings.append(_finding(rule, value, limit, f"{label} {value} exceeds budget {limit}."))

    file_map = {str(item["path"]): item for item in files}
    history = scope.get("history") if isinstance(scope.get("history"), dict) else {}
    history_files = history.get("files") if isinstance(history.get("files"), dict) else {}
    hotspot_count = 0
    min_commits, min_churn = budgets["hotspotMinCommits"], budgets["hotspotMinChurn"]
    if min_commits and min_churn:
        for file_path, raw in history_files.items():
            if not isinstance(raw, dict):
                continue
            commits, churn = int(raw.get("commits") or 0), int(raw.get("churn") or 0)
            if commits < min_commits or churn < min_churn:
                continue
            hotspot_count += 1
            findings.append(Finding(
                tool="quality-budget",
                rule="budget.change-hotspot",
                severity="high",
                category="quality-budget",
                path=str(file_path),
                message=f"Changed file is a hotspot with {commits} commits and {churn} historical changed lines.",
                metadata={"commits": commits, "churn": churn, "currentLines": (file_map.get(str(file_path)) or {}).get("lines"), "minCommits": min_commits, "minChurn": min_churn},
            ))

    metrics = {
        "budgets": budgets,
        "scope": scope_kind,
        "totals": totals,
        "change": change,
        "hotspots": {"count": hotspot_count, "historyStatus": history.get("status", "unavailable")},
        "largestFiles": sorted(files, key=lambda item: int(item["sizeBytes"]), reverse=True)[:20],
        "largestTextFiles": sorted((item for item in files if isinstance(item["lines"], int)), key=lambda item: int(item["lines"]), reverse=True)[:20],
    }
    return metrics, findings


def _matches(path: str, pattern: str) -> bool:
    path, pattern = path.replace("\\", "/"), pattern.replace("\\", "/").lstrip("./")
    if "/" not in pattern:
        return any(fnmatch.fnmatch(part, pattern) for part in path.split("/"))
    return fnmatch.fnmatch(path, pattern)


def analyze_change_requirements(scope: dict[str, Any], policy: dict[str, Any]) -> tuple[dict[str, Any], list[Finding]]:
    rules = policy.get("changeRequirements") or []
    if not isinstance(rules, list):
        raise ValueError("quality policy changeRequirements must be an array")
    if str(scope.get("scope") or "full") != "changed":
        return {"configured": len(rules), "evaluated": 0, "triggered": 0, "scope": "not-changed"}, []
    selected = scope.get("selectedFiles") or []
    files = [str(item).replace("\\", "/") for item in selected] if isinstance(selected, list) else []
    findings: list[Finding] = []
    evaluated = triggered = 0
    for index, rule in enumerate(rules):
        if not isinstance(rule, dict):
            raise ValueError(f"changeRequirements[{index}] must be an object")
        rule_id = str(rule.get("id") or f"rule-{index + 1}")
        fields = {name: rule.get(name) or [] for name in ("whenAny", "requireAny", "requireAll", "unlessAny")}
        if not fields["whenAny"] and isinstance(rule.get("when"), list):
            fields["whenAny"] = rule["when"]
        if any(not isinstance(items, list) or not all(isinstance(item, str) for item in items) for items in fields.values()):
            raise ValueError(f"changeRequirements[{index}] patterns must be arrays of strings")
        if not fields["whenAny"] or (not fields["requireAny"] and not fields["requireAll"]):
            raise ValueError(f"changeRequirements[{index}] needs whenAny and requireAny or requireAll")
        evaluated += 1
        trigger_files = [file for file in files if any(_matches(file, pattern) for pattern in fields["whenAny"])]
        if not trigger_files or any(_matches(file, pattern) for file in files for pattern in fields["unlessAny"]):
            continue
        any_ok = not fields["requireAny"] or any(_matches(file, pattern) for file in files for pattern in fields["requireAny"])
        missing_all = [pattern for pattern in fields["requireAll"] if not any(_matches(file, pattern) for file in files)]
        if any_ok and not missing_all:
            continue
        triggered += 1
        findings.append(Finding(
            tool="change-policy",
            rule=f"change-requirement.{rule_id}",
            severity=str(rule.get("severity") or "high"),
            category="change-policy",
            path=trigger_files[0],
            message=str(rule.get("message") or "Required companion change is missing."),
            metadata={"triggerFiles": trigger_files, "requireAny": fields["requireAny"], "missingRequireAll": missing_all},
        ))
    return {"configured": len(rules), "evaluated": evaluated, "triggered": triggered, "scope": "changed"}, findings
