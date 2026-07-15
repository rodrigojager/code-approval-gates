from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .detectors import detect_builtin_findings, detect_stack
from .evidence import analyze_dependency_graphs, analyze_evidence_reports, analyze_test_reports
from .metrics import (
    BUDGET_KEYS,
    analyze_change_requirements,
    analyze_quality_budgets,
    load_quality_policy,
    load_scope_manifest,
)
from .policy import apply_allowances, evaluate_policy
from .report import build_report, write_json_report, write_markdown_report
from .tools import run_coverage_check, run_external_tools
from .waivers import load_waivers


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="quality-sidecar")
    subparsers = parser.add_subparsers(dest="command")

    check = subparsers.add_parser("check", help="Run the quality gate against a workspace.")
    check.add_argument("target", nargs="?", default="/workspace")
    check.add_argument("--threshold", type=int, default=None)
    check.add_argument("--profile", choices=["relaxed", "standard", "strict"], default="standard")
    check.add_argument("--enable-pii", action="store_true")
    check.add_argument("--enable-secrets", action="store_true")
    check.add_argument("--disable-iac", action="store_true", help="Disable default Checkov IaC scanning.")
    check.add_argument("--no-iac", action="store_true", help=argparse.SUPPRESS)
    check.add_argument("--enable-coverage", action="store_true")
    check.add_argument("--coverage-report", action="append", default=[])
    check.add_argument("--min-line-coverage", type=float, default=80.0)
    check.add_argument("--min-branch-coverage", type=float, default=None)
    check.add_argument("--allow-pii", action="store_true")
    check.add_argument("--allow-secrets", action="store_true")
    check.add_argument("--allow-rule", action="append", default=[])
    check.add_argument("--allow-path", action="append", default=[])
    check.add_argument("--waiver", action="append", default=[])
    check.add_argument("--waiver-reason", default=None)
    check.add_argument("--waiver-expires", default=None)
    check.add_argument("--format", default="json,md")
    check.add_argument("--output", default=".quality/reports")
    check.add_argument("--fail-on-tool-error", action="store_true")
    check.add_argument("--mode", choices=["full", "quick", "offline"], default="full")
    check.add_argument("--policy-file", default=None)
    check.add_argument("--scope-manifest", default=None, help=argparse.SUPPRESS)
    check.add_argument("--disable-budgets", action="store_true")
    check.add_argument("--max-file-bytes", type=int, default=None)
    check.add_argument("--max-file-lines", type=int, default=None)
    check.add_argument("--max-scope-bytes", type=int, default=None)
    check.add_argument("--max-scope-lines", type=int, default=None)
    check.add_argument("--max-changed-files", type=int, default=None)
    check.add_argument("--max-changed-lines", type=int, default=None)
    check.add_argument("--max-diff-bytes", type=int, default=None)
    check.add_argument("--max-binary-files", type=int, default=None)
    check.add_argument("--hotspot-min-commits", type=int, default=None)
    check.add_argument("--hotspot-min-churn", type=int, default=None)
    check.add_argument("--dependency-graph", action="append", default=[])
    check.add_argument("--max-dependency-fan-in", type=int, default=None)
    check.add_argument("--max-dependency-fan-out", type=int, default=None)
    check.add_argument("--allow-dependency-cycles", action="store_true")
    check.add_argument("--evidence-report", action="append", default=[])
    check.add_argument("--test-report", action="append", default=[])
    check.add_argument("--min-tests", type=int, default=None)
    check.add_argument("--max-skipped-tests", type=int, default=None)
    check.add_argument("--max-skipped-percent", type=float, default=None)
    return parser


def resolve_output_path(target: Path, output: str) -> Path:
    output_path = Path(output)
    if output_path.is_absolute():
        return output_path
    return target / output_path


def run_check(args: argparse.Namespace) -> int:
    target = Path(args.target).resolve()
    if not target.exists() or not target.is_dir():
        print(f"Target directory not found: {target}", file=sys.stderr)
        return 3

    output_dir = resolve_output_path(target, args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        waivers = load_waivers(args.waiver, target)
    except Exception as error:  # noqa: BLE001 - report config errors as operational failures.
        print(f"Invalid waiver file: {error}", file=sys.stderr)
        return 3

    try:
        policy_config, policy_file = load_quality_policy(target, args.policy_file)
        scope_manifest = load_scope_manifest(target, args.scope_manifest)
        budget_overrides = {
            key: getattr(args, _camel_to_snake(key))
            for key in BUDGET_KEYS
        }
        metrics, findings = analyze_quality_budgets(
            target,
            scope=scope_manifest,
            profile=args.profile,
            policy=policy_config,
            overrides=budget_overrides,
            disabled=args.disable_budgets,
        )
        change_summary, change_findings = analyze_change_requirements(scope_manifest, policy_config)
        findings.extend(change_findings)
        metrics["changeRequirements"] = change_summary
        metrics["policyFile"] = policy_file

        tool_results, dependency_findings, dependency_summaries = analyze_dependency_graphs(
            target,
            args.dependency_graph,
            policy_config,
            profile=args.profile,
            max_fan_in=args.max_dependency_fan_in,
            max_fan_out=args.max_dependency_fan_out,
            allow_cycles=args.allow_dependency_cycles,
        )
        findings.extend(dependency_findings)
        metrics["dependencyGraphs"] = dependency_summaries

        evidence_results, evidence_findings, evidence_summary = analyze_evidence_reports(
            target, args.evidence_report, policy_config
        )
        tool_results.extend(evidence_results)
        findings.extend(evidence_findings)
        metrics["evidence"] = evidence_summary

        test_results, test_findings, test_summary = analyze_test_reports(
            target,
            args.test_report,
            policy_config,
            min_tests=args.min_tests,
            max_skipped_tests=args.max_skipped_tests,
            max_skipped_percent=args.max_skipped_percent,
        )
        tool_results.extend(test_results)
        findings.extend(test_findings)
        metrics["tests"] = test_summary
    except (OSError, ValueError) as error:
        print(f"Invalid quality policy or evidence configuration: {error}", file=sys.stderr)
        return 3

    stack = detect_stack(target)
    findings.extend(detect_builtin_findings(
        target,
        include_pii=args.enable_pii,
        include_secrets=args.enable_secrets,
    ))
    external_results, tool_findings = run_external_tools(
        target,
        output_dir,
        args.mode,
        enable_secrets=args.enable_secrets,
        enable_iac=not (args.disable_iac or args.no_iac),
    )
    tool_results.extend(external_results)
    findings.extend(tool_findings)

    if args.enable_coverage:
        coverage_result, coverage_findings = run_coverage_check(
            target,
            output_dir,
            report_paths=args.coverage_report,
            min_line_coverage=args.min_line_coverage,
            min_branch_coverage=args.min_branch_coverage,
        )
        tool_results.append(coverage_result)
        findings.extend(coverage_findings)

    apply_allowances(
        findings,
        allow_pii=args.allow_pii,
        allow_secrets=args.allow_secrets,
        allow_rules=args.allow_rule,
        allow_paths=args.allow_path,
        waivers=waivers,
        waiver_reason=args.waiver_reason,
        waiver_expires=args.waiver_expires,
    )

    policy = evaluate_policy(
        findings,
        tool_results,
        profile=args.profile,
        threshold=args.threshold,
        mode=args.mode,
        fail_on_tool_error=args.fail_on_tool_error,
    )

    report = build_report(
        target=target,
        profile=args.profile,
        mode=args.mode,
        policy=policy,
        stack=stack,
        findings=findings,
        tool_results=tool_results,
        metrics=metrics,
    )

    exit_code = policy.exit_code

    formats = {item.strip().lower() for item in args.format.split(",") if item.strip()}
    if not formats:
        formats = {"json", "md"}
    if "json" in formats:
        write_json_report(report, output_dir)
    if "md" in formats or "markdown" in formats:
        write_markdown_report(report, output_dir)

    print(f"{report['status']} score={report['score']['value']:.2f} threshold={report['score']['threshold']}")
    if report["summary"].get("reasons"):
        for reason in report["summary"]["reasons"]:
            print(f"- {reason}")
    print(f"Reports: {output_dir}")
    return exit_code


def _camel_to_snake(value: str) -> str:
    output = []
    for char in value:
        if char.isupper():
            output.extend(("_", char.lower()))
        else:
            output.append(char)
    return "".join(output)


def entrypoint(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "check":
        return run_check(args)
    parser.print_help()
    return 3


if __name__ == "__main__":
    raise SystemExit(entrypoint())
