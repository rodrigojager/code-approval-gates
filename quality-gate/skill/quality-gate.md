---
name: complementary-semantic-quality-review
description: Revisao complementar de qualidade para alteracoes recentes. Avalia riscos semanticos que o quality gate deterministico nao consegue provar bem.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

# Complementary Semantic Quality Review

Use esta skill quando precisar aprovar, rejeitar ou melhorar alteracoes de codigo antes de merge, commit, release ou conclusao de tarefa por agente.

Esta skill e complementar ao `quality-check`, mas independente dele. Ela nao recebe nem usa o sumario do quality gate deterministico como entrada. O trabalho aqui e revisar diretamente o repositorio, o diff e os arquivos modificados recentemente, como um duplo check semantico.

O objetivo nao e buscar codigo perfeito. O objetivo e impedir regressões funcionais, riscos de seguranca contextuais, dividas obvias, acoplamentos ruins e mudancas dificeis de manter que ferramentas deterministicas nao conseguem julgar sozinhas.

O status desta skill vale apenas para a camada semantica complementar. A aprovacao final do fluxo ainda exige que o quality gate deterministico seja executado separadamente e fique dentro dos limites definidos pelo projeto.

## Boundary with Deterministic Quality Gate

Do not duplicate deterministic responsibilities.

The deterministic `quality-check` owns:

- build, lint, format, type-check, test execution, and project command status
- dependency and vulnerability scanners
- static rule scanners
- duplication and copy-paste detection
- generated report normalization
- deterministic score calculation
- optional secret and PII checks when explicitly enabled

This skill owns semantic judgment:

- whether the change satisfies the declared objective
- whether tests prove behavior and regressions rather than implementation details
- whether the design fits the module, boundaries, and existing patterns
- whether error handling, state transitions, concurrency, and edge cases are credible
- whether security and privacy-sensitive behavior is safe at the business-logic level
- whether performance and reliability risks are plausible from the code path
- whether AI-generated code shows invented APIs, shallow fixes, false comments, or over-mocking

If a deterministic tool can prove a fact mechanically, do not spend findings on that fact. If the same code also creates a semantic risk that requires reasoning, report only the semantic risk.

## Privacy Boundary

Do not inspect, infer, request, or classify secrets or PII.

Secrets and PII review is opt-in and belongs to the deterministic sidecar by default. Do not hunt for credentials, personal documents, tokens, cookies, private keys, sensitive payloads, or identity values.

If the caller explicitly asks for privacy or secrets review, keep it limited to high-level design and logging/data-flow risk. Never ask the user to paste real credentials or personal data.

## Input and Scope

Do not use the deterministic quality gate summary as input.

Use the current repository state as the primary input:

1. Read the user request, task description, issue, PRD, or objective file when the caller provides one.
2. If no objective is provided, infer the objective from the diff and state that assumption in `Approval Notes`.
3. Identify all recent changes:
   - staged changes
   - unstaged changes
   - untracked source, config, documentation, and test files
   - if the working tree is clean, inspect the most recent commit or the caller-provided comparison range
4. Read every modified relevant file unless it is generated, vendored, binary, or too large to inspect safely.
5. For each changed area, read enough surrounding code to understand ownership, call sites, tests, public contracts, and integration boundaries.

Recommended discovery commands:

```bash
git status --short
git diff --stat
git diff --cached --stat
git diff
git diff --cached
git ls-files --others --exclude-standard
```

Use shell commands only for repository discovery and reading current state. Do not run build, lint, type-check, test, format, scanner, or package-audit commands as part of this skill.

## Required Result Format

At the end of every evaluation, respond in this format:

```markdown
# Quality Gate Result

Gate: Complementary Semantic Review
Status: APPROVED | REJECTED | NEEDS_CHANGES
Score: 0-100
Threshold: 90
Deterministic Summary Used: No
Objective Source: user prompt | file:path | inferred from diff
Changes Reviewed: short description of changed files/range

## Hard Blockers
- Nenhum
ou
- [BLOCKER][categoria] arquivo:linha motivo correcao exigida

## Score Breakdown
| Categoria | Peso | Nota | Observacoes |
|---|---:|---:|---|
| Correcao funcional | 25 | 0-25 | ... |
| Testes e regressao | 20 | 0-20 | ... |
| Seguranca semantica | 20 | 0-20 | ... |
| Manutenibilidade | 15 | 0-15 | ... |
| Arquitetura e integracao | 10 | 0-10 | ... |
| Performance e confiabilidade | 10 | 0-10 | ... |

## Commands Executed
| Command | Result | Purpose |
|---|---|---|
| `git status --short` | ... | identify changed files |

## Findings
### Blocking
- ...

### Important
- ...

### Suggestions
- ...

### Nits
- ...

## Required Fix Plan
1. ...
2. ...
3. ...

## Re-run Commands
```bash
quality-check .
```

## Approval Notes
Explique por que aprovou ou rejeitou, quais riscos residuais foram aceitos e qual foi a menor mudanca necessaria quando houver rejeicao.
```

## Approval Policy

Approve only when all conditions below are true for the semantic layer:

1. Final score is greater than or equal to the threshold.
2. No hard blocker is active.
3. The change satisfies the declared or inferred objective.
4. Important behavior changes have meaningful behavior-level tests or a clear justification for why tests are not applicable.
5. The change does not introduce a concrete contextual security risk.
6. Public contracts are preserved, or the migration/compatibility path is clear.
7. The implementation does not add unnecessary complexity.
8. The change does not remove useful validations, error handling, observability, or tests without a defensible reason.

Reject automatically if any semantic hard blocker exists, even if the numeric score is high.

Do not reject solely because deterministic command output was not provided. That belongs to the separate `quality-check` execution.

## Hard Blockers

Mark as hard blocker only when the issue is concrete and grounded in the changed code.

### Functional Correctness

- Main requirement was not implemented.
- Happy path works but a common error path breaks the system.
- Existing expected behavior is likely regressed.
- State can become inconsistent between database, cache, queue, UI, or local persistence.
- Boundary bug is evident: null, empty, zero, off-by-one, timezone, encoding, locale, precision, or concurrent update.
- Probable race condition or ordering bug.
- Changed code calls an API, field, method, event, or contract that does not exist in the local project context.
- Error handling hides failure in a way that makes the caller believe the operation succeeded.

### Tests and Regression

- Business rule changed without behavior-level coverage or an explicit valid reason.
- Bug fix has no regression test when the bug is practical to reproduce.
- Tests assert implementation trivia while missing the observable behavior.
- Test setup mocks away the integration point that the change is supposed to protect.
- Critical edge case is not covered and manual reasoning is insufficient.
- Test update appears to lower confidence rather than reflect a legitimate behavior change.

### Semantic Security

- Authentication or authorization behavior can be bypassed by the changed flow.
- A privilege boundary was widened without an explicit product reason.
- External input reaches a privileged business operation without domain validation at the correct boundary.
- Error responses or UI states reveal operational internals that materially help abuse.
- A new workflow allows confused-deputy behavior, cross-tenant access, or unintended data mutation.
- A risky file, network, template, or command operation is introduced without adequate contextual constraints.
- Dependency usage is architecturally unjustified or gives broad new capability where a local helper already exists.

### Architecture

- Public API, event, schema, or storage contract changed without compatibility or migration path.
- Domain logic moved into UI, transport, infrastructure, or scripts against the local architecture.
- Shared module now depends on a specific product rule that should remain local.
- New abstraction is generic for only one concrete use case and makes the code harder to change.
- Refactor moves complexity instead of reducing it.
- Change creates or worsens circular ownership between modules.

### Performance and Reliability

- Relevant path now risks unbounded work over user-controlled or potentially large data.
- List or search path lacks a limit, cursor, or pagination strategy where volume matters.
- New synchronous or blocking operation appears in a hot path.
- External IO lacks a credible timeout, cancellation, idempotency, or bounded retry strategy.
- Error handling around IO, parsing, storage, queue, or network is missing or misleading.
- Resource lifecycle is unsafe: connection, stream, subscription, timer, handle, cache, or listener may leak.
- UI change can trigger unnecessary repeated rendering or work in a common path.

## Review Axes

### Axis 1: Functional Correctness - 25 points

Questions:

- Does the change solve the declared or inferred problem?
- Does old behavior still work when it should?
- Are common edge cases handled?
- Are predictable errors represented honestly to callers and users?
- Is validation placed at the right system boundary?
- Is state kept consistent?
- Are timezone, encoding, locale, rounding, and precision considered when relevant?
- Is concurrency or ordering safe enough for the context?

Scoring:

- 25: correct, complete, relevant edge cases handled.
- 18-24: correct with small non-critical gaps.
- 10-17: partial, mostly happy-path, or unclear behavior.
- 1-9: fragile, ambiguous, or high-risk.
- 0: does not satisfy the objective.

### Axis 2: Tests and Regression - 20 points

Questions:

- Is there behavior-level coverage for new rules?
- Is there regression coverage for a bug fix?
- Do tests cover error, empty, null, boundary, permission, or integration cases when relevant?
- Do tests validate observable behavior rather than incidental implementation?
- Are tests readable and maintainable?
- Do updated tests still protect the original contract?
- Is integration coverage present when the change crosses components?

Scoring:

- 20: relevant tests with meaningful edge cases.
- 14-19: good coverage with small gaps.
- 8-13: minimal tests and heavy reliance on manual confidence.
- 1-7: weak or unrelated tests.
- 0: important behavior change without credible test strategy.

### Axis 3: Semantic Security - 20 points

Questions:

- Is untrusted input constrained at the correct domain boundary?
- Is authorization checked for the action, not just authentication?
- Does the change preserve least privilege?
- Can the new flow cross tenant, account, workspace, or role boundaries incorrectly?
- Are errors and UI states safe from a business-abuse perspective?
- Are file, network, command, template, upload, and parsing operations constrained by context?
- Does a new dependency or integration expand capability without product need?

Scoring:

- 20: no relevant semantic security risk.
- 14-19: low risk with clear mitigation.
- 8-13: medium risk or incomplete boundary reasoning.
- 1-7: high risk without sufficient mitigation.
- 0: critical contextual vulnerability.

### Axis 4: Maintainability - 15 points

Questions:

- Are names clear and consistent with the project?
- Do functions and modules keep a focused responsibility?
- Is control flow simple enough to review?
- Is duplication avoidable with existing helpers?
- Are comments about intent rather than obvious mechanics?
- Are types and contracts explicit enough?
- Is there dead code, vague TODO, local hack, silent fallback, or misleading comment?
- Does the solution remove real complexity or just reorganize it?

Scoring:

- 15: simple, legible, consistent.
- 11-14: good with small cleanup points.
- 6-10: moderate complexity or duplication.
- 1-5: hard to understand or maintain.
- 0: severe technical debt.

### Axis 5: Architecture and Integration - 10 points

Questions:

- Does the change belong in this module?
- Does it respect layer and ownership boundaries?
- Does it avoid circular dependency and shared-module leakage?
- Does it preserve public contracts?
- Does it integrate with existing patterns?
- Does it avoid overengineering?
- Are migrations, jobs, queues, events, and feature flags handled when the deployment risk requires them?

Scoring:

- 10: clear architectural fit.
- 7-9: good fit with small reservations.
- 4-6: questionable coupling or boundary.
- 1-3: fragile architecture.
- 0: breaks central architecture or contract.

### Axis 6: Performance and Reliability - 10 points

Questions:

- Is the algorithm appropriate for expected volume?
- Are potentially large operations bounded?
- Do external calls have timeout, cancellation, and bounded retry when relevant?
- Are errors observable without being misleading?
- Are resources released?
- Does UI avoid unnecessary expensive work?
- Did a hot path receive unnecessary allocation, IO, blocking work, or repeated computation?

Scoring:

- 10: efficient and resilient.
- 7-9: adequate with small risks.
- 4-6: moderate risk.
- 1-3: likely production problem.
- 0: severe bottleneck or reliability failure.

## Finding Severity

### BLOCKING

Prevents semantic approval. Use for:

- probable functional bug
- concrete contextual security risk
- public contract break
- regression
- missing test for critical rule
- real risk of data loss, corruption, unauthorized action, or hidden failure

### IMPORTANT

Usually should be fixed in the same cycle. Use for:

- relevant duplication
- missing non-critical edge case
- poor user or developer experience with practical impact
- suboptimal performance in a non-critical path
- contained but poor coupling
- useful test missing in lower-risk area

### SUGGESTION

Useful but not blocking. Use for:

- naming improvement
- small simplification
- helpful comment
- organization refinement
- ergonomics improvement

### NIT

Never blocks. Use only for style or preference that is not already handled by automated formatting.

## Scoring Rules

Start from 100 and apply semantic penalties:

- Semantic hard blocker: status REJECTED, score maximum 69.
- Critical contextual vulnerability: score maximum 40.
- High contextual security risk: score maximum 60.
- Important business rule without behavior-level test: score maximum 75.
- Bug fix without practical regression test: score maximum 75.
- Public contract change without migration or compatibility path: score maximum 70.
- Dangerous performance or reliability risk in a hot path: score maximum 70.
- Complexity much higher than necessary: score maximum 80.
- Only suggestions and nits: score should not fall below 90.

Also calculate the weighted sum of the six axes. Use the lower value between the weighted sum and the caps above.

## Improvement Loop

When status is REJECTED or NEEDS_CHANGES:

1. Fix semantic hard blockers first.
2. Then fix contextual security risks.
3. Then add or repair behavior-level tests.
4. Then fix functional bugs and edge cases.
5. Then address architecture and maintainability.
6. Then address performance and reliability.
7. Then handle suggestions and nits.

After each round:

```bash
git diff
```

Re-review the changed areas and recalculate the score. Do not run deterministic command suites from this skill; ask the caller to run `quality-check .` separately after fixes.

Stop the loop only when:

- score is greater than or equal to threshold
- no semantic hard blocker exists
- remaining plan contains only suggestions or nits

If two consecutive rounds do not improve the score, stop and explain the blocker. Do not make random changes to raise the score.

When this review is used by an implementation agent, the agent should apply scoped fixes and re-run the same review loop until the semantic layer approves. The agent must not pass by lowering the threshold, editing the objective to match the current implementation, hiding changed files, changing to an easier provider, or removing validations/tests/security checks to avoid findings.

## Minimal Change Policy

When proposing or applying fixes:

- Do not rewrite the whole system.
- Do not change architecture without need.
- Do not format unrelated files.
- Do not mix a large refactor with a bug fix.
- Do not alter public API merely to simplify implementation.
- Do not add a dependency when the project already has a local solution.
- Do not remove validations, useful observability, or tests to pass the review.
- Preserve existing behavior except where the task explicitly asks for a change.

## Special Criteria for AI-Generated Code

AI-generated code should receive stricter scrutiny, not lighter scrutiny.

Check especially for:

- invented APIs, imports, methods, fields, events, or package names
- code that compiles only in the example but not in the real project context
- tests that mock away the bug or integration risk
- superficial error handling
- silent fallback
- relaxed types, broad casts, or unexplained unknown/any usage
- duplicated code caused by missing local helpers
- confident but false comments
- security that is only apparent
- solution that works for the prompt example but fails in the real case

## Final Instructions for the Agent

Whenever you evaluate a change:

1. Show discovery commands executed and their result.
2. Cite files and lines whenever possible.
3. Separate blockers from suggestions.
4. Do not block on personal taste.
5. Do not approve when a concrete hidden risk remains.
6. Propose concrete fixes.
7. Generate an objective semantic score.
8. Re-run the semantic review loop until it passes or until the blocker is clear.
9. When approving, explain accepted residual risks.
10. When rejecting, explain the smallest set of changes needed for approval.
