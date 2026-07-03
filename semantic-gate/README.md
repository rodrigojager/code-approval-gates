# semantic-gate

`semantic-gate` is the AI Semantic Gate used by Code Approval Gates.

For new workflows, prefer the unified CLI:

```powershell
code-approval-gates semantic --scope changed --objective-file .quality/objective.md --json --no-interactive --output .quality/reports/latest
```

Full project semantic audit:

```powershell
code-approval-gates semantic --scope full --objective-file .quality/objective.md --format json,md --output .quality/reports/full
```

Objective through stdin:

```powershell
"Review architecture, quality, and risks" | code-approval-gates semantic --scope changed --objective-stdin --json --no-interactive
```

GitLab CI:

```powershell
code-approval-gates semantic --ci --scope changed --objective-file .quality/objective.md --provider codex-cli --model gpt-5.5 --reasoning-effort high --format json,md --output code-approval-report --no-interactive
```

When `--provider codex-cli` is used, the provider command runs Codex CLI with `--sandbox danger-full-access` and `--skip-git-repo-check` by default. Override with `--codex-sandbox read-only`, `--codex-sandbox workspace-write`, `--no-codex-skip-git-repo-check`, or `--codex-bypass-sandbox` when needed.

The lower-level binary is still available for advanced/debug use and compatibility. Prefer `code-approval-gates semantic` for users, agents, and CI:

```powershell
semantic-gate run --scope changed --objective-file .quality/objective.md --json
semantic-gate run --scope full --objective-file .quality/objective.md --json
semantic-gate run --scope paths --path docs --objective-file .quality/objective.md --json
```

`--path` requires `--scope paths`. For `changed` and `full`, use `--exclude`, `--include`, or ignore files to filter.

Reports include `scoreAppliesTo`:

- `changed-files` for `--scope changed`;
- `entire-project` for `--scope full`;
- `selected-paths` for `--scope paths`.

Do not describe a changed-file score as a full-project score.

Package tests use the published `dist/` files:

```powershell
npm test
```

For local development, rebuild before running those tests:

```powershell
npm run test:build
```

The unified CLI adds:

- `changed`, `full`, and `paths` scopes;
- `.gitignore`, `.code-approval-gates.ignore`, and `.semantic-gate.ignore`, including gitignore-style `!path` re-inclusion;
- headless `--json --no-interactive` mode for agents;
- wizard/TUI for humans;
- `doctor` checks;
- consolidated reports under `.quality/reports/latest`;
- baseline support.
