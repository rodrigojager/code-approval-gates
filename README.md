# Harness Gates

## 🇺🇸 English

Harness Gates provides two approval gates for code generated or maintained by humans and AI agents. The goal is to keep code quality above a minimum accepted score before commit, pull request, merge, release, or handoff.

The gates evaluate the repository, produce normalized reports, calculate a score, and return an approval status. A failing result is intended to be actionable: an agent can fix the code and rerun the same gates in a loop until the code reaches the required quality threshold, without lowering thresholds, changing to easier providers, disabling checks, adding silent waivers, or rewriting the objective to fit the implementation.

This repository distributes two independent gates that can be used separately or together:

- `semantic-gate`: AI semantic review for intent, functional correctness, edge cases, tests, maintainability, architecture, performance, reliability, and contextual risk.
- `quality-check`: deterministic Docker-based gate for static/tool-backed quality analysis, policy scoring, and normalized reports.

Together, they act like a quality test for AI coding workflows: code is not considered approved until both the semantic review and the deterministic quality check meet the configured minimum score.

### What The Gates Evaluate

`quality-check` evaluates code deterministically through the bundled `harness-gates/quality-sidecar`. In full mode it can run:

- MegaLinter.
- Semgrep.
- Checkov IaC scanning by default when IaC files are detected.
- Trivy vulnerability and misconfiguration scanning.
- OSV-Scanner dependency vulnerability scanning.
- jscpd duplication detection.
- Built-in stack and framework detection.
- Optional project test execution when a supported stack is detected.
- Optional coverage gate when explicitly enabled, reading existing coverage reports.
- Built-in policy scoring, severity weighting, thresholds, waivers, and normalized JSON/Markdown reports.
- Optional PII and secret checks only when explicitly enabled with `--enable-pii` or `--enable-secrets`.
- Gitleaks and Trivy secret scanning only when secret checks are explicitly enabled.

Checkov runs by default in full mode only when deterministic IaC detection finds files such as Terraform, Kubernetes manifests, Helm charts, Docker/Compose files, CloudFormation templates, Serverless files, or CI workflow configuration. If no IaC files are found, Checkov is reported as skipped and does not reduce the score. Disable this check explicitly with `--disable-iac`.

Coverage is opt-in. When `--enable-coverage` is set, the gate reads existing coverage reports in common formats such as `lcov.info`, Cobertura XML, JaCoCo XML, Clover XML, and Go `coverage.out`. If coverage is enabled and no supported report is found, the gate returns `NEEDS_CHANGES` because the requested evidence is missing.

`semantic-gate` evaluates code semantically through a configured AI provider or local AI CLI. It reviews the current diff, changed files, and objective to judge whether the implementation actually satisfies the requested behavior and whether there are hidden risks deterministic tools do not understand well.

Both gates return machine-usable status and scores:

- `APPROVED`: score is at or above the threshold and no blocker remains.
- `NEEDS_CHANGES`: analysis was insufficient or a required tool/provider failed.
- `REJECTED`: code did not meet the configured quality threshold or has an active blocker.

### Recommended Workflow

```text
semantic-gate run --objective-file .quality/objective.md --provider codex-cli --model gpt-5.5 --reasoning-effort high --json
quality-check . --threshold 90 --format=json,md --output .quality/reports
```

For agent workflows, use `use-semantic-gate` first and `use-quality-gate` second. The skills instruct the agent to fix the code in a loop until the gates approve while keeping the same gate configuration.

### Install From This Folder

Use this while the future Git repository/package registry is not published yet:

```powershell
npm run link:local
```

You can also install both commands directly from this folder:

```powershell
npm install -g .
```

Equivalent per-package development commands:

```powershell
npm --prefix .\semantic-gate install --workspaces=false
npm --prefix .\semantic-gate run build --workspaces=false
npm install -g .\semantic-gate

npm --prefix .\quality-gate install --workspaces=false
npm install -g .\quality-gate
```

After publishing, replace the local install lines with the package or Git URL you choose:

```bash
npm install -g <your-future-git-url>
```

The repository root exposes both global binaries:

```bash
semantic-gate --help
quality-check .
```

### Prerequisites

Semantic gate only:

- Node.js `>=18.17`.
- A Git repository, because the gate reviews staged, unstaged, untracked, or CI range changes.
- An objective file, normally `.quality/objective.md`.
- One configured AI provider and model.
- Hosted API providers can use provider-specific secrets such as `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `GEMINI_API_KEY`, or `OPENCODE_API_KEY`.
- For `codex-cli`: Codex CLI installed and available as `codex`, plus access to the requested model.
- For CI/CD with Codex CLI: store a secret such as `CODEX_API_KEY` in the CI secret store and expose it only to the semantic gate command. Use `CODEX_ACCESS_TOKEN` only for trusted Business/Enterprise runners that specifically need ChatGPT workspace identity.

Quality gate only:

- Node.js `>=18`.
- Docker Desktop or Docker Engine installed, running, and accessible from the shell/runner.
- Network access on first image build/pull unless the sidecar image is already present.
- The npm package includes the Docker build context and auto-builds `harness-gates/quality-sidecar:latest` when missing.
- `--mode quick` and `--mode offline` are development-only partial modes. Do not use them to claim full gate approval.
- Checkov IaC scanning is enabled by default in full mode and can be disabled with `--disable-iac`.
- Coverage thresholds are disabled by default and must be enabled with `--enable-coverage`.

Both gates:

- Keep `.quality/objective.md` in the target repository for semantic review.
- Publish `.quality/semantic-gate` and `.quality/reports` as CI artifacts.
- Use exit codes to fail PR/MR pipelines automatically.
- Run `semantic-gate` before `quality-check` when you want the AI review to catch semantic gaps before deterministic analysis.

### Local Usage

Run semantic review with Codex CLI:

```powershell
semantic-gate run --objective-file .quality/objective.md --provider codex-cli --model gpt-5.5 --reasoning-effort high --json
```

Run deterministic quality:

```powershell
quality-check . --threshold 90 --format=json,md --output .quality/reports
quality-check . --threshold 90 --enable-coverage --min-line-coverage 80 --format=json,md --output .quality/reports
quality-check . --threshold 90 --disable-iac --format=json,md --output .quality/reports
```

Run both manually:

```powershell
semantic-gate run --objective-file .quality/objective.md --provider codex-cli --model gpt-5.5 --reasoning-effort high --json
quality-check . --threshold 90 --format=json,md --output .quality/reports
```

### CI/CD

Templates are in `examples/ci/`:

- `gitlab-semantic-gate-codex-cli.yml`
- `gitlab-quality-gate.yml`
- `gitlab-both-gates.yml`
- `github-actions-both-gates.yml`

CI rules:

- Use `GIT_DEPTH: "0"` or fetch the target branch for semantic diffs.
- Keep `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `OPENCODE_API_KEY`, and other provider secrets masked/protected.
- Do not set model-provider secrets job-wide in jobs that run untrusted repository code before the gate command.
- Publish reports as artifacts with `when: always`.
- Let non-zero exit codes fail the PR/MR.

### Repository Layout

```text
semantic-gate/      AI semantic review CLI package
quality-gate/       deterministic Docker quality-check package
use-semantic-gate/  Codex skill for semantic gate fix loops
use-quality-gate/   Codex skill for quality gate fix loops
examples/ci/        GitLab and GitHub Actions templates
scripts/            local linking and verification helpers
```

### Verify This Workspace

```powershell
npm run verify
```

This runs package tests and dry-run packaging checks for both gates. Docker image smoke checks remain available inside `quality-gate/scripts/`.

## 🇧🇷 Português

Harness Gates fornece dois gates de aprovação para código gerado ou mantido por pessoas e agentes de IA. O objetivo é manter a qualidade do código acima de uma pontuação mínima aceita antes de commit, pull request, merge, release ou entrega.

Os gates avaliam o repositório, geram relatórios normalizados, calculam uma pontuação e retornam um status de aprovação. Um resultado reprovado deve ser acionável: um agente pode corrigir o código e rodar os mesmos gates em loop até atingir o limite mínimo de qualidade, sem reduzir thresholds, trocar para providers mais fáceis, desabilitar checks, adicionar waivers silenciosos ou reescrever o objetivo para combinar com a implementação.

Este repositório distribui dois gates independentes que podem ser usados separadamente ou em conjunto:

- `semantic-gate`: revisão semântica por IA para intenção, correção funcional, casos de borda, testes, manutenibilidade, arquitetura, performance, confiabilidade e risco contextual.
- `quality-check`: gate determinístico baseado em Docker para análise estática/com ferramentas, pontuação por política e relatórios normalizados.

Juntos, eles funcionam como um teste de qualidade para fluxos de programação com IA: o código não deve ser considerado aprovado até que a revisão semântica e o quality gate determinístico atinjam a pontuação mínima configurada.

### O Que Os Gates Avaliam

O `quality-check` avalia o código de forma determinística usando o `harness-gates/quality-sidecar` embarcado. Em modo full, ele pode executar:

- MegaLinter.
- Semgrep.
- Checkov para IaC por padrão quando arquivos de IaC são detectados.
- Trivy para vulnerabilidades e misconfigurations.
- OSV-Scanner para vulnerabilidades em dependências.
- jscpd para detecção de duplicação.
- Detecção interna de stack e framework.
- Execução opcional de testes do projeto quando uma stack suportada é detectada.
- Gate opcional de coverage quando explicitamente habilitado, lendo relatórios de cobertura existentes.
- Pontuação por política, peso por severidade, thresholds, waivers e relatórios normalizados em JSON/Markdown.
- Checks opcionais de PII e secrets somente quando explicitamente habilitados com `--enable-pii` ou `--enable-secrets`.
- Gitleaks e secret scanning do Trivy somente quando checks de secrets são explicitamente habilitados.

Checkov roda por padrão em modo full somente quando a detecção determinística de IaC encontra arquivos como Terraform, manifests Kubernetes, charts Helm, Docker/Compose, templates CloudFormation, Serverless ou workflows de CI. Se nenhum arquivo de IaC for encontrado, Checkov aparece como skipped e não reduz o score. Desabilite explicitamente com `--disable-iac`.

Coverage é opt-in. Quando `--enable-coverage` é usado, o gate lê relatórios de cobertura existentes em formatos comuns como `lcov.info`, Cobertura XML, JaCoCo XML, Clover XML e Go `coverage.out`. Se coverage for habilitado e nenhum relatório suportado for encontrado, o gate retorna `NEEDS_CHANGES` porque a evidência solicitada está ausente.

O `semantic-gate` avalia o código semanticamente usando um provider de IA configurado ou uma CLI local de IA. Ele revisa o diff atual, arquivos alterados e objetivo para julgar se a implementação realmente atende ao comportamento solicitado e se existem riscos ocultos que ferramentas determinísticas não entendem bem.

Ambos retornam status e pontuação utilizáveis por automação:

- `APPROVED`: score no mínimo igual ao threshold e sem blocker ativo.
- `NEEDS_CHANGES`: análise insuficiente ou falha em ferramenta/provider necessário.
- `REJECTED`: código abaixo do threshold configurado ou com blocker ativo.

### Fluxo Recomendado

```text
semantic-gate run --objective-file .quality/objective.md --provider codex-cli --model gpt-5.5 --reasoning-effort high --json
quality-check . --threshold 90 --format=json,md --output .quality/reports
```

Para fluxos com agentes, use `use-semantic-gate` primeiro e `use-quality-gate` depois. As skills instruem o agente a corrigir o código em loop até os gates aprovarem, mantendo a mesma configuração dos gates.

### Instalação A Partir Desta Pasta

Use isto enquanto o futuro repositório Git ou package registry ainda não foi publicado:

```powershell
npm run link:local
```

Também é possível instalar os dois comandos diretamente desta pasta:

```powershell
npm install -g .
```

Comandos equivalentes por pacote durante desenvolvimento:

```powershell
npm --prefix .\semantic-gate install --workspaces=false
npm --prefix .\semantic-gate run build --workspaces=false
npm install -g .\semantic-gate

npm --prefix .\quality-gate install --workspaces=false
npm install -g .\quality-gate
```

Depois da publicação, substitua a instalação local pelo pacote ou URL Git escolhido:

```bash
npm install -g <your-future-git-url>
```

A raiz do repositório expõe os dois binários globais:

```bash
semantic-gate --help
quality-check .
```

### Pré-Requisitos

Somente semantic gate:

- Node.js `>=18.17`.
- Um repositório Git, porque o gate revisa mudanças staged, unstaged, untracked ou ranges de CI.
- Um arquivo de objetivo, normalmente `.quality/objective.md`.
- Um provider de IA e modelo configurados.
- Providers de API hospedados podem usar secrets específicos como `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `GEMINI_API_KEY` ou `OPENCODE_API_KEY`.
- Para `codex-cli`: Codex CLI instalado e disponível como `codex`, além de acesso ao modelo solicitado.
- Para CI/CD com Codex CLI: armazene um secret como `CODEX_API_KEY` no cofre de secrets do CI e exponha somente para o comando do semantic gate. Use `CODEX_ACCESS_TOKEN` apenas em runners Business/Enterprise confiáveis que realmente precisem de identidade de workspace ChatGPT.

Somente quality gate:

- Node.js `>=18`.
- Docker Desktop ou Docker Engine instalado, rodando e acessível pelo shell/runner.
- Acesso à rede no primeiro build/pull da imagem, salvo se a imagem do sidecar já estiver presente.
- O pacote npm inclui o contexto de build Docker e constrói automaticamente `harness-gates/quality-sidecar:latest` quando a imagem estiver ausente.
- `--mode quick` e `--mode offline` são modos parciais para desenvolvimento. Não use esses modos para declarar aprovação completa.
- Checkov para IaC fica habilitado por padrão em modo full e pode ser desabilitado com `--disable-iac`.
- Thresholds de coverage ficam desabilitados por padrão e precisam ser habilitados com `--enable-coverage`.

Ambos os gates:

- Mantenha `.quality/objective.md` no repositório alvo para a revisão semântica.
- Publique `.quality/semantic-gate` e `.quality/reports` como artefatos de CI.
- Use exit codes para reprovar pipelines de PR/MR automaticamente.
- Rode `semantic-gate` antes de `quality-check` quando quiser que a revisão por IA encontre lacunas semânticas antes da análise determinística.

### Uso Local

Rodar revisão semântica com Codex CLI:

```powershell
semantic-gate run --objective-file .quality/objective.md --provider codex-cli --model gpt-5.5 --reasoning-effort high --json
```

Rodar qualidade determinística:

```powershell
quality-check . --threshold 90 --format=json,md --output .quality/reports
quality-check . --threshold 90 --enable-coverage --min-line-coverage 80 --format=json,md --output .quality/reports
quality-check . --threshold 90 --disable-iac --format=json,md --output .quality/reports
```

Rodar ambos manualmente:

```powershell
semantic-gate run --objective-file .quality/objective.md --provider codex-cli --model gpt-5.5 --reasoning-effort high --json
quality-check . --threshold 90 --format=json,md --output .quality/reports
```

### CI/CD

Templates estão em `examples/ci/`:

- `gitlab-semantic-gate-codex-cli.yml`
- `gitlab-quality-gate.yml`
- `gitlab-both-gates.yml`
- `github-actions-both-gates.yml`

Regras de CI:

- Use `GIT_DEPTH: "0"` ou faça fetch do branch alvo para diffs semânticos.
- Mantenha `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `OPENCODE_API_KEY` e outros secrets de provider mascarados/protegidos.
- Não configure secrets de provider globalmente em jobs que executam código não confiável do repositório antes do comando do gate.
- Publique relatórios como artefatos com `when: always`.
- Deixe exit codes diferentes de zero reprovarem o PR/MR.

### Estrutura Do Repositório

```text
semantic-gate/      pacote CLI da revisão semântica por IA
quality-gate/       pacote Docker determinístico quality-check
use-semantic-gate/  skill Codex para loops do semantic gate
use-quality-gate/   skill Codex para loops do quality gate
examples/ci/        templates para GitLab e GitHub Actions
scripts/            helpers de link local e verificação
```

### Verificar Este Workspace

```powershell
npm run verify
```

Esse comando roda os testes dos pacotes e checagens de empacotamento dry-run dos dois gates. Smoke checks de imagem Docker continuam disponíveis dentro de `quality-gate/scripts/`.
