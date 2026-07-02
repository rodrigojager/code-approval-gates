# Code Approval Gates

Code Approval Gates combina um gate deterministico de qualidade (`quality-check`) e um gate semantico com IA (`semantic-gate`) em uma CLI principal: `code-approval-gates`.

Code Approval Gates combines a deterministic quality gate (`quality-check`) and an AI semantic gate (`semantic-gate`) behind one main CLI: `code-approval-gates`.

---

## Portugues

### O que e

A ferramenta avalia codigo antes de commit, merge request, release ou entrega por agente de IA.

Ela pode analisar:

- apenas as alteracoes recentes do Git;
- o projeto inteiro;
- diretorios ou arquivos especificos.

O comportamento padrao e rapido:

```powershell
code-approval-gates run
```

Esse comando usa `--scope changed`, ou seja, analisa apenas o que mudou.

### Instalacao

A partir deste repositorio:

```powershell
git clone https://github.com/rodrigojager/code-approval-gates.git
cd code-approval-gates
npm install -g .
```

Em desenvolvimento local:

```powershell
npm run link:local
```

Verifique o ambiente:

```powershell
code-approval-gates doctor
```

Se quiser criar arquivos padrao de configuracao e ignore:

```powershell
code-approval-gates init
```

O repositorio tambem inclui `.code-approval-gates.example.json` como referencia versionada. Nao e necessario renomear esse exemplo manualmente; `code-approval-gates init` cria `.code-approval-gates.json`. Em execucao, flags da linha de comando sobrescrevem a configuracao do arquivo.

Consultar ou alterar configuracao:

```powershell
code-approval-gates config get
code-approval-gates config set defaultScope full
code-approval-gates config set baseline.path .quality/baseline/baseline.json
```

Valores como `true`, `false` e numeros sao interpretados automaticamente quando possivel.
Tambem e possivel manter defaults de `paths`, `excludes`, `includes` e `ignoreFiles` em `.code-approval-gates.json`. `paths` so e usado quando o escopo efetivo e `paths`; excludes/includes/ignoreFiles podem complementar qualquer escopo. Flags de linha de comando podem complementar esses filtros para uma execucao especifica.

### Primeiro uso local

Modo facil, com wizard/TUI quando o terminal for interativo:

```powershell
code-approval-gates
```

O wizard permite escolher a acao (run, quality, semantic, baseline, report, config ou doctor), os gates para run, o escopo (`changed`, `full` ou `paths`), paths especificos, excludes/includes temporarios, ignore files extras, provider/modelo do Semantic Gate quando necessario, arquivos de saida do baseline e modo de correcao do Doctor.
Para baseline, o wizard sugere `full`; para analises do dia a dia, sugere `changed`.

Modo direto:

```powershell
code-approval-gates run
```

Modo headless para IA, scripts ou CI:

```powershell
code-approval-gates run --scope changed --json --no-interactive --output .quality/reports/latest
```

`--ci`, `--json` e `--no-interactive` nunca abrem wizard/TUI, mesmo se `--interactive` tambem for informado. Para IA, scripts e pipelines, sempre prefira comandos completos com flags explicitas.
Para ajuda parseavel por automacao, use `code-approval-gates help run --json --no-interactive`.

Use `--non-blocking` quando o pipeline ou agente deve receber exit code `0` e ler aprovacao/reprovacao pelos relatorios gerados.

Use `--cwd <dir>` quando a ferramenta for executada de fora da raiz do projeto analisado.

### Tipos de analise

Analise rapida das alteracoes Git:

```powershell
code-approval-gates run --scope changed
```

Analise de um range especifico:

```powershell
code-approval-gates run --scope changed --base origin/main --head HEAD
```

Analise completa do projeto:

```powershell
code-approval-gates run --scope full
```

Analise por diretorios:

```powershell
code-approval-gates run --scope paths --path apps/web --path packages/core
```

`--path` exige `--scope paths`. Para `changed` e `full`, use `--exclude`, `--include` ou arquivos de ignore para filtrar.

Todo relatorio declara `scoreAppliesTo`. Use esse campo para interpretar a pontuacao:

- `changed-files`: score das alteracoes recentes.
- `entire-project`: score do projeto inteiro.
- `selected-paths`: score dos arquivos/diretorios selecionados.

Nao apresente um score de `changed-files` como se fosse score do projeto inteiro.

Rodar somente o Quality Gate:

```powershell
code-approval-gates quality --scope changed
code-approval-gates run --gate quality --scope changed
```

Rodar somente o Semantic Gate:

```powershell
code-approval-gates semantic --scope changed --objective-file .quality/objective.md
```

O caminho de `--objective-file` e relativo ao diretorio do projeto analisado.

Objetivo semantico direto:

```powershell
code-approval-gates semantic --scope changed --objective "Avaliar arquitetura, qualidade e riscos"
code-approval-gates run --gate semantic --scope changed --objective "Avaliar arquitetura, qualidade e riscos"
```

Objetivo semantico via stdin:

```powershell
"Avaliar arquitetura, qualidade e riscos" | code-approval-gates semantic --scope full --objective-stdin --json --no-interactive
```

### Ignorando arquivos e diretorios

A ferramenta usa ignores em estilo `.gitignore`.

Arquivos suportados:

```text
.code-approval-gates.ignore
.quality-gate.ignore
.semantic-gate.ignore
```

O repositorio ja traz esses arquivos como templates. Em projetos consumidores, `code-approval-gates init` tambem cria os mesmos arquivos quando eles ainda nao existem.

Exemplo `.code-approval-gates.ignore`:

```gitignore
node_modules/
dist/
build/
coverage/
.quality/
*.log
*.sqlite
*.db
!generated/schema.json
```

Tambem e possivel passar ignores por comando:

```powershell
code-approval-gates run --scope full --exclude "generated/**" --exclude "projects/**/artifacts/**"
```

E re-incluir algo especifico:

```powershell
code-approval-gates run --scope full --exclude "projects/**/artifacts/**" --include "projects/demo/artifacts/schema.json"
```

### Baseline

Use baseline para separar problemas antigos de problemas novos.

No comando `baseline create`, `--output` aponta para o arquivo JSON do baseline. O diretorio do scan fonte fica em `--report-output`.

Criar baseline usando o scan fonte padrao, gerando esse scan se ainda nao existir:

```powershell
code-approval-gates baseline create --output .quality/baseline/baseline.json
```

Criar baseline fazendo um scan completo antes:

```powershell
code-approval-gates baseline create --scope full --output .quality/baseline/baseline.json --report-output .quality/reports/baseline-source
```

Quando o baseline gerar o scan fonte, voce tambem pode passar `--provider`, `--model`, `--reasoning-effort`, `--objective`, `--objective-file` ou `--objective-stdin` para manter o Semantic Gate alinhado com a analise desejada.
Essas flags semanticas sao ignoradas quando `--no-semantic` e usado.

Use `--no-semantic` ou `--no-quality` apenas quando quiser excluir um dos gates do baseline. Pelo menos um gate precisa continuar ativo.

Criar baseline a partir de um relatorio existente:

```powershell
code-approval-gates baseline create --from-report .quality/reports/full/summary.json --output .quality/baseline/baseline.json
```

Usar baseline no dia a dia:

```powershell
code-approval-gates run --scope changed --baseline .quality/baseline/baseline.json
```

Checar baseline:

```powershell
code-approval-gates baseline check --baseline .quality/baseline/baseline.json
```

Se `.code-approval-gates.json` definir `baseline.path`, `baseline create` e `baseline check` usam esse caminho quando `--output` ou `--baseline` nao forem informados.

O comando `run` so usa baseline quando `--baseline <path>` e passado explicitamente.

### Doctor

Diagnostico simples:

```powershell
code-approval-gates doctor
```

Diagnostico com JSON para IA/CI:

```powershell
code-approval-gates doctor --json --no-interactive
```

Diagnostico por area:

```powershell
code-approval-gates doctor quality
code-approval-gates doctor semantic
code-approval-gates doctor gitlab
```

Criar arquivos seguros que faltam:

```powershell
code-approval-gates doctor --fix --yes
```

Reinstalar o pacote globalmente de forma explicita:

```powershell
code-approval-gates doctor --install-global
```

O `doctor --fix` pode criar configuracao, ignores padrao, diretorios de relatorio, instalar dependencias locais do Semantic Gate quando faltarem e preparar artefatos locais necessarios. Ele nao deve salvar segredo no repositorio, apagar codigo, fazer commit ou push.
Ele tambem nao instala o pacote globalmente, exceto quando `--install-global` for passado explicitamente. Em terminal interativo, `--fix` e `--install-global` sem `--yes` pedem confirmacao antes de alterar o ambiente. Use `--yes` para deixar a intencao explicita em scripts, CI e execucoes headless.

### Relatorios

Ler resumo de um relatorio existente:

```powershell
code-approval-gates report summary --report-dir .quality/reports/latest
code-approval-gates report path --report-dir .quality/reports/latest
```

Padrao local:

```text
.quality/reports/latest/summary.json
.quality/reports/latest/summary.md
.quality/reports/latest/quality-report.json
.quality/reports/latest/quality-report.md
.quality/reports/latest/semantic-report.json
.quality/reports/latest/semantic-report.md
.quality/reports/latest/quality-scope.json
.quality/reports/latest/raw/
```

Ver o resumo:

```powershell
code-approval-gates report summary
```

### GitLab CI

Em pipelines consumidores, rode `code-approval-gates`. Reserve `npm run verify` para validar este repositorio antes de release/publicacao.

Merge request, analisando apenas alteracoes:

```yaml
code_approval_gates:
  image: node:22
  stage: test
  variables:
    GIT_DEPTH: "0"
  before_script:
    - npm install -g code-approval-gates
  script:
    - code-approval-gates doctor --ci --no-interactive
    - code-approval-gates run --ci --scope changed --format json,md --output code-approval-report --no-interactive
  artifacts:
    when: always
    paths:
      - code-approval-report/
    expire_in: 14 days
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
```

Scan completo agendado:

```yaml
code_approval_full_scan:
  image: node:22
  stage: test
  before_script:
    - npm install -g code-approval-gates
  script:
    - code-approval-gates run --ci --scope full --format json,md --output code-approval-report --no-interactive
  artifacts:
    when: always
    paths:
      - code-approval-report/
    expire_in: 30 days
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule"'
```

### Binarios diretos avancados

O pacote ainda publica `quality-check` e `semantic-gate` para uso avancado e compatibilidade. Para usuario, IA e CI, prefira `code-approval-gates`, porque ele padroniza escopo, ignores, baseline, doctor, wizard e relatorios em um unico contrato.

### Help

```powershell
code-approval-gates --help
code-approval-gates wizard --help
code-approval-gates run --help
code-approval-gates quality --help
code-approval-gates semantic --help
code-approval-gates baseline --help
code-approval-gates baseline create --help
code-approval-gates baseline check --help
code-approval-gates report --help
code-approval-gates report summary --help
code-approval-gates report path --help
code-approval-gates doctor --help
code-approval-gates doctor quality --help
code-approval-gates doctor semantic --help
code-approval-gates doctor gitlab --help
code-approval-gates init --help
code-approval-gates config --help
code-approval-gates config get --help
code-approval-gates config set --help
code-approval-gates config path --help
code-approval-gates version
code-approval-gates help run
```

### Validacao local do repositorio

Para validar o pacote completo antes de publicar ou usar em CI:

```powershell
npm run verify
```

Esse comando faz checagens de sintaxe, testes raiz, build/test do Semantic Gate, testes do Quality Gate e `npm pack --dry-run`.
Use `npm test` para o conjunto de testes sobre os artefatos ja gerados; use `npm run verify` antes de release, CI ou publicacao.

---

## English

### What it is

This tool evaluates code before commit, merge request, release, or AI-agent handoff.

It can analyze:

- recent Git changes only;
- the whole project;
- specific directories or files.

The default behavior is fast:

```powershell
code-approval-gates run
```

That command uses `--scope changed`, which means it analyzes only what changed.

### Installation

From this repository:

```powershell
git clone https://github.com/rodrigojager/code-approval-gates.git
cd code-approval-gates
npm install -g .
```

For local development:

```powershell
npm run link:local
```

Check the environment:

```powershell
code-approval-gates doctor
```

Create default config and ignore files:

```powershell
code-approval-gates init
```

The repository also includes `.code-approval-gates.example.json` as a versioned reference. You do not need to rename that example manually; `code-approval-gates init` creates `.code-approval-gates.json`. At runtime, command-line flags override file configuration.

Read or change configuration:

```powershell
code-approval-gates config get
code-approval-gates config set defaultScope full
code-approval-gates config set baseline.path .quality/baseline/baseline.json
```

Values such as `true`, `false`, and numbers are parsed automatically when possible.
You can also keep `paths`, `excludes`, `includes`, and `ignoreFiles` defaults in `.code-approval-gates.json`. `paths` is used only when the effective scope is `paths`; excludes/includes/ignoreFiles can complement any scope. Command-line flags can complement those filters for a specific run.

### First local run

Easy mode, with wizard/TUI when the terminal is interactive:

```powershell
code-approval-gates
```

The wizard lets you choose the action (run, quality, semantic, baseline, report, config, or doctor), run gates, scope (`changed`, `full`, or `paths`), specific paths, temporary excludes/includes, extra ignore files, the Semantic Gate provider/model when needed, baseline output files, and Doctor fix mode.
For baseline, the wizard suggests `full`; for daily analysis, it suggests `changed`.

Direct mode:

```powershell
code-approval-gates run
```

Headless mode for AI, scripts, or CI:

```powershell
code-approval-gates run --scope changed --json --no-interactive --output .quality/reports/latest
```

`--ci`, `--json`, and `--no-interactive` never open the wizard/TUI, even if `--interactive` is also passed. For AI, scripts, and pipelines, always prefer complete commands with explicit flags.
For automation-parseable help, use `code-approval-gates help run --json --no-interactive`.

Use `--non-blocking` when the pipeline or agent should receive exit code `0` and read approval/failure from the generated reports.

Use `--cwd <dir>` when the tool runs outside the analyzed project root.

### Analysis types

Quick analysis of Git changes:

```powershell
code-approval-gates run --scope changed
```

Specific Git range:

```powershell
code-approval-gates run --scope changed --base origin/main --head HEAD
```

Full project scan:

```powershell
code-approval-gates run --scope full
```

Directory-based scan:

```powershell
code-approval-gates run --scope paths --path apps/web --path packages/core
```

`--path` requires `--scope paths`. For `changed` and `full`, use `--exclude`, `--include`, or ignore files to filter.

Every report declares `scoreAppliesTo`. Use that field to interpret the score:

- `changed-files`: score for recent changes.
- `entire-project`: score for the whole project.
- `selected-paths`: score for the selected files/directories.

Do not present a `changed-files` score as a whole-project score.

Run only Quality Gate:

```powershell
code-approval-gates quality --scope changed
code-approval-gates run --gate quality --scope changed
```

Run only Semantic Gate:

```powershell
code-approval-gates semantic --scope changed --objective-file .quality/objective.md
```

The `--objective-file` path is relative to the analyzed project directory.

Direct semantic objective:

```powershell
code-approval-gates semantic --scope changed --objective "Review architecture, quality, and risks"
code-approval-gates run --gate semantic --scope changed --objective "Review architecture, quality, and risks"
```

Semantic objective through stdin:

```powershell
"Review architecture, quality, and risks" | code-approval-gates semantic --scope full --objective-stdin --json --no-interactive
```

### Ignoring files and directories

The tool supports gitignore-style ignore files.

Supported files:

```text
.code-approval-gates.ignore
.quality-gate.ignore
.semantic-gate.ignore
```

This repository ships those files as templates. In consumer projects, `code-approval-gates init` also creates the same files when they do not exist yet.

Example `.code-approval-gates.ignore`:

```gitignore
node_modules/
dist/
build/
coverage/
.quality/
*.log
*.sqlite
*.db
!generated/schema.json
```

CLI excludes:

```powershell
code-approval-gates run --scope full --exclude "generated/**" --exclude "projects/**/artifacts/**"
```

Re-include a specific file:

```powershell
code-approval-gates run --scope full --exclude "projects/**/artifacts/**" --include "projects/demo/artifacts/schema.json"
```

### Baseline

Use baseline to separate old debt from new problems.

In `baseline create`, `--output` points to the baseline JSON file. The source scan directory is controlled by `--report-output`.

Create baseline using the default source scan, generating that scan if it does not exist yet:

```powershell
code-approval-gates baseline create --output .quality/baseline/baseline.json
```

Create baseline after running a full source scan:

```powershell
code-approval-gates baseline create --scope full --output .quality/baseline/baseline.json --report-output .quality/reports/baseline-source
```

When baseline creates the source scan, you can also pass `--provider`, `--model`, `--reasoning-effort`, `--objective`, `--objective-file`, or `--objective-stdin` to keep the Semantic Gate aligned with the intended review.
Those semantic flags are ignored when `--no-semantic` is used.

Use `--no-semantic` or `--no-quality` only when you want to exclude one gate from the baseline. At least one gate must remain enabled.

Create baseline from an existing report:

```powershell
code-approval-gates baseline create --from-report .quality/reports/full/summary.json --output .quality/baseline/baseline.json
```

Use baseline in daily runs:

```powershell
code-approval-gates run --scope changed --baseline .quality/baseline/baseline.json
```

Check baseline:

```powershell
code-approval-gates baseline check --baseline .quality/baseline/baseline.json
```

If `.code-approval-gates.json` defines `baseline.path`, `baseline create` and `baseline check` use that path when `--output` or `--baseline` are not provided.

The `run` command only uses a baseline when `--baseline <path>` is passed explicitly.

### Doctor

Human-readable diagnostics:

```powershell
code-approval-gates doctor
```

JSON diagnostics for AI/CI:

```powershell
code-approval-gates doctor --json --no-interactive
```

Area-specific diagnostics:

```powershell
code-approval-gates doctor quality
code-approval-gates doctor semantic
code-approval-gates doctor gitlab
```

Create safe missing files:

```powershell
code-approval-gates doctor --fix --yes
```

Explicitly reinstall the package globally:

```powershell
code-approval-gates doctor --install-global
```

`doctor --fix` may create config, default ignores, report directories, install missing local Semantic Gate dependencies, and prepare required local artifacts. It must not save secrets into the repository, delete code, commit, or push.
It also does not install the package globally unless `--install-global` is passed explicitly. In an interactive terminal, `--fix` and `--install-global` without `--yes` ask for confirmation before changing the environment. Use `--yes` to make the intent explicit in scripts, CI, and headless runs.

### Reports

Read an existing report summary:

```powershell
code-approval-gates report summary --report-dir .quality/reports/latest
code-approval-gates report path --report-dir .quality/reports/latest
```

Default local layout:

```text
.quality/reports/latest/summary.json
.quality/reports/latest/summary.md
.quality/reports/latest/quality-report.json
.quality/reports/latest/quality-report.md
.quality/reports/latest/semantic-report.json
.quality/reports/latest/semantic-report.md
.quality/reports/latest/quality-scope.json
.quality/reports/latest/raw/
```

Read the summary:

```powershell
code-approval-gates report summary
```

### GitLab CI

In consumer pipelines, run `code-approval-gates`. Reserve `npm run verify` for validating this repository before release/publishing.

Merge request, analyzing changed files only:

```yaml
code_approval_gates:
  image: node:22
  stage: test
  variables:
    GIT_DEPTH: "0"
  before_script:
    - npm install -g code-approval-gates
  script:
    - code-approval-gates doctor --ci --no-interactive
    - code-approval-gates run --ci --scope changed --format json,md --output code-approval-report --no-interactive
  artifacts:
    when: always
    paths:
      - code-approval-report/
    expire_in: 14 days
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
```

Scheduled full scan:

```yaml
code_approval_full_scan:
  image: node:22
  stage: test
  before_script:
    - npm install -g code-approval-gates
  script:
    - code-approval-gates run --ci --scope full --format json,md --output code-approval-report --no-interactive
  artifacts:
    when: always
    paths:
      - code-approval-report/
    expire_in: 30 days
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule"'
```

### Advanced direct binaries

The package still publishes `quality-check` and `semantic-gate` for advanced usage and compatibility. For users, agents, and CI, prefer `code-approval-gates` because it standardizes scope, ignores, baseline, doctor, wizard, and reports behind one contract.

### Help

```powershell
code-approval-gates --help
code-approval-gates wizard --help
code-approval-gates run --help
code-approval-gates quality --help
code-approval-gates semantic --help
code-approval-gates baseline --help
code-approval-gates baseline create --help
code-approval-gates baseline check --help
code-approval-gates report --help
code-approval-gates report summary --help
code-approval-gates report path --help
code-approval-gates doctor --help
code-approval-gates doctor quality --help
code-approval-gates doctor semantic --help
code-approval-gates doctor gitlab --help
code-approval-gates init --help
code-approval-gates config --help
code-approval-gates config get --help
code-approval-gates config set --help
code-approval-gates config path --help
code-approval-gates version
code-approval-gates help run
```

### Local repository validation

To validate the full package before publishing or using it in CI:

```powershell
npm run verify
```

This command runs syntax checks, root tests, Semantic Gate build/test, Quality Gate tests, and `npm pack --dry-run`.
Use `npm test` for the test set over already generated artifacts; use `npm run verify` before release, CI, or publishing.

---

## Advanced legacy binaries

The package still exposes lower-level binaries for advanced use:

```powershell
quality-check . --scope changed --threshold 90 --format=json,md --output .quality/reports
quality-check . --scope full --threshold 90 --format=json,md --output .quality/reports/full
semantic-gate run --scope changed --objective-file .quality/objective.md --json
semantic-gate run --scope full --objective-file .quality/objective.md --json
```

Prefer `code-approval-gates` for new workflows.


