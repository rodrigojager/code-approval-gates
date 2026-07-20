from __future__ import annotations

import argparse
import contextlib
import fnmatch
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import tarfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Sequence

from .cli import entrypoint as sidecar_entrypoint
from .i18n import normalize_locale, translate
from .metrics import PROFILE_BUDGETS


OPERATIONAL_ERROR = 3
MIN_THRESHOLD = 90
LARGE_DIFF_LIMIT = 64 * 1024 * 1024
DEFAULT_IGNORES = (
    ".git/",
    ".quality/",
)
SUPPORT_FILES = (
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "tsconfig.json",
    "pyproject.toml",
    "requirements.txt",
    "Directory.Build.props",
    "Directory.Build.targets",
    "Directory.Packages.props",
    "global.json",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    ".gitignore",
    "README.md",
)
ANCESTOR_SUPPORT_NAMES = (
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "tsconfig.json",
    "pyproject.toml",
    "requirements.txt",
    "poetry.lock",
    "Pipfile",
    "Pipfile.lock",
    "go.mod",
    "go.sum",
    "Cargo.toml",
    "Cargo.lock",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "gradle.properties",
    "composer.json",
    "composer.lock",
    "Gemfile",
    "Gemfile.lock",
    "Directory.Build.props",
    "Directory.Build.targets",
    "Directory.Packages.props",
    "packages.lock.json",
    "NuGet.config",
    "nuget.config",
    "global.json",
)
ANCESTOR_SUPPORT_GLOBS = ("*.sln", "*.slnx", "*.csproj", "*.fsproj", "*.vbproj")
SENSITIVE_ENV_NAMES = {
    "CI_JOB_TOKEN",
    "CI_JOB_JWT",
    "CI_JOB_JWT_V2",
    "CI_REPOSITORY_URL",
    "CI_REGISTRY_PASSWORD",
    "DOCKER_AUTH_CONFIG",
    "DOCKER_CONFIG",
    "GIT_ASKPASS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_SYSTEM",
    "GIT_EXTERNAL_DIFF",
    "GITHUB_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "MEGALINTER_COMMAND",
    "NETRC",
    "NPM_CONFIG_USERCONFIG",
    "SSH_ASKPASS",
}
SENSITIVE_ENV_MARKERS = (
    "TOKEN",
    "PASSWORD",
    "SECRET",
    "CREDENTIAL",
    "PRIVATE_KEY",
    "ACCESS_KEY",
    "API_KEY",
)


class CiConfigurationError(ValueError):
    """Configuration or source-state error that must fail closed."""


@dataclass(frozen=True)
class ScopeResolution:
    manifest: dict[str, Any]
    scan_target: Path
    projection_root: Path | None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="quality-ci",
        description="Fail-closed, container-native Quality Gate entrypoint for GitLab CI.",
    )
    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser(
        "check",
        help="Run the fixed, fail-closed GitLab changed-scope contract without project-controlled flags.",
    )
    return parser


def _run_git(target: Path, args: Sequence[str], *, binary: bool = False) -> subprocess.CompletedProcess[Any]:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=target,
            capture_output=True,
            text=not binary,
            encoding=None if binary else "utf-8",
            errors=None if binary else "replace",
            check=False,
            timeout=60,
        )
    except subprocess.TimeoutExpired as error:
        raise CiConfigurationError(f"git {' '.join(args[:3])} timed out after 60 seconds") from error
    if result.returncode != 0:
        raw_error = result.stderr if not binary else result.stderr.decode("utf-8", errors="replace")
        detail = str(raw_error or "git command failed").strip()[:500]
        raise CiConfigurationError(f"git {' '.join(args[:3])} failed: {detail}")
    return result


def _verify_commit(target: Path, ref: str, label: str) -> str:
    if not ref or ref.startswith("-") or any(character in ref for character in "\r\n\0"):
        raise CiConfigurationError(f"Invalid {label} Git ref.")
    result = _run_git(target, ["rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}"])
    sha = result.stdout.strip()
    if len(sha) != 40:
        raise CiConfigurationError(f"Unable to resolve {label} Git ref.")
    return sha


def _trusted_checkout() -> tuple[Path, str]:
    """Derive the checkout and commit from Git, never from CI path/SHA inputs."""
    current = Path.cwd().resolve()
    if not current.is_dir():
        raise CiConfigurationError("Current working directory is not available.")
    result = _run_git(current, ["rev-parse", "--show-toplevel"])
    raw_root = result.stdout.strip()
    if not raw_root:
        raise CiConfigurationError("Git did not return a checkout root.")
    target = Path(raw_root).resolve()
    try:
        current.relative_to(target)
    except ValueError as error:
        raise CiConfigurationError("Current working directory is outside the Git checkout root.") from error

    head_sha = _verify_commit(target, "HEAD", "checkout")
    declared_project = os.environ.get("CI_PROJECT_DIR")
    if declared_project and Path(declared_project).resolve() != target:
        raise CiConfigurationError("CI_PROJECT_DIR does not match the checkout derived from Git.")
    declared_commit = os.environ.get("CI_COMMIT_SHA")
    if declared_commit and declared_commit.strip().lower() != head_sha.lower():
        raise CiConfigurationError("CI_COMMIT_SHA does not match the checked-out HEAD.")
    return target, head_sha


def _governed_base_ref(target: Path, scope: str) -> tuple[str | None, str | None]:
    if scope != "changed":
        return None, None
    branch = os.environ.get("CODE_APPROVAL_QUALITY_TARGET_BRANCH", "")
    if (
        not branch
        or branch != branch.strip()
        or branch.startswith(("-", "/"))
        or branch.endswith(("/", "."))
        or ".." in branch
        or "@{" in branch
        or any(character in branch for character in " ~^:?*[\\\r\n\0")
    ):
        raise CiConfigurationError(
            "changed scope requires a valid centrally governed CODE_APPROVAL_QUALITY_TARGET_BRANCH."
        )
    declared_target = os.environ.get("CI_MERGE_REQUEST_TARGET_BRANCH_NAME")
    if declared_target and declared_target != branch:
        raise CiConfigurationError(
            "The GitLab Merge Request target does not match CODE_APPROVAL_QUALITY_TARGET_BRANCH."
        )
    ref = f"refs/remotes/origin/{branch}"
    _verify_commit(target, ref, "governed target branch")
    return ref, branch


def _git_output_size(target: Path, args: Sequence[str], limit: int = LARGE_DIFF_LIMIT) -> int:
    process = subprocess.Popen(
        ["git", *args],
        cwd=target,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdout is not None
    size = 0
    while chunk := process.stdout.read(1024 * 1024):
        size += len(chunk)
        if size > limit:
            process.kill()
            process.communicate()
            return limit + 1
    _, stderr = process.communicate()
    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()[:500]
        raise CiConfigurationError(f"git {' '.join(args[:3])} failed: {detail or 'git command failed'}")
    return size


def _normalize_path(value: str) -> str:
    normalized = value.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized.lstrip("/")


def _validate_relative_path(value: str) -> str:
    normalized = _normalize_path(value).strip("/")
    candidate = Path(normalized)
    if not normalized or candidate.is_absolute() or ".." in candidate.parts:
        raise CiConfigurationError(f"Path must stay inside the checkout: {value}")
    return normalized


def _matches_ignore(path: str, pattern: str) -> bool:
    path = _normalize_path(path)
    pattern = _normalize_path(pattern)
    if pattern.endswith("/"):
        component = pattern.rstrip("/")
        return path == component or path.startswith(f"{component}/") or f"/{component}/" in f"/{path}/"
    if "/" not in pattern:
        return any(fnmatch.fnmatch(component, pattern) for component in path.split("/"))
    return fnmatch.fnmatch(path, pattern)


def _filter_files(files: Sequence[str], paths: Sequence[str]) -> list[str]:
    normalized_paths = [_validate_relative_path(item) for item in paths]
    result: list[str] = []
    for raw in files:
        file_path = _normalize_path(raw)
        if not file_path or any(_matches_ignore(file_path, pattern) for pattern in DEFAULT_IGNORES):
            continue
        if normalized_paths and not any(file_path == prefix or file_path.startswith(f"{prefix}/") for prefix in normalized_paths):
            continue
        if file_path not in result:
            result.append(file_path)
    return sorted(result)


def _null_paths(payload: bytes) -> list[str]:
    return [item.decode("utf-8", errors="surrogateescape") for item in payload.split(b"\0") if item]


def _batches(items: Sequence[str], size: int = 100) -> Iterator[list[str]]:
    for index in range(0, len(items), size):
        yield list(items[index:index + size])


def _diff_metrics(target: Path, base: str, head: str, selected: Sequence[str]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    entries: dict[str, dict[str, int | bool]] = {}
    patch_bytes = 0
    commands: list[dict[str, Any]] = []
    spec = f"{base}...{head}"
    for batch in _batches(selected):
        numstat_args = ["diff", "--numstat", "--no-ext-diff", "--no-renames", spec, "--", *batch]
        numstat = _run_git(target, numstat_args)
        commands.append({"command": "git diff --numstat --no-ext-diff --no-renames <base>...<head> -- <selected-files>", "exitCode": 0})
        for line in numstat.stdout.splitlines():
            parts = line.split("\t", 2)
            if len(parts) != 3:
                continue
            additions, deletions, raw_path = parts
            path = _normalize_path(raw_path)
            if path not in selected:
                continue
            binary = additions == "-" or deletions == "-"
            entries[path] = {
                "additions": 0 if binary else int(additions),
                "deletions": 0 if binary else int(deletions),
                "binary": binary,
            }
        patch_args = ["diff", "--binary", "--no-ext-diff", "--no-renames", spec, "--", *batch]
        if patch_bytes <= LARGE_DIFF_LIMIT:
            patch_bytes += _git_output_size(target, patch_args)
        commands.append({"command": "git diff --binary --no-ext-diff --no-renames <base>...<head> -- <selected-files>", "exitCode": 0})

    additions = sum(int(item["additions"]) for item in entries.values())
    deletions = sum(int(item["deletions"]) for item in entries.values())
    binary_files = sum(1 for item in entries.values() if item["binary"])
    return ({
        "status": "available",
        "base": base,
        "head": head,
        "fileCount": len(selected),
        "additions": additions,
        "deletions": deletions,
        "changedLines": additions + deletions,
        "patchBytes": patch_bytes,
        "binaryFiles": binary_files,
        "files": entries,
        "commands": commands,
    }, commands)


def _history_metrics(target: Path, selected: Sequence[str]) -> dict[str, Any]:
    metrics: dict[str, dict[str, Any]] = {
        path: {"commits": 0, "additions": 0, "deletions": 0, "churn": 0}
        for path in selected[:500]
    }
    for batch in _batches(list(metrics), 50):
        result = _run_git(target, ["log", "--max-count=500", "--format=commit:%H", "--numstat", "--no-renames", "--", *batch])
        commits: dict[str, set[str]] = {path: set() for path in batch}
        current_commit = ""
        for line in result.stdout.splitlines():
            if line.startswith("commit:"):
                current_commit = line.removeprefix("commit:").strip()
                continue
            parts = line.split("\t", 2)
            if len(parts) != 3 or parts[0] == "-" or parts[1] == "-":
                continue
            path = _normalize_path(parts[2])
            if path not in metrics:
                continue
            metrics[path]["additions"] += int(parts[0])
            metrics[path]["deletions"] += int(parts[1])
            if current_commit:
                commits[path].add(current_commit)
        for path, values in commits.items():
            metrics[path]["commits"] = len(values)
            metrics[path]["churn"] = metrics[path]["additions"] + metrics[path]["deletions"]
    return {
        "status": "available",
        "commitLimit": 500,
        "fileLimit": 500,
        "truncatedFiles": max(0, len(selected) - len(metrics)),
        "files": metrics,
    }


def _tracked_files(target: Path, paths: Sequence[str]) -> list[str]:
    args = ["ls-files", "-c", "-z"]
    if paths:
        args.extend(["--", *[_validate_relative_path(item) for item in paths]])
    result = _run_git(target, args, binary=True)
    return _null_paths(result.stdout)


def _archive_projection(target: Path, head_sha: str, files: Sequence[str]) -> tuple[Path, Path, list[str]]:
    """Materialize regular files from the trusted commit tree, not the worktree."""
    projection_root = target / ".quality" / "scopes" / f"quality-ci-{uuid.uuid4().hex}"
    _reject_symlink_components(target, projection_root.parent)
    workspace = projection_root / "workspace"
    workspace.mkdir(parents=True, exist_ok=False)
    requested = sorted(dict.fromkeys(_validate_relative_path(item) for item in files))
    requested_set = set(requested)
    copied: set[str] = set()
    try:
        for batch in _batches(requested):
            process = subprocess.Popen(
                ["git", "archive", "--format=tar", head_sha, "--", *batch],
                cwd=target,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            assert process.stdout is not None
            assert process.stderr is not None
            try:
                with tarfile.open(fileobj=process.stdout, mode="r|*") as archive:
                    for member in archive:
                        relative = _normalize_path(member.name).rstrip("/")
                        if member.isdir():
                            continue
                        if relative not in requested_set:
                            raise CiConfigurationError(
                                f"Git archive returned an unexpected scoped path: {relative}"
                            )
                        if member.issym() or member.islnk():
                            raise CiConfigurationError(f"Scoped source symlinks are not allowed: {relative}")
                        if not member.isfile():
                            raise CiConfigurationError(f"Scoped source is not a regular file: {relative}")
                        destination = workspace / _validate_relative_path(relative)
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        source = archive.extractfile(member)
                        if source is None:
                            raise CiConfigurationError(f"Unable to read scoped source from Git: {relative}")
                        with source, destination.open("xb") as handle:
                            shutil.copyfileobj(source, handle)
                        copied.add(relative)
                stderr = process.stderr.read()
                return_code = process.wait(timeout=60)
                if return_code != 0:
                    detail = stderr.decode("utf-8", errors="replace").strip()[:500]
                    raise CiConfigurationError(f"git archive failed: {detail or 'git command failed'}")
            except Exception:
                if process.poll() is None:
                    process.kill()
                process.communicate()
                raise
            finally:
                process.stdout.close()
                process.stderr.close()
        missing = sorted(requested_set - copied)
        if missing:
            raise CiConfigurationError(f"Scoped files are unavailable in the requested commit: {missing[0]}")
        return projection_root, workspace, sorted(copied)
    except Exception:
        shutil.rmtree(projection_root, ignore_errors=True)
        raise


def _discover_support_files(target: Path, selected: Sequence[str]) -> list[str]:
    candidates = {path for path in SUPPORT_FILES if (target / path).is_file()}
    ancestors: set[Path] = {target}
    resolved_target = target.resolve()
    for relative in selected:
        current = (target / relative).parent.resolve()
        while True:
            try:
                current.relative_to(resolved_target)
            except ValueError:
                break
            ancestors.add(current)
            if current == resolved_target:
                break
            current = current.parent
    for directory in ancestors:
        for name in ANCESTOR_SUPPORT_NAMES:
            candidate = directory / name
            if candidate.is_file():
                candidates.add(_normalize_path(str(candidate.relative_to(target))))
        for pattern in ANCESTOR_SUPPORT_GLOBS:
            for candidate in directory.glob(pattern):
                if candidate.is_file():
                    candidates.add(_normalize_path(str(candidate.relative_to(target))))
    return sorted(path for path in candidates if path not in selected)


def resolve_scope(
    target: Path,
    scope: str,
    base_ref: str | None,
    head_ref: str | None,
    paths: Sequence[str],
    *,
    excluded_untracked_count: int = 0,
) -> ScopeResolution:
    _run_git(target, ["rev-parse", "--is-inside-work-tree"])
    checkout_sha = _verify_commit(target, "HEAD", "checkout")
    head_sha = _verify_commit(target, head_ref or "HEAD", "head")
    if checkout_sha != head_sha:
        raise CiConfigurationError("The checked-out HEAD does not match the requested CI head commit.")

    commands: list[dict[str, Any]] = []
    merge_base: str | None = None
    base_sha: str | None = None
    if scope == "changed":
        if not base_ref or not head_ref:
            raise CiConfigurationError("changed scope requires explicit governed base and checked-out head refs.")
        base_sha = _verify_commit(target, base_ref, "base")
        merge_base = _run_git(target, ["merge-base", base_sha, head_sha]).stdout.strip()
        if len(merge_base) != 40:
            raise CiConfigurationError("The requested base and head do not have a valid merge base.")
        changed = _run_git(target, ["diff", "--name-only", "--no-ext-diff", "--no-renames", "-z", f"{base_sha}...{head_sha}"], binary=True)
        selected = _filter_files(_null_paths(changed.stdout), paths)
        commands.append({"command": "git diff --name-only --no-ext-diff --no-renames -z <base>...<head>", "exitCode": 0})
        diff, diff_commands = _diff_metrics(target, base_sha, head_sha, selected)
        commands.extend(diff_commands)
        history = _history_metrics(target, selected)
    elif scope == "full":
        if paths:
            raise CiConfigurationError("--path is only valid with changed or paths scope.")
        selected = _filter_files(_tracked_files(target, []), [])
        diff = {"status": "not-applicable", "fileCount": 0, "additions": 0, "deletions": 0, "changedLines": 0, "patchBytes": 0, "binaryFiles": 0, "files": {}}
        history = {"status": "not-applicable", "commitLimit": 500, "fileLimit": 500, "truncatedFiles": 0, "files": {}}
    elif scope == "paths":
        if not paths:
            raise CiConfigurationError("paths scope requires at least one --path.")
        selected = _filter_files(_tracked_files(target, paths), paths)
        if not selected:
            raise CiConfigurationError("paths scope did not resolve any files.")
        diff = {"status": "not-applicable", "fileCount": 0, "additions": 0, "deletions": 0, "changedLines": 0, "patchBytes": 0, "binaryFiles": 0, "files": {}}
        history = {"status": "not-applicable", "commitLimit": 500, "fileLimit": 500, "truncatedFiles": 0, "files": {}}
    else:
        raise CiConfigurationError(f"Unsupported scope: {scope}")

    existing_selected = [path for path in selected if (target / path).is_file()]
    support_files = _discover_support_files(target, selected) if existing_selected else []
    files = sorted(dict.fromkeys([*existing_selected, *support_files]))

    projection_root: Path | None = None
    projection_root, scan_target, copied = _archive_projection(target, head_sha, files)

    manifest = {
        "schemaVersion": 1,
        "scope": scope,
        "sourceCommit": head_sha,
        "base": base_sha,
        "head": head_sha,
        "mergeBase": merge_base,
        "files": copied,
        "fileCount": len(copied),
        "selectedFiles": selected,
        "selectedFileCount": len(selected),
        "analyzedFileCount": len(existing_selected),
        "supportFiles": support_files,
        "ignoredCount": 0,
        "excludedUntrackedCount": excluded_untracked_count,
        "ignoreFiles": [],
        "diff": diff,
        "history": history,
        "commands": commands,
    }
    return ScopeResolution(manifest=manifest, scan_target=scan_target, projection_root=projection_root)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _verified_file(
    value: str | None,
    expected_sha256: str | None,
    label: str,
    *,
    outside_root: Path,
) -> Path:
    if not value or not expected_sha256:
        raise CiConfigurationError(f"{label} path and SHA-256 are required.")
    source_path = Path(value).absolute()
    current = Path(source_path.anchor)
    for part in source_path.parts[1:]:
        current = current / part
        if current.is_symlink():
            raise CiConfigurationError(f"{label} path cannot traverse a symbolic link: {current.name}")
    path = source_path.resolve()
    if not path.is_file():
        raise CiConfigurationError(f"{label} file not found: {path}")
    try:
        path.relative_to(outside_root.resolve())
    except ValueError:
        pass
    else:
        raise CiConfigurationError(f"{label} must be supplied from outside the analyzed checkout.")
    normalized_digest = expected_sha256.strip().lower()
    if len(normalized_digest) != 64 or any(character not in "0123456789abcdef" for character in normalized_digest):
        raise CiConfigurationError(f"Invalid {label} SHA-256.")
    actual = _sha256(path)
    if not hmac.compare_digest(actual, normalized_digest):
        raise CiConfigurationError(f"{label} SHA-256 does not match the governed value.")
    return path


def _validate_policy(path: Path, profile: str) -> None:
    try:
        policy = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CiConfigurationError(f"Invalid corporate policy: {error}") from error
    if not isinstance(policy, dict) or policy.get("schemaVersion") != 1:
        raise CiConfigurationError("Corporate policy must be a schemaVersion 1 JSON object.")
    budgets = policy.get("budgets") or {}
    if not isinstance(budgets, dict) or budgets.get("enabled") is False:
        raise CiConfigurationError("Corporate policy cannot disable mandatory quality budgets.")
    ceilings = PROFILE_BUDGETS[profile]
    for key, ceiling in ceilings.items():
        if key not in budgets or ceiling == 0:
            continue
        value = budgets[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
            raise CiConfigurationError(f"Corporate policy budget {key} must be an integer.")
        if int(value) <= 0 or int(value) > ceiling:
            raise CiConfigurationError(f"Corporate policy budget {key} cannot weaken the {profile} default ({ceiling}).")


def _validate_clean_checkout(target: Path) -> int:
    staged = _run_git(target, ["ls-files", "--stage", "-z"], binary=True)
    for raw in _null_paths(staged.stdout):
        metadata, separator, path = raw.partition("\t")
        if not separator or not path:
            raise CiConfigurationError("Unable to parse the Git index.")
        mode = metadata.split(" ", 1)[0]
        if mode == "120000":
            raise CiConfigurationError(f"Tracked source symlinks are not allowed: {_normalize_path(path)}")
        if mode == "160000":
            raise CiConfigurationError(f"Gitlinks/submodules are not allowed in the CI source tree: {_normalize_path(path)}")

    status = _run_git(
        target,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        binary=True,
    )
    excluded_untracked = 0
    for raw in _null_paths(status.stdout):
        if len(raw) < 4:
            raise CiConfigurationError("Unable to parse Git working tree status.")
        state, path = raw[:2], _normalize_path(raw[3:])
        if state != "??":
            raise CiConfigurationError(f"Tracked source differs from the requested commit: {path}")
        if (target / path).is_symlink():
            raise CiConfigurationError(f"Untracked symbolic links are not allowed: {path}")
        excluded_untracked += 1
    return excluded_untracked


def _reject_symlink_components(target: Path, candidate: Path, *, label: str = "Quality output/projection") -> None:
    root = target.resolve()
    raw = candidate if candidate.is_absolute() else target / candidate
    try:
        relative = raw.absolute().relative_to(target.absolute())
    except ValueError as error:
        raise CiConfigurationError("Quality output/projection must stay inside the CI checkout.") from error
    current = target
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise CiConfigurationError(f"{label} cannot traverse a symbolic link: {current.name}")
    try:
        raw.resolve().relative_to(root)
    except ValueError as error:
        raise CiConfigurationError("Quality output/projection must stay inside the CI checkout.") from error


@contextlib.contextmanager
def _ci_environment(scope: str) -> Iterator[None]:
    previous_scope = os.environ.get("QUALITY_CHECK_SCOPE")
    previous_git_prompt = os.environ.get("GIT_TERMINAL_PROMPT")
    removed: dict[str, str] = {}
    for name in list(os.environ):
        upper_name = name.upper()
        if upper_name in SENSITIVE_ENV_NAMES or any(marker in upper_name for marker in SENSITIVE_ENV_MARKERS):
            removed[name] = os.environ.pop(name)
    os.environ["QUALITY_CHECK_SCOPE"] = scope
    os.environ["GIT_TERMINAL_PROMPT"] = "0"
    try:
        yield
    finally:
        if previous_scope is None:
            os.environ.pop("QUALITY_CHECK_SCOPE", None)
        else:
            os.environ["QUALITY_CHECK_SCOPE"] = previous_scope
        if previous_git_prompt is None:
            os.environ.pop("GIT_TERMINAL_PROMPT", None)
        else:
            os.environ["GIT_TERMINAL_PROMPT"] = previous_git_prompt
        os.environ.update(removed)


def _output_path(target: Path, value: str) -> Path:
    path = Path(value)
    raw = path if path.is_absolute() else target / path
    _reject_symlink_components(target, raw)
    resolved = raw.resolve()
    try:
        resolved.relative_to(target.resolve())
    except ValueError as error:
        raise CiConfigurationError("Quality report output must stay inside the CI checkout.") from error
    return resolved


def run_check(args: argparse.Namespace) -> int:
    del args
    locale = normalize_locale(os.environ.get("CODE_APPROVAL_QUALITY_LOCALE", "en"))
    contract_scope = "changed"
    contract_profile = "standard"
    contract_threshold = MIN_THRESHOLD
    contract_evidence_age = 86400
    scope: ScopeResolution | None = None
    environment = contextlib.ExitStack()
    try:
        environment.enter_context(_ci_environment(contract_scope))
        target, head_sha = _trusted_checkout()
        base_ref, target_branch = _governed_base_ref(target, contract_scope)

        policy_file = os.environ.get("CODE_APPROVAL_QUALITY_POLICY_FILE")
        policy_sha256 = os.environ.get("CODE_APPROVAL_QUALITY_POLICY_SHA256")
        if not policy_file or not policy_sha256:
            raise CiConfigurationError(translate(locale, "ci_policy_required"))
        policy_path = _verified_file(
            policy_file,
            policy_sha256,
            "Corporate policy",
            outside_root=target,
        )
        _validate_policy(policy_path, contract_profile)

        if os.environ.get("CODE_APPROVAL_QUALITY_WAIVERS") or os.environ.get("CODE_APPROVAL_QUALITY_WAIVER_SHA256"):
            raise CiConfigurationError(
                "Waivers are disabled at the initial GitLab trust boundary; govern exceptions in the externally managed policy."
            )

        excluded_untracked_count = _validate_clean_checkout(target)
        output = _output_path(target, ".quality/reports")
        output.mkdir(parents=True, exist_ok=True)

        scope = resolve_scope(
            target,
            contract_scope,
            base_ref,
            head_sha,
            [],
            excluded_untracked_count=excluded_untracked_count,
        )
        manifest_path = output / "quality-scope.json"
        manifest = dict(scope.manifest)
        manifest["targetBranch"] = target_branch
        manifest["sourceMaterialization"] = "git-archive"
        manifest["policy"] = {"file": policy_path.name, "sha256": policy_sha256.lower()}
        manifest["evidenceContract"] = {
            "provenanceRequired": True,
            "expectedSourceCommit": manifest["sourceCommit"],
            "maxAgeSeconds": contract_evidence_age,
        }
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        sidecar_args = [
            "check",
            str(scope.scan_target),
            "--mode", "full",
            "--profile", contract_profile,
            "--locale", locale,
            "--threshold", str(contract_threshold),
            "--fail-on-tool-error",
            "--enable-secrets",
            "--format", "json,md",
            "--output", str(output),
            "--policy-file", str(policy_path),
            "--require-policy",
            "--policy-sha256", policy_sha256.lower(),
            "--scope-manifest", str(manifest_path),
            "--require-evidence-provenance",
            "--expected-source-commit", str(manifest["sourceCommit"]),
            "--max-evidence-age-seconds", str(contract_evidence_age),
        ]

        return sidecar_entrypoint(sidecar_args)
    except Exception as error:  # noqa: BLE001 - CI boundary must return operational exit 3 without a traceback.
        detail = str(error) if isinstance(error, CiConfigurationError) else f"Unexpected runtime failure ({type(error).__name__})."
        print(translate(locale, "ci_error", detail=detail), file=sys.stderr)
        return OPERATIONAL_ERROR
    finally:
        environment.close()
        if scope and scope.projection_root:
            shutil.rmtree(scope.projection_root, ignore_errors=True)


def entrypoint(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as error:
        return 0 if error.code == 0 else OPERATIONAL_ERROR
    if args.command != "check":
        parser.print_help()
        return OPERATIONAL_ERROR
    return run_check(args)


if __name__ == "__main__":
    raise SystemExit(entrypoint())
