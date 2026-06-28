from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .detectors import detect_builtin_findings, detect_stack
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

    stack = detect_stack(target)
    findings = detect_builtin_findings(
        target,
        include_pii=args.enable_pii,
        include_secrets=args.enable_secrets,
    )
    tool_results, tool_findings = run_external_tools(
        target,
        output_dir,
        args.mode,
        enable_secrets=args.enable_secrets,
        enable_iac=not (args.disable_iac or args.no_iac),
    )
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


def entrypoint(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "check":
        return run_check(args)
    parser.print_help()
    return 3


if __name__ == "__main__":
    raise SystemExit(entrypoint())
