# MELHORIAS DO CODE-APPROVAL-GATES

## 1) Objetivo esperado (o que queremos que a ferramenta faça)

Padronizar a experiência de análise de qualidade e revisão semântica em um único contrato:

- escolher escopo de análise (`changed`, `full`, `paths`) com padrão `changed`;
- suportar filtros por `--path`, `--exclude`, `--include`, `--ignore-file`;
- executar em modo `run`, `quality` e `semantic` com escopo independente;
- manter compatibilidade de outputs para agentes e CI (`--json --no-interactive --ci`);
- manter o wizard/TUI apenas como camada de conveniência para humanos;
- incluir `doctor` para diagnóstico e correções seguras;
- manter relatório único com `scoreAppliesTo` explícito;
- publicar README/ajuda/skills em PT-BR + EN.

## 2) Estado atual (o que já existe e foi implementado)

- CLI principal (`bin/code-approval-gates.js`) com escopo unificado (`changed|full|paths`).
- `run`, `quality`, `semantic`, `baseline`, `report`, `config`, `doctor`, `wizard` e `help`.
- `--scope changed` como padrão e validação de `--path` somente com `--scope paths`.
- Suporte a ignores em estilo gitignore:
  - `.code-approval-gates.ignore`
  - `.quality-gate.ignore`
  - `.semantic-gate.ignore`
  - `--ignore-file`
- `--exclude`/`--include` em todos os modos de análise.
- `scoreAppliesTo` em `summary` (`changed-files`, `entire-project`, `selected-paths`).
- `help --json` com payload estável e contrato de erro padronizado.
- `baseline create` e `baseline check` com default seguro (`full` para create).
- `doctor` com foco por área (`all`, `quality`, `semantic`, `gitlab`) + `--fix` + `--install-global`.
- TUI/Wizard com fluxo para human mode e exibição do comando equivalente.
- `quality-gate` e `semantic-gate` com escopo `changed|full|paths`.
- READMEs bilíngues (PT/EN) com exemplos para local, IA e CI.
- `use-*/SKILL.md` e prompts de agentes atualizados.
- Exemplos GitLab/GitHub para execução headless.

## 3) Justificativa de negócio

1. **Produtividade**  
   A maioria dos ciclos de revisão é sobre delta recente; `changed` deve ser o padrão, com `full` opcional para baseline/release.

2. **Redução de custo de operação**  
   Evitar varrer o repositório inteiro por padrão reduz tempo de feedback e custo de CI.

3. **Confiabilidade de automação**  
   `--json --no-interactive --ci` e códigos/erros estáveis tornam o uso por agentes previsível.

4. **Governança de escopo**  
   Separar `scope` e ignorances por arquivo evita falso negativo em `changed` e torna scans `full`/`paths` controláveis.

5. **Segurança e previsibilidade operacional**  
   `doctor` centraliza pré-condições e não faz mudanças destrutivas por padrão.

## 4) Melhorias planejadas e status

## 4.1) CLI/unificado e contratos de escopo (Concluído)
- **Esperado**: um único ponto de entrada com `changed/full/paths` em todas operações de análise.
- **Justificativa**: evitar inconsistência entre gates.
- **Implementado em**: `bin/code-approval-gates.js`, `quality-gate/bin/quality-check.js`, `semantic-gate` (`args`, `context`, `run`).

## 4.2) Wizard/TUI padrão e não-invasivo (Concluído)
- **Esperado**: wizard só para ambiente interativo; não abre em modo CI/headless.
- **Justificativa**: preservar automação e IA com comportamento determinístico.
- **Implementado em**: `runWizard`, `main` (detecção de headless).

## 4.3) Ignores e filtros consistentes por arquivo de configuração (Concluído)
- **Esperado**: mesma gramática de ignore entre gates e baseline, com `!path` para reinclusão.
- **Justificativa**: evitar divergência entre quality/semantic por diferentes regras de seleção.
- **Implementado em**: `buildIgnoreRules`, arquivos `.code-approval-gates.ignore`, `.quality-gate.ignore`, `.semantic-gate.ignore`.

## 4.4) Diagnóstico e auto-reparo (`doctor`) (Concluído)
- **Esperado**: checagem de pré-requisitos locais/CI e reparo seguro opcional.
- **Justificativa**: reduzir tempo de setup e diminuir falso erro por ambiente.
- **Implementado em**: `handleDoctor`, checks de node/npm/git/docker/arquivos, e fixes selecionados.

## 4.5) Documentação e experiência bilíngue (Concluído)
- **Esperado**: README PT/EN + ajuda detalhada com exemplos headless e CI.
- **Justificativa**: reduzir suporte e acelerar adoção.
- **Implementado em**: `README.md`, `quality-gate/README.md`, `semantic-gate/README.md`, `helpFor`.

## 4.6) Habilitação de IA/pipeline (Concluído)
- **Esperado**: operações sem prompt para IA e CI, incluindo comando equivalente exibido no wizard.
- **Justificativa**: previsibilidade para automações e agentes.
- **Implementado em**: flags headless (`--ci`, `--json`, `--no-interactive`), `buildEquivalentCommand`, exemplos de CI.

## 5) Entrega atual (status)

- **Percentual consolidado**: `100%` para o escopo pedido de produto (CLI unificado com escopo/ignores/wizard/doctor/headless/docs/skills).
- **Próximas iterações opcionais** (quando necessário):
  - ajustar mensagens de erro e textos de ajuda por idioma com sinônimos adicionais;
  - ampliar testes de contrato para cenários de erro mais diversos;
  - incluir painéis de output mais curtos para UX de relatório.

## 6) Execução recomendada (humano, IA, CI)

### Humano diário
```powershell
code-approval-gates
```

### Humano direto (alterações)
```powershell
code-approval-gates run --scope changed --json --no-interactive --output .quality/reports/latest
```

### Diretórios específicos
```powershell
code-approval-gates run --scope paths --path docs --path apps/web --json --no-interactive
```

### Análise completa
```powershell
code-approval-gates run --scope full --json --no-interactive --output .quality/reports/full
```

### IA/CI
```powershell
code-approval-gates run --scope changed --json --ci --no-interactive --output code-approval-report
```

### Diagnóstico
```powershell
code-approval-gates doctor --ci --no-interactive
```
