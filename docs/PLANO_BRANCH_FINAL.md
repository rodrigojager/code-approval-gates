# Plano de integração e acompanhamento da branch `final`

> **Registro histórico:** a branch `final` foi integrada e aposentada. `main` é a única linha canônica; `generic` e `dotnetweb` são flavors publicados por tags e digests, não por branches.

Este documento transforma o inventário inicial em checklist auditável. Ele permanece no repositório para que código, testes, publicação e implantação possam ser comparados com o plano original sem depender de conversas externas.

Atualize a coluna **Estado** somente com evidência verificável. Não marque uma ação externa como concluída porque o código correspondente existe.

## Legenda

| Estado | Significado |
| --- | --- |
| CONCLUÍDO | implementado e coberto por evidência local/CI indicada |
| EM VALIDAÇÃO | implementação presente, mas validação ampla ou integração ainda pendente |
| PENDENTE EXTERNO | depende de GitHub/GHCR/GitLab/runner/empresa |
| PENDENTE | trabalho de código/documentação ainda não comprovado |
| FORA DE ESCOPO AGORA | preservado, sem evolução nesta fase |
| NÃO SE APLICA | condição dispensada pela decisão ou arquitetura atual |

## Baseline e composição

| Item | Estado | Evidência esperada |
| --- | --- | --- |
| Criar `final` a partir de `origin/main` | CONCLUÍDO | histórico Git da branch |
| Integrar a camada language-agnostic | CONCLUÍDO | merge no histórico e arquivos policy/evidence |
| Integrar a fundação GitLab/GHCR | CONCLUÍDO | merge no histórico e workflow/template |
| Resolver conflitos sem apagar funcionalidades | CONCLUÍDO | `npm run verify`, image smokes, checks remotos e diff final |
| Manter Semantic Gate sem novo desenvolvimento | FORA DE ESCOPO AGORA | suite Semantic como regressão |
| Preservar documentação PT/EN | CONCLUÍDO | README e tutoriais PT-BR/EN |

Branches inventariadas na criação do plano:

- `main` em `a0bc153`;
- `agent/language-agnostic-quality-gates` em `5d5f667`;
- `agent/gitlab-quality-gate-ghcr` em `446a51c`.

### Inventário funcional por branch de origem

| Branch | Conteúdo mais relevante | Escala do diff contra `main` |
| --- | --- | ---: |
| `main` | CLI unificada `code-approval-gates`, execução local dos dois gates, doctor/wizard/report/baseline, Quality Gate e Semantic Gate como baseline de regressão | baseline |
| `agent/language-agnostic-quality-gates` | budgets independentes de linguagem, change requirements, evidence neutra, JUnit, grafos de dependência, métricas/relatórios e testes correspondentes | 22 arquivos, `+2126/-30` |
| `agent/gitlab-quality-gate-ghcr` | Docker/GHCR, toolchain de scanners, workflow de imagem, template GitLab e tutorial de implantação | 15 arquivos, `+1386/-182` |

Lacunas encontradas nas implementações de origem e tratadas ou mantidas como pendência explícita na `final`:

- refs/head/diff e artifacts podiam falhar abertos ou confiar em variáveis controláveis pelo job;
- policy, waiver e evidence tinham integridade por hash, mas autoridade insuficiente quando path/digest vinham do próprio MR;
- imagem/tag mutável, execução root e exposição do checkout completo ampliavam a superfície;
- configs/suppressions por scanner e C#/MSBuild ainda não formam uma fronteira completamente governada;
- fallback/mode e documentação permitiam interpretar scans incompletos como equivalentes a full;
- templates de Sonar e credenciais precisavam permanecer sob responsabilidade do job corporativo hardened.

## Fase 1 — Correção fail-closed

| Item planejado | Estado | Evidência/arquivo |
| --- | --- | --- |
| Validar base/head e nunca converter falha Git em diff vazio | CONCLUÍDO no runtime GitLab e wrapper local | `quality_sidecar/ci.py`, testes de base inválida/injeção e exit operacional 3 |
| Derivar base de `origin/<target-branch>` governada, não de diff-base do job | CONCLUÍDO | `quality-ci`, template e teste adversarial |
| Derivar checkout/head do Git real e recusar mismatch de variáveis | CONCLUÍDO | `_trusted_checkout` + testes de spoof |
| Diferenciar diff vazio de diff indisponível | CONCLUÍDO no runtime GitLab | manifesto com status e erro operacional 3 |
| Full scan não cair silenciosamente para offline | CONCLUÍDO no runtime GitLab | sidecar sempre `--mode full --fail-on-tool-error` |
| Findings do MegaLinter afetarem a decisão | CONCLUÍDO localmente | full-clean aprova; full-finding rejeita nas duas flavors |
| Corrigir path da configuração MegaLinter | CONCLUÍDO localmente | configs ESLint/TFLint root-owned e full smokes reais |
| Neutralizar configs/suppressions por analisador e risco C#/MSBuild | PENDENTE | inventário por linter; piloto continua advisory |
| Corrigir clean-clone verify/bootstrap | CONCLUÍDO | clone local sem hardlinks + CI remoto Linux/Windows |
| Filtrar `diffBytes` pelos arquivos selecionados | CONCLUÍDO no runtime GitLab | `_diff_metrics` usa pathspec selecionado |
| Não contar suporte como arquivo alterado | CONCLUÍDO | manifesto separa `selectedFiles`/`supportFiles`; testes de budgets |

## Fase 2 — Política e evidência confiáveis

| Item planejado | Estado | Evidência/arquivo |
| --- | --- | --- |
| Política corporativa externa/governada | CONCLUÍDO em contrato; PENDENTE EXTERNO na empresa | policy file + SHA obrigatórios |
| Impedir `budgets.enabled=false` | CONCLUÍDO | validação de `quality-ci` |
| Impedir profile/threshold/budgets mais fracos | CONCLUÍDO no launcher | contrato fixo standard/90 + ceilings da policy |
| Defesa em profundidade no sidecar | CONCLUÍDO | `--require-policy --policy-sha256` |
| Evidência vinculada a commit/produtor/versão/data | CONCLUÍDO no contrato local; PENDENTE no launcher GitLab | provenance JSON/JUnit e schemas; mappings precisam ser governados |
| Recusar evidence stale | CONCLUÍDO | default 86.400 segundos |
| SHA de artifacts no relatório | CONCLUÍDO | módulo provenance/report |
| Contratos JSON estritos/versionados | CONCLUÍDO | `quality-gate/schemas/*.schema.json` |
| Waiver sob autoridade corporativa | CONCLUÍDO no piloto inicial | launcher recusa waiver do job/MR; exceção somente na policy governada |
| Assinatura criptográfica da evidência | PENDENTE | hardening posterior; provenance atual não assina resultados |

## Fase 3 — Runtime GitLab container-native

| Item planejado | Estado | Evidência/arquivo |
| --- | --- | --- |
| Comando `quality-ci` instalado na imagem | CONCLUÍDO | `pyproject.toml` e `quality_sidecar/ci.py` |
| Escopos `changed`, `full` e `paths` | CONCLUÍDO no resolver local; `changed` fixo no launcher | flags de scope/path são recusadas no GitLab |
| Manifesto compatível `quality-scope.json` | CONCLUÍDO | schema + artifact normalizado |
| Projection sem Docker interno | CONCLUÍDO | `git archive` do commit em `.quality/scopes`; `.git`/worktree não chegam aos scanners |
| Preservar exit 0/1/2/3 | CONCLUÍDO | retorno direto do sidecar + testes |
| Não executar código de testes do MR por padrão | CONCLUÍDO | sidecar default e ausência de `--run-project-tests` |
| Consumir JUnit/Cobertura/grafo/evidence | PENDENTE no launcher GitLab | contrato local preservado; paths/enablement exigem config root-owned/policy |
| Remover tokens/command override do ambiente de scanners | CONCLUÍDO localmente no launcher/imagem | `env -i`, allowlist estreita, transport root-owned e smoke de env poisoning |
| Rejeitar source symlink/gitlink e worktree rastreado sujo | CONCLUÍDO | validação Git + testes adversariais |
| Locale `en`/`pt-BR` com fallback | CONCLUÍDO parcialmente | catálogo comum; scanners externos não são traduzidos |

## Fase 4 — Imagem e supply chain

| Item planejado | Estado | Evidência/arquivo |
| --- | --- | --- |
| Dockerfile com versões/checksums pinados | CONCLUÍDO | Dockerfile, builds das duas flavors e pinos MegaLinter v9.6.0/Alpine 3.24 auditados |
| Compatibilidade da base MegaLinter em runners Intel | CONCLUÍDO | v9.6.0/Alpine 3.24 fixada por digest e Semgrep 1.170.0 validados no CI |
| Corrigir conflitos pip e executar `pip check` | CONCLUÍDO localmente | build-smoke nos três venvs isolados |
| Flavor genérica preservada | CONCLUÍDO | build/smokes `generic` no release e na revalidação de `main` |
| Flavor inicial `.NET web` explícita | CONCLUÍDO | build/smokes `dotnetweb` no release e na revalidação de `main` |
| Tool version smoke | CONCLUÍDO | build + quick smoke nas duas flavors |
| Full scanner smoke saudável | CONCLUÍDO | full-clean/full-finding aprovados nas duas flavors |
| Isolar outputs dos analisadores project-mode | CONCLUÍDO | DevSkim ignora `.quality/**`; smoke remoto confirma canário HTTP e isolamento do SBOM CycloneDX |
| Terrascan dedicado na flavor `generic` | CONCLUÍDO | MegaLinter desabilita `TERRAFORM_TERRASCAN`; Terrascan v1.19.9 passou no CI em project mode sobre projeção temporária Terraform, preservando regras cross-file e falha fechada para `scan_errors` |
| Sustentação do Terrascan | RISCO ACEITO; MIGRAÇÃO PENDENTE | o [repositório oficial foi arquivado em 20/11/2025](https://github.com/tenable/terrascan); manter v1.19.9 pinado para preservar cobertura agora e avaliar substituto mantido em shadow mode, sem remover a ferramenta até comprovar paridade de regras cross-file, evidência e política de bloqueio |
| Fixture com finding e erro operacional | CONCLUÍDO localmente | full-finding e tool-error |
| Execução non-root validada | CONCLUÍDO localmente | UID/GID 10001 no quick smoke |
| `PATH` e toolchains protegidos na execução non-root | CONCLUÍDO localmente | launcher recompõe `PATH` root-owned; smokes executam scanners como UID/GID 10001 |
| Scan Trivy da imagem | CONCLUÍDO | release `quality-v0.3.0` e revalidação de `main` chegaram a zero `CRITICAL` corrigível nas duas flavors; relatórios separados foram preservados como artifacts |
| SBOM e proveniência de build | CONCLUÍDO | tag real gerou SBOM, proveniência e atestação OCI |
| Arquitetura `linux/amd64` | CONCLUÍDO como limite inicial | workflow/docs; outras arquiteturas não prometidas |
| Inputs runtime mutáveis registrados | CONCLUÍDO | `analysisInput` registra o bundle pinado do Terrascan e `runtimeInputs` registra `registry.terraform.io` como não pinado/network-required, além dos inputs de Semgrep, Trivy e OSV; rede/cache continuam parte do ambiente de execução |
| Transport proxy/CA root-owned sem credenciais | CONCLUÍDO localmente; PENDENTE EXTERNO no runner | `/etc/code-approval/quality-gate-transport.env`, UID 10001/image smoke |
| Medir tamanho/tempo/memória | CONCLUÍDO no GitHub; PENDENTE EXTERNO no piloto | tempos dos jobs hospedados registrados; workflow reserva 30 minutos ao Trivy e 180 minutos ao job; memória/recursos no runner corporativo ainda pendentes |
| Promover exatamente o artefato validado, sem rebuild divergente | CONCLUÍDO | `release-candidate` validou os digests; `publish` promoveu os mesmos manifests com `docker buildx imagetools create` |
| Retenção de tags intermediárias do GHCR | PENDENTE EXTERNO | definir limpeza/retenção para `validation-*` e `promotion-*` antes da operação contínua |
| Remediar `CRITICAL` corrigíveis das toolchains antes do release `0.3.0` | CONCLUÍDO | ferramentas Go reconstruídas com Go 1.25.7 e gRPC corrigido; pacotes npm herdados atualizados por checksum; SDK .NET oficial coerente; Gherkin Lint e TSQLLint removidos por falta de release segura; Trivy remoto aprovado |
| Assinatura/attestation adicional | PENDENTE | hardening posterior |

A base foi atualizada para MegaLinter v9.6.0/Alpine 3.24 com Semgrep 1.170.0, que incorpora a correção do crash OCaml/musl observado anteriormente em runners Intel. O SDK .NET 10.0.302, o runtime 10.0.10 e os targeting packs vêm da mesma imagem oficial Microsoft fixada por digest, evitando a combinação incoerente criada pelo upgrade de pacotes Alpine. Os digests das bases permanecem explícitos, e qualquer atualização futura precisa repetir build, quick smoke, full smokes e Trivy completo nos dois flavors.

## Fase 5 — CI e regressão

| Item planejado | Estado | Evidência/arquivo |
| --- | --- | --- |
| Workflows relevantes na raiz `.github/workflows` | CONCLUÍDO | `actionlint` e execuções remotas aprovados |
| Push/PR sem escrita no registry | CONCLUÍDO | matriz remota faz build e smokes read-only, sem promover imagem |
| Release por digest exato | CONCLUÍDO | `quality-v0.3.0` executou candidate, Trivy completo e publish sem rebuild |
| Clean clone em Ubuntu e Windows | CONCLUÍDO | jobs remotos Ubuntu/Windows aprovados |
| Suites root, Quality Node/Python e Semantic | CONCLUÍDO | `npm run verify` local e remoto aprovados |
| `npm pack --dry-run` | CONCLUÍDO localmente | root, Semantic e Quality no verify final |
| Build generic + dotnetweb | CONCLUÍDO | matriz completa aprovada para as duas flavors no release e na revalidação de `main` |
| Quick/full/image smoke | CONCLUÍDO | quick, tool-error, full-clean e full-finding aprovados nas duas flavors |
| Testar approved/rejected/needs-changes/operational | CONCLUÍDO localmente | suites e smoke |
| Gitleaks histórico/diretório com redaction | CONCLUÍDO | zero leaks localmente e no CI remoto, com Gitleaks 8.30.1 pinado |
| GitLab CI Lint | PENDENTE EXTERNO | resultado da instância da empresa |

## Fase 6 — Template GitLab e SonarQube

| Item planejado | Estado | Evidência/arquivo |
| --- | --- | --- |
| Imagem fixada obrigatoriamente por digest | CONCLUÍDO no template; PENDENTE EXTERNO no GitLab | preflight YAML e digests reais documentados |
| Runner tag e target branch configuráveis | CONCLUÍDO | variáveis do template |
| Sem DinD/privileged/socket | CONCLUÍDO no template; PENDENTE EXTERNO no runner | YAML + `config.toml` real |
| Artifacts normalizados apenas | CONCLUÍDO | JSON, Markdown e scope manifest |
| Quality e Sonar em paralelo | CONCLUÍDO como overlay; PENDENTE EXTERNO para job real | exige `.company_sonarqube_dotnet` hardened |
| Modo não bloqueante inicial | CONCLUÍDO | default `BLOCKING=false` |
| Usuário UID/GID 10001 e ownership do checkout | CONCLUÍDO localmente; PENDENTE EXTERNO no runner | image smoke + runner real |
| Proxy/CA/egress/cache controlados | PENDENTE EXTERNO | runner deve alcançar GHCR e inputs de scanners, incluindo Terrascan/Terraform Registry, e oferecer cache gravável pelo UID 10001 sem credenciais embutidas |
| Plano de substituição do Terrascan arquivado | PENDENTE | comparar candidato mantido em paralelo, registrar gaps e migrar somente com suíte de paridade e zero regressão de regras/evidência |
| Timeout central governado/calibrado | PENDENTE EXTERNO | template inicia em 2h; medir piloto |
| Enforcement obrigatório fora do YAML do MR | PENDENTE EXTERNO | Pipeline Execution Policy/compliance CI |
| Três MRs de piloto | PENDENTE EXTERNO | pipelines e relatório do rollout |
| Ativar bloqueio central | PENDENTE EXTERNO | somente após piloto |
| Rollback por digest anterior | PENDENTE EXTERNO | variável e digest registrados |

## Fase 7 — Documentação e internacionalização

| Item planejado | Estado | Evidência/arquivo |
| --- | --- | --- |
| Tutorial didático PT-BR | CONCLUÍDO | `docs/plano-gitlab-quality-gate.md` |
| Tutorial equivalente EN | CONCLUÍDO | `docs/gitlab-quality-gate.en.md` |
| Release/credenciais/rollback | CONCLUÍDO | `docs/proximos-passos-publicacao-segura.md` |
| Plano completo dentro da branch | CONCLUÍDO | este arquivo |
| Remover instrução npm inexistente dos exemplos GitLab | CONCLUÍDO | README + `examples/ci` e testes root |
| Contratos machine independentes de idioma | CONCLUÍDO | IDs/status/chaves/exit codes estáveis |
| Localização completa de findings externos | FORA DE ESCOPO AGORA | mensagens de scanners permanecem originais |

## Fase 8 — Publicação GitHub/GHCR

Os itens concluídos abaixo possuem evidência remota no GitHub/GHCR; os demais continuam dependendo da configuração administrativa ou do ambiente corporativo:

| Item planejado | Estado | Evidência obrigatória |
| --- | --- | --- |
| Integrar `final` em `main` | CONCLUÍDO | PR #3 e merge `2b20973` |
| Manter uma única branch canônica | CONCLUÍDO | `main`; flavors definidos por tags/digests |
| Configurar branch/tag rulesets | PENDENTE EXTERNO | Settings/API GitHub |
| Integrar correção da toolchain `generic` | CONCLUÍDO | PR #9, merge `7c49ee8` e checks aprovados |
| Criar tag `quality-v0.3.0` | CONCLUÍDO | tag no merge aprovado de `main` |
| Publicar flavors no GHCR | CONCLUÍDO | `0.3.0-generic`, `0.3.0-dotnetweb` e digests registrados |
| Gerar SBOM/proveniência | CONCLUÍDO | artifacts e atestação OCI do workflow de release |
| Decidir privado versus público | CONCLUÍDO | package público, com manifests acessíveis sem autenticação |
| Configurar pull privado, se necessário | NÃO SE APLICA | o package publicado é público |

## Critérios finais de conclusão

A iniciativa só está concluída quando:

1. `main`, a tag de release e os digests imutáveis estão visíveis no GitHub/GHCR;
2. todos os checks de clean clone/regressão/imagem estão verdes;
3. os packages `generic` e `dotnetweb` foram publicados e inspecionados;
4. o GitLab real passou no CI Lint e executou três MRs não bloqueantes;
5. policy/evidence/runner/egress estão governados fora do MR;
6. Quality Gate e SonarQube funcionam em paralelo;
7. o digest e seu rollback foram registrados;
8. o bloqueio foi ativado somente após aceite do piloto;
9. nenhuma credencial, token, URL interna ou PII corporativa entrou no repositório, imagem ou artifacts.

## Evidência atualizada em 21/07/2026

| Verificação | Resultado |
| --- | --- |
| Suítes locais na árvore final | root 38/38; Semantic build + 23/23; Quality Node 30/30; Quality Python executou 98 testes, com 4 skips esperados e os demais aprovados |
| Packs secos | root, Semantic e Quality aprovados; o cache npm foi direcionado a diretório temporário por restrição do perfil Windows |
| `python -m unittest discover -s quality-gate/tests -p "test_*.py"` | 98 testes executados, com 4 skips esperados e os demais aprovados, incluindo contrato estático do Dockerfile e do workflow |
| `test_quality_ci.py` dentro da suíte | 21/21: ref governada, spoof de env, policy externa, source limpa por `git archive`, symlink/gitlink, flags/waiver recusados, suporte .NET e sanitização |
| Build/smokes `generic` final | base MegaLinter v9.6.0/Alpine 3.24, Semgrep 1.170.0 e SDK oficial .NET 10.0.302/runtime 10.0.10; quick, tool-error, full-clean e full-finding aprovados remotamente |
| Build/smokes `dotnetweb` | quick, tool-error, full-clean e full-finding aprovados remotamente sobre o candidato exato |
| Trivy remoto | zero vulnerabilidades `CRITICAL` corrigíveis nas duas flavors no release `quality-v0.3.0` e na revalidação posterior de `main` |
| `actionlint` 1.7.12 + auditoria de pinos | workflows sem achados; actions, dois digests MegaLinter v9.6.0, digest do SDK Microsoft e checksums de downloads conferidos |
| `npm audit --omit=dev --workspaces=false` | zero vulnerabilidades em root, Semantic e Quality |
| Gitleaks 8.30.1 pinned, config/ignore governados e redaction | 13 commits + 62,02 MB do diretório; zero leaks |
| `python -m compileall`, `bash -n`, parse JSON/PyYAML e `git diff --check` | aprovados; apenas avisos de normalização EOL |

As verificações GitHub/GHCR foram concluídas e não substituem CI Lint ou piloto no GitLab. O workflow evita rebuild divergente: uma tag real de `main` já comprovou zero `CRITICAL` corrigível nos dois digests exatos antes de `publish`, preservou os artifacts Trivy e registrou os digests promovidos.

## Como atualizar este plano

Ao concluir um item, registre no mesmo PR:

- estado novo;
- comando/job usado;
- arquivo, URL pública ou digest que serve de evidência;
- limitação que continua válida.

Não substitua `PENDENTE EXTERNO` por `CONCLUÍDO` usando apenas source inspection ou um smoke quick.
