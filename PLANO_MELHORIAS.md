# Plano de melhorias dos Code Approval Gates

Data: 2026-07-02

## 1. Direcao do plano

Os Code Approval Gates devem evoluir para uma ferramenta simples para humanos, deterministica para IA/agentes e segura para pipelines.

A prioridade de produto deve seguir esta ordem:

1. Primeiro consolidar o contrato CLI/headless.
2. Depois implementar o wizard/TUI usando o mesmo contrato.
3. Depois melhorar UX visual, mensagens e conveniencias interativas.

Motivo: CI, GitLab, scripts e agentes de IA precisam de comportamento previsivel. O wizard deve facilitar o uso humano, mas nao pode criar funcionalidades que so existam em modo interativo.

Nao e necessario manter compatibilidade com comandos antigos. A ferramenta ainda nao tem usuarios ativos o suficiente para justificar carregar uma UX ruim para sempre.

## 2. Objetivo esperado

A ferramenta deve permitir escolher claramente o escopo da analise:

1. `changed`: analisa apenas as ultimas alteracoes detectadas pelo Git. Deve ser o padrao para uso diario.
2. `full`: analisa o projeto inteiro. Deve ser usado para auditoria inicial, baseline, release e scans periodicos.
3. `paths`: analisa diretorios ou arquivos especificos, com suporte a includes e excludes.

A ferramenta deve funcionar bem em quatro contextos:

1. Usuario local usando comandos diretos.
2. Usuario local usando wizard/TUI.
3. IA/agente rodando em modo headless.
4. Pipeline GitLab rodando sem qualquer prompt.

## 3. Principios obrigatorios

### 3.1 CLI/headless e a fonte de verdade

Tudo deve ser possivel por flags.

O wizard/TUI nao deve conter regra de negocio exclusiva. Ele deve apenas montar opcoes e gerar o mesmo comando que poderia ser executado manualmente.

Toda escolha disponivel na TUI deve ter uma flag equivalente.

### 3.2 TUI e camada de conveniencia

A TUI deve existir para ajudar usuarios leigos a escolher tipo de analise, escopo, gates, relatorios, baseline, provider/modelo e doctor.

Ela deve abrir apenas em terminal interativo e nunca em CI, scripts, IA ou modo JSON.

### 3.3 Headless precisa ser amigavel para IA

Agentes e automacoes precisam conseguir executar tudo sem input humano.

Regras obrigatorias:

- `--ci` implica `--no-interactive`.
- `--json` nunca imprime menus, spinners ou texto decorativo.
- `--no-interactive` nunca pergunta nada.
- Erros em headless devem ter codigo estavel, mensagem curta e sugestao de correcao.
- Se faltar informacao obrigatoria, a ferramenta deve falhar claramente, nao abrir wizard.

### 3.4 Score sempre declara o que representa

Todo relatorio deve deixar explicito o escopo real do score.

Valores esperados:

```json
{
  "scope": "changed",
  "scoreAppliesTo": "changed-files"
}
```

Mapeamento obrigatorio:

- `changed` -> `changed-files`
- `full` -> `entire-project`
- `paths` -> `selected-paths`

O score de diff nunca deve ser vendido como score do projeto inteiro.

## 4. Contrato de comandos desejado

Comando principal:

```powershell
code-approval-gates <command> [options]
```

Comandos principais:

```powershell
code-approval-gates run
code-approval-gates quality
code-approval-gates semantic
code-approval-gates wizard
code-approval-gates doctor
code-approval-gates baseline create
code-approval-gates baseline check
code-approval-gates report summary
code-approval-gates report open
code-approval-gates report path
code-approval-gates config get
code-approval-gates config set
code-approval-gates help
```

O comando `help` deve listar todos os comandos reais e flags atuais.

Exemplos:

```powershell
code-approval-gates help
code-approval-gates help run
code-approval-gates help doctor
code-approval-gates help baseline create
code-approval-gates help --json
```

`help --json` deve ser estavel para IA/agentes.

## 5. Comando `run`

Executa `quality`, `semantic` ou ambos.

Padrao recomendado:

```powershell
code-approval-gates run
```

Equivalente logico:

```powershell
code-approval-gates run --scope changed --gate both
```

Exemplos:

```powershell
code-approval-gates run --scope changed
code-approval-gates run --scope changed --base origin/main --head HEAD
code-approval-gates run --scope full
code-approval-gates run --scope paths --path apps/web --path packages/core
code-approval-gates run --gate quality --scope changed
code-approval-gates run --gate semantic --scope changed --objective-file objective.md
code-approval-gates run --gate both --scope full --threshold 90
```

Flags principais:

```text
--gate quality|semantic|both
--scope changed|full|paths
--base <ref>
--head <ref>
--path <path>
--exclude <glob>
--include <glob>
--ignore-file <path>
--threshold <number>
--format json|md|json,md|html
--output <dir>
--baseline <file>
--save-baseline [file]
--objective-file <file>
--objective-stdin
--provider <provider>
--model <model>
--blocking
--non-blocking
--ci
--json
--interactive
--no-interactive
```

Regras:

- `changed` deve ser o padrao.
- `paths` exige pelo menos um `--path`.
- `--path` so deve limitar analise quando `--scope paths` estiver ativo.
- `full` nao deve ser reduzido por diff Git.
- `semantic` em headless deve exigir objetivo explicito ou usar objetivo padrao documentado.

## 6. Escopos

### 6.1 `changed`

Objetivo: ser rapido para o dia a dia.

Deve analisar arquivos modificados, adicionados, renomeados e removidos quando fizer sentido.

Fontes de base/head:

- flags `--base` e `--head`, quando informadas;
- variaveis GitLab em merge request;
- upstream da branch;
- branch principal detectada.

Exemplo:

```powershell
code-approval-gates run --scope changed --base origin/main --head HEAD
```

### 6.2 `full`

Objetivo: auditoria completa, baseline inicial, release e scan periodico.

Deve respeitar `.gitignore` e ignores especificos da ferramenta.

Exemplo:

```powershell
code-approval-gates run --scope full --format json,md --output .quality/reports/full
```

### 6.3 `paths`

Objetivo: analisar partes especificas do projeto ou monorepo.

Exemplo:

```powershell
code-approval-gates run --scope paths --path docs --path apps/web --exclude "**/*.lock"
```

## 7. Includes, excludes e arquivos de ignore

Criar suporte a arquivos de ignore no estilo `.gitignore`:

```text
.code-approval-gates.ignore
.quality-gate.ignore
.semantic-gate.ignore
```

Funcoes:

- `.code-approval-gates.ignore`: regras comuns para ambos os gates.
- `.quality-gate.ignore`: regras especificas do Quality Gate.
- `.semantic-gate.ignore`: regras especificas do Semantic Gate.

Precedencia recomendada:

1. `.gitignore`.
2. `.code-approval-gates.ignore`.
3. `.quality-gate.ignore` ou `.semantic-gate.ignore`.
4. `--exclude`.
5. `--include`, para reincluir algo especifico.

Exemplo:

```powershell
code-approval-gates run --scope full --exclude "projects/**/artifacts/**" --include "projects/demo/artifacts/schema.json"
```

## 8. Resolvedor compartilhado de escopo

Criar um modulo unico para resolver arquivos analisaveis.

Responsabilidades:

- resolver `changed`, `full` e `paths`;
- ler `.gitignore` e ignores especificos;
- aplicar `--exclude` e `--include`;
- normalizar paths no Windows, Linux e GitLab CI;
- retornar arquivos finais;
- retornar estatisticas para relatorios;
- retornar quais arquivos foram ignorados e por qual regra.

Esse modulo deve ser usado por `run`, `quality`, `semantic`, `baseline` e `doctor` quando aplicavel.

## 9. Quality Gate

O Quality Gate deve aceitar os mesmos escopos da CLI principal.

Exemplos:

```powershell
code-approval-gates quality --scope changed
code-approval-gates quality --scope full
code-approval-gates quality --scope paths --path apps/web
```

Classificar validadores:

1. File-scoped: linters, format checks, Semgrep por arquivo, validadores JSON/YAML/Markdown.
2. Repo-scoped: checks que dependem da arvore completa.
3. Dependency-scoped: OSV, Trivy, Grype, SBOM, lockfiles.
4. Optional/heavy: scans lentos e duplicacao profunda.

Comportamento:

- `changed`: rodar validadores por arquivo apenas nos alterados; rodar dependency-scoped apenas se manifests/lockfiles mudaram.
- `full`: rodar validadores habilitados no projeto inteiro.
- `paths`: limitar aos paths informados e declarar limites no relatorio.

## 10. Semantic Gate

O Semantic Gate deve aceitar os mesmos escopos da CLI principal.

Exemplos:

```powershell
code-approval-gates semantic --scope changed --objective-file objective.md
code-approval-gates semantic --scope full --objective-file objective.md
code-approval-gates semantic --scope paths --path docs --path apps/web --objective-file objective.md
```

Tambem deve aceitar objetivo por stdin:

```powershell
"Avaliar riscos arquiteturais" | code-approval-gates semantic --scope changed --objective-stdin --json --no-interactive
```

Regras de contexto:

- `changed`: usar diff Git, arquivos alterados e contexto relevante.
- `full`: nao enviar repo bruto inteiro; montar contexto com inventario, README, manifests, docs de arquitetura, ADRs, arquivos principais e relatorio do quality gate.
- `paths`: limitar contexto aos paths informados.

Relatorio semantico deve incluir:

- objetivo usado;
- scope;
- `scoreAppliesTo`;
- base/head;
- paths analisados;
- arquivos lidos;
- arquivos omitidos por limite;
- provider/modelo;
- riscos;
- recomendacoes;
- decisao final.

## 11. Baseline

Baseline serve para separar divida antiga de problemas novos.

Comandos:

```powershell
code-approval-gates baseline create --scope full --output .quality/baseline/full.json
code-approval-gates baseline check --baseline .quality/baseline/full.json
code-approval-gates run --scope changed --baseline .quality/baseline/full.json
```

Regras:

- `baseline create` deve usar `full` como padrao.
- Problemas antigos nao devem bloquear o run diario se estiverem no baseline.
- Problemas novos devem bloquear conforme threshold.
- Problemas resolvidos devem aparecer como melhoria.

## 12. Doctor

O `doctor` deve diagnosticar e, quando seguro, corrigir problemas.

Comandos:

```powershell
code-approval-gates doctor
code-approval-gates doctor quality
code-approval-gates doctor semantic
code-approval-gates doctor gitlab
code-approval-gates doctor --json --no-interactive
code-approval-gates doctor --fix
code-approval-gates doctor --fix --yes
```

Verificacoes:

- Node.js e versao minima;
- npm/pnpm/yarn quando relevante;
- Git instalado;
- repositorio Git valido;
- base/head resolviveis;
- permissao de escrita em relatorios;
- Docker e sidecar quando o quality gate precisar;
- provider/modelo para semantic gate;
- credenciais por variavel de ambiente ou config local;
- CLI externa quando provider for `codex-cli`, `opencode`, `gemini-cli` ou similar;
- variaveis GitLab CI;
- profundidade do clone no GitLab;
- arquivos de ignore invalidos;
- config invalida.

Reparos seguros:

- criar `.quality/reports`;
- criar ignores padrao;
- criar config basica;
- baixar/buildar imagem local quando documentado;
- gerar snippet de GitLab CI;
- configurar provider/modelo sem salvar segredo no repo.

Reparos que exigem confirmacao:

- `npm install -g`;
- instalar/iniciar Docker Desktop;
- salvar credencial localmente;
- alterar `.gitlab-ci.yml`;
- alterar arquivos do projeto do usuario.

Proibido:

- commitar ou fazer push;
- apagar arquivos do projeto;
- salvar secrets no repositorio;
- rodar comando destrutivo;
- abrir prompt em `--ci`, `--json` ou `--no-interactive`.

## 13. Wizard/TUI

O wizard deve ser padronizado entre comandos.

Entrada explicita:

```powershell
code-approval-gates wizard
code-approval-gates run --interactive
```

Entrada implicita permitida somente em TTY:

```powershell
code-approval-gates
```

Fluxo minimo:

1. Escolher acao: run, quality, semantic, baseline, doctor, report ou config.
2. Escolher gates: quality, semantic ou both.
3. Escolher escopo: changed, full ou paths.
4. Configurar detalhes do escopo.
5. Configurar threshold, formato e output.
6. Configurar baseline.
7. Configurar objetivo do semantic gate.
8. Configurar provider/modelo quando necessario.
9. Mostrar comando equivalente.
10. Confirmar execucao.

A TUI deve sempre mostrar o comando equivalente antes de executar.

Exemplo:

```text
Comando equivalente:
code-approval-gates run --scope paths --path docs --path apps/web --gate both --format json,md --output .quality/reports/paths
```

## 14. Modo headless para IA/agentes

Comandos recomendados para IA:

```powershell
code-approval-gates doctor --json --no-interactive
code-approval-gates run --scope changed --json --no-interactive --output .quality/reports/latest
code-approval-gates run --scope full --format json,md --no-interactive --output .quality/reports/full
code-approval-gates quality --scope changed --json --no-interactive
code-approval-gates semantic --scope changed --objective-file objective.md --json --no-interactive
```

Contrato JSON minimo:

```json
{
  "status": "NEEDS_CHANGES",
  "scope": "changed",
  "scoreAppliesTo": "changed-files",
  "mode": "headless",
  "interactive": false,
  "ci": false,
  "qualityScore": 82,
  "semanticScore": 88,
  "finalScore": 85,
  "threshold": 90,
  "reports": {
    "summaryJson": ".quality/reports/latest/summary.json",
    "summaryMarkdown": ".quality/reports/latest/summary.md"
  },
  "exitCode": 1
}
```

Contrato de erro:

```json
{
  "status": "ERROR",
  "error": {
    "code": "MISSING_OBJECTIVE",
    "message": "Semantic Gate requires an objective in headless mode.",
    "fix": "Use --objective-file objective.md or --objective-stdin."
  },
  "exitCode": 5
}
```

## 15. GitLab CI

A ferramenta deve continuar funcional em GitLab sem prompt.

Merge request:

```yaml
code_approval_gates:
  image: node:22
  stage: test
  before_script:
    - npm ci
  script:
    - npx code-approval-gates doctor gitlab --ci --no-interactive
    - npx code-approval-gates run --scope changed --ci --no-interactive --format json,md --output code-approval-report
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
    - npm ci
  script:
    - npx code-approval-gates run --scope full --ci --no-interactive --format json,md --output code-approval-report
  artifacts:
    when: always
    paths:
      - code-approval-report/
    expire_in: 30 days
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule"'
```

## 16. README e documentacao

Atualizar o README principal e READMEs dos gates.

O README principal deve manter explicacao em Portugues e Ingles.

Secoes em Portugues:

- O que e.
- Quando usar.
- Instalacao.
- Primeiro uso local.
- Usando wizard.
- Modo headless para IA/scripts.
- Analise rapida de alteracoes.
- Analise completa.
- Analise por diretorios.
- Baseline.
- Ignorando arquivos e diretorios.
- Semantic Gate e provider/modelo.
- GitLab CI.
- Entendendo relatorios.
- Doctor e troubleshooting.

Secoes em English:

- What it is.
- When to use.
- Installation.
- First local run.
- Using the wizard.
- Headless mode for AI/scripts.
- Quick changed-files analysis.
- Full project analysis.
- Path-based analysis.
- Baseline.
- Ignoring files and directories.
- Semantic Gate and provider/model.
- GitLab CI.
- Understanding reports.
- Doctor and troubleshooting.

Regras:

- Nao documentar recurso em apenas um idioma.
- Ensinar comandos simples primeiro.
- Explicar `scoreAppliesTo`.
- Ensinar quando usar `changed`, `full` e `paths`.
- Mostrar exemplos para humano, IA e GitLab.

## 17. Skills de execucao

Atualizar skills que ensinam agentes/IA a executar os gates.

Arquivos esperados:

```text
use-quality-gate/SKILL.md
use-semantic-gate/SKILL.md
quality-gate/skill/quality-gate.md
use-quality-gate/agents/openai.yaml
use-semantic-gate/agents/openai.yaml
```

As skills devem orientar agentes a:

- preferir `code-approval-gates` quando disponivel;
- usar `--json --no-interactive` por padrao;
- usar `--ci --no-interactive` em pipeline;
- escolher `changed` para revisao diaria;
- escolher `full` para auditoria, baseline e release;
- escolher `paths` quando o usuario pedir diretorios especificos;
- nunca chamar wizard em automacao;
- interpretar `scoreAppliesTo` antes de resumir pontuacao;
- reportar caminhos dos relatorios gerados;
- sugerir `doctor` em falhas de ambiente.

Comandos recomendados para skills:

```powershell
code-approval-gates doctor --json --no-interactive
code-approval-gates run --scope changed --json --no-interactive --output .quality/reports/latest
code-approval-gates run --scope full --format json,md --no-interactive --output .quality/reports/full
```

## 18. Help da CLI

Todo comando deve ter help atualizado.

Obrigatorio:

```powershell
code-approval-gates --help
code-approval-gates help
code-approval-gates help --json
code-approval-gates run --help
code-approval-gates quality --help
code-approval-gates semantic --help
code-approval-gates wizard --help
code-approval-gates doctor --help
code-approval-gates baseline --help
code-approval-gates baseline create --help
code-approval-gates baseline check --help
code-approval-gates report --help
code-approval-gates config --help
```

Cada help deve conter:

- descricao curta;
- uso;
- flags;
- defaults;
- exemplos;
- comportamento interativo/headless;
- observacoes de CI quando aplicavel;
- codigos de erro comuns quando fizer sentido.

Evitar drift entre README e help criando uma especificacao unica de comandos, opcoes, defaults e exemplos.

## 19. Ordem de implementacao

1. Definir especificacao unica de comandos, flags, defaults, exemplos e validacoes.
2. Fazer parser/headless consumir essa especificacao.
3. Fazer `help` e `help --json` consumirem essa especificacao.
4. Implementar detector de modo interativo/headless.
5. Implementar resolvedor compartilhado de escopo.
6. Implementar ignores comuns e especificos.
7. Implementar `--include`, `--exclude`, `--path`, `--base` e `--head` de forma consistente.
8. Garantir `scoreAppliesTo` em todos os relatorios.
9. Adaptar Quality Gate aos escopos.
10. Adaptar Semantic Gate aos escopos e ao contexto por escopo.
11. Implementar baseline create/check.
12. Implementar wrapper `run` consolidado.
13. Implementar saida JSON estavel e codigos de erro.
14. Implementar `doctor` diagnostico.
15. Implementar `doctor --fix` com reparos seguros.
16. Implementar wizard/TUI consumindo a mesma especificacao da CLI.
17. Atualizar GitLab CI examples.
18. Atualizar README bilingue.
19. Atualizar skills para IA/agentes.
20. Atualizar testes dos fluxos principais.

## 20. Criterios de aceite

1. `code-approval-gates run` usa `changed` por padrao.
2. `code-approval-gates run --scope full` analisa o projeto inteiro respeitando ignores.
3. `code-approval-gates run --scope paths --path <path>` limita analise aos paths informados.
4. Quality Gate e Semantic Gate aceitam os mesmos escopos.
5. `.code-approval-gates.ignore`, `.quality-gate.ignore` e `.semantic-gate.ignore` sao aplicados.
6. `--exclude` e `--include` funcionam em todos os escopos aplicaveis.
7. Todo relatorio contem `scoreAppliesTo`.
8. Baseline completo pode ser criado e usado no run diario.
9. `--ci` nunca abre TUI.
10. `--json` nunca imprime saida decorativa.
11. `--no-interactive` nunca pergunta nada.
12. Wizard mostra comando equivalente antes de executar.
13. Tudo que existe no wizard pode ser executado por flags.
14. `doctor` diagnostica ambiente local, quality, semantic e GitLab.
15. `doctor --fix` corrige apenas itens seguros e pede confirmacao quando necessario.
16. `doctor --fix --yes --no-interactive` funciona para automacao quando a acao for segura.
17. README ensina uso humano, headless e GitLab em Portugues e Ingles.
18. Skills ensinam agentes a usar headless e interpretar `scoreAppliesTo`.
19. Help lista todos os comandos e flags reais.
20. GitLab CI gera relatorios como artifacts sem prompt.

## 21. Resultado final esperado

Uso humano guiado:

```powershell
code-approval-gates
```

Uso humano direto:

```powershell
code-approval-gates run --scope changed
```

Uso IA/headless:

```powershell
code-approval-gates run --scope changed --json --no-interactive --output .quality/reports/latest
```

Uso scan completo:

```powershell
code-approval-gates run --scope full --format json,md --no-interactive --output .quality/reports/full
```

Uso GitLab:

```powershell
code-approval-gates run --scope changed --ci --no-interactive --format json,md --output code-approval-report
```

A experiencia humana pode ser guiada por TUI, mas a base da ferramenta deve continuar scriptavel, testavel, previsivel e segura para IA/pipelines.
