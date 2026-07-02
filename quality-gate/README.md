# quality-check

`quality-check` is the deterministic Quality Gate used by Code Approval Gates.

For new workflows, prefer the unified CLI:

```powershell
code-approval-gates quality --scope changed --json --no-interactive --output .quality/reports/latest
```

Full project scan:

```powershell
code-approval-gates quality --scope full --format json,md --output .quality/reports/full
```

Path-scoped scan:

```powershell
code-approval-gates quality --scope paths --path apps/web --path docs
```

GitLab CI:

```powershell
code-approval-gates quality --ci --scope changed --format json,md --output code-approval-report --no-interactive
```

The lower-level wrapper is still available for advanced/debug use and compatibility. Prefer `code-approval-gates quality` for users, agents, and CI:

```powershell
quality-check . --scope changed --threshold 90 --format=json,md --output .quality/reports
quality-check . --scope full --threshold 90 --format=json,md --output .quality/reports/full
quality-check . --scope paths --path docs --threshold 90 --format=json,md --output .quality/reports/docs
```

`--path` requires `--scope paths`. For `changed` and `full`, use `--exclude`, `--include`, or ignore files to filter.

Reports include `scoreAppliesTo`:

- `changed-files` for `--scope changed`;
- `entire-project` for `--scope full`;
- `selected-paths` for `--scope paths`.

Do not describe a changed-file score as a full-project score.

The unified CLI adds:

- `changed`, `full`, and `paths` scopes;
- `.gitignore`, `.code-approval-gates.ignore`, and `.quality-gate.ignore`, including gitignore-style `!path` re-inclusion;
- headless `--json --no-interactive` mode for agents;
- `doctor` checks;
- consolidated reports under `.quality/reports/latest`;
- baseline support.
