# Plano de integração e acompanhamento da branch `final`

Este documento transforma o inventário inicial em checklist auditável. Ele deve permanecer na branch para que código, testes, publicação e implantação possam ser comparados com o plano original sem depender de conversas externas.

Atualize a coluna **Estado** somente com evidência verificável. Não marque uma ação externa como concluída porque o código correspondente existe.

## Legenda

| Estado | Significado |
| --- | --- |
| CONCLUÍDO | implementado e coberto por evidência local/CI indicada |
| EM VALIDAÇÃO | implementação presente, mas validação ampla ou integração ainda pendente |
| PENDENTE EXTERNO | depende de GitHub/GHCR/GitLab/runner/empresa |
| PENDENTE | trabalho de código/documentação ainda não comprovado |
| FORA DE ESCOPO AGORA | preservado, sem evolução nesta fase |

## Baseline e composição

| Item | Estado | Evidência esperada |
| --- | --- | --- |
| Criar `final` a partir de `origin/main` | CONCLUÍDO | histórico Git da branch |
| Integrar a camada language-agnostic | CONCLUÍDO | merge no histórico e arquivos policy/evidence |
| Integrar a fundação GitLab/GHCR | CONCLUÍDO | merge no histórico e workflow/template |
| Resolver conflitos sem apagar funcionalidades | CONCLUÍDO localmente; EM VALIDAÇÃO no CI remoto | `npm run verify`, image smokes e diff final |
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
| Corrigir clean-clone verify/bootstrap | CONCLUÍDO localmente; EM VALIDAÇÃO no CI | clone local sem hardlinks + CI remoto |
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
| Dockerfile com versões/checksums pinados | CONCLUÍDO localmente; EM VALIDAÇÃO no CI | Dockerfile, builds das duas flavors e pinos MegaLinter v9.5.0/Alpine 3.23 auditados |
| Compatibilidade da base MegaLinter em runners Intel | CONCLUÍDO localmente; EM VALIDAÇÃO no CI | v9.5.0/Alpine 3.23 fixada por digest; v9.6/Alpine 3.24 bloqueada temporariamente |
| Corrigir conflitos pip e executar `pip check` | CONCLUÍDO localmente | build-smoke nos três venvs isolados |
| Flavor genérica preservada | CONCLUÍDO localmente | build/smokes `generic` |
| Flavor inicial `.NET web` explícita | CONCLUÍDO localmente | build/smokes `dotnetweb` |
| Tool version smoke | CONCLUÍDO localmente | build + quick smoke |
| Full scanner smoke saudável | CONCLUÍDO localmente; EM VALIDAÇÃO no CI | full-clean com 5 analisadores MegaLinter + 7 ferramentas no `dotnetweb` e 20 analisadores MegaLinter + 8 ferramentas no `generic` |
| Terrascan dedicado na flavor `generic` | CONCLUÍDO localmente; EM VALIDAÇÃO no CI | MegaLinter desabilita `TERRAFORM_TERRASCAN`; Terrascan v1.19.9 roda em project mode sobre projeção temporária dos arquivos Terraform, com anchors sintéticos somente-comentário nos ancestrais necessários; regras cross-file e layouts aninhados são preservados sem excluir diretórios `bin`/`obj` legítimos, e qualquer `scan_errors` bloqueia o gate |
| Sustentação do Terrascan | RISCO ACEITO; MIGRAÇÃO PENDENTE | o [repositório oficial foi arquivado em 20/11/2025](https://github.com/tenable/terrascan); manter v1.19.9 pinado para preservar cobertura agora e avaliar substituto mantido em shadow mode, sem remover a ferramenta até comprovar paridade de regras cross-file, evidência e política de bloqueio |
| Fixture com finding e erro operacional | CONCLUÍDO localmente | full-finding e tool-error |
| Execução non-root validada | CONCLUÍDO localmente | UID/GID 10001 no quick smoke |
| `PATH` e toolchains protegidos na execução non-root | CONCLUÍDO localmente | launcher recompõe `PATH` root-owned; smokes executam scanners como UID/GID 10001 |
| Scan Trivy da imagem | CONCLUÍDO localmente e no código; EM VALIDAÇÃO no GitHub | ambas as imagens: schema 2, resultado `os-pkgs` e zero `CRITICAL` corrigível de sistema; o scan completo de 2026-07-15 encontrou 18 ocorrências em toolchains/libs no `generic` e 13 no `dotnetweb`; tag exige zero em qualquer classe e envia o relatório como artifact |
| SBOM e proveniência de build | CONCLUÍDO no código; EM VALIDAÇÃO por tag real | `release-candidate` gera ambos; workflow de release ainda não foi exercitado por tag |
| Arquitetura `linux/amd64` | CONCLUÍDO como limite inicial | workflow/docs; outras arquiteturas não prometidas |
| Inputs runtime mutáveis registrados | CONCLUÍDO | `analysisInput` registra o bundle pinado do Terrascan e `runtimeInputs` registra `registry.terraform.io` como não pinado/network-required, além dos inputs de Semgrep, Trivy e OSV; rede/cache continuam parte do ambiente de execução |
| Transport proxy/CA root-owned sem credenciais | CONCLUÍDO localmente; PENDENTE EXTERNO no runner | `/etc/code-approval/quality-gate-transport.env`, UID 10001/image smoke |
| Medir tamanho/tempo/memória | CONCLUÍDO para tamanho/tempo local; PENDENTE EXTERNO no piloto | base v9.5.0: 3.529.992.992 bytes (3,288 GiB) dotnetweb; 6.529.328.993 bytes (6,081 GiB) generic; memória/recursos no runner ainda pendentes |
| Promover exatamente o artefato validado, sem rebuild divergente | CONCLUÍDO no código; EM VALIDAÇÃO por tag real | `release-candidate` captura e valida o digest construído; `publish` apenas promove esse digest com `docker buildx imagetools create` |
| Retenção de tags intermediárias do GHCR | PENDENTE EXTERNO | definir package privado e limpeza/retenção para `validation-*` e `promotion-*` antes da operação contínua |
| Remediar `CRITICAL` corrigíveis das toolchains antes do primeiro release | BLOQUEADOR DE RELEASE | atualizar/testar componentes herdados Node, Go, Ruby e .NET; o `release-candidate` permanece fail-closed e nenhuma tag real foi criada |
| Assinatura/attestation adicional | PENDENTE | hardening posterior |

A base permanece temporariamente fixada em MegaLinter v9.5.0/Alpine 3.23. Em runners Intel afetados, v9.6/Alpine 3.24 com musl 1.2.6 expôs um crash do runtime OCaml usado pelo Semgrep (`Failed to allocate signal stack for domain 0`). O problema está registrado em [ocaml/ocaml#14933](https://github.com/ocaml/ocaml/pull/14933) e a correção foi integrada no fork em [semgrep/ocaml#21](https://github.com/semgrep/ocaml/pull/21). Não atualizar a base até existir uma release do Semgrep que incorpore a correção e a matriz completa de build, quick smoke e full smokes das duas flavors passar novamente no CI.

## Fase 5 — CI e regressão

| Item planejado | Estado | Evidência/arquivo |
| --- | --- | --- |
| Workflows relevantes na raiz `.github/workflows` | CONCLUÍDO localmente; EM VALIDAÇÃO no GitHub | `actionlint` verde; reconhecimento remoto pendente |
| Push/PR sem escrita no registry | CONCLUÍDO no código; EM VALIDAÇÃO no GitHub | matriz faz build e smokes read-only, sem promover imagem |
| Release por digest exato | CONCLUÍDO no código; EM VALIDAÇÃO por tag real | tag executa `release-candidate`, scan Trivy completo e `publish` sem rebuild; nenhuma tag/release foi criada |
| Clean clone em Ubuntu e Windows | CONCLUÍDO em clone local Windows; EM VALIDAÇÃO no CI | clone novo ficou limpo; jobs Ubuntu/Windows pendentes |
| Suites root, Quality Node/Python e Semantic | CONCLUÍDO localmente; EM VALIDAÇÃO no CI | `npm run verify` final |
| `npm pack --dry-run` | CONCLUÍDO localmente | root, Semantic e Quality no verify final |
| Build generic + dotnetweb | CONCLUÍDO localmente; EM VALIDAÇÃO no CI | builds locais finais das duas flavors |
| Quick/full/image smoke | CONCLUÍDO localmente; EM VALIDAÇÃO no CI | quick/full-clean/full-finding + tool-error em ambas; generic confirmou 20 analisadores MegaLinter + 8 resultados de ferramentas com Terrascan dedicado |
| Testar approved/rejected/needs-changes/operational | CONCLUÍDO localmente | suites e smoke |
| Gitleaks histórico/diretório com redaction | CONCLUÍDO localmente; EM VALIDAÇÃO no CI | 13 commits + 62,02 MB, zero leaks, Gitleaks 8.30.1 pinned |
| GitLab CI Lint | PENDENTE EXTERNO | resultado da instância da empresa |

## Fase 6 — Template GitLab e SonarQube

| Item planejado | Estado | Evidência/arquivo |
| --- | --- | --- |
| Imagem fixada obrigatoriamente por digest | CONCLUÍDO no template; PENDENTE EXTERNO para digest real | preflight YAML |
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

Todos os itens abaixo são externos; nenhum deve ser marcado concluído por teste local:

| Item planejado | Estado | Evidência obrigatória |
| --- | --- | --- |
| Publicar `final` no GitHub | PENDENTE EXTERNO | branch/SHA remoto |
| Abrir PR `final -> main` | PENDENTE EXTERNO | URL do PR |
| Configurar branch/tag rulesets | PENDENTE EXTERNO | Settings/API GitHub |
| Aprovar e integrar PR | PENDENTE EXTERNO | merge commit/checks |
| Criar tag protegida `quality-v0.2.0` | PENDENTE EXTERNO | tag em commit de `main` |
| Publicar package GHCR privado | PENDENTE EXTERNO | package/version/workflow |
| Inspecionar layers/SBOM/proveniência | PENDENTE EXTERNO | digest e revisão registrada |
| Decidir privado versus público | PENDENTE EXTERNO | decisão explícita; público é irreversível |
| Configurar pull privado, se necessário | PENDENTE EXTERNO | conta técnica `read:packages` no runner |

## Critérios finais de conclusão

A iniciativa só está concluída quando:

1. a branch e o PR estão visíveis no GitHub;
2. todos os checks de clean clone/regressão/imagem estão verdes;
3. o package `dotnetweb` foi publicado e inspecionado;
4. o GitLab real passou no CI Lint e executou três MRs não bloqueantes;
5. policy/evidence/runner/egress estão governados fora do MR;
6. Quality Gate e SonarQube funcionam em paralelo;
7. o digest e seu rollback foram registrados;
8. o bloqueio foi ativado somente após aceite do piloto;
9. nenhuma credencial, token, URL interna ou PII corporativa entrou no repositório, imagem ou artifacts.

## Evidência local registrada em 15/07/2026

| Verificação | Resultado |
| --- | --- |
| `npm run verify` na árvore final | root 38/38; Semantic 23/23; Quality Node 30/30; Quality Python 98/98; três packs secos aprovados |
| clone novo `--no-hardlinks` da branch + `npm run verify` | mesmas quatro suítes/packs aprovados; `git status` permaneceu limpo; clone temporário removido com path validado |
| `python -W error::ResourceWarning -m unittest discover -s quality-gate/tests -p "test_*.py"` | 98/98 testes aprovados |
| `test_quality_ci.py` dentro da suíte | 21/21: ref governada, spoof de env, policy externa, source limpa por `git archive`, symlink/gitlink, flags/waiver recusados, suporte .NET e sanitização |
| Builds/smokes `dotnetweb` | base MegaLinter v9.5.0/Alpine 3.23; imagem final 3.529.992.992 bytes (3,288 GiB), ID `sha256:f11210e200c9...`; quick/tool-error/full-clean/full-finding aprovados; clean 5 analisadores MegaLinter + 7/7 ferramentas dedicadas, 0 findings |
| Builds/smokes `generic` | base MegaLinter v9.5.0/Alpine 3.23; imagem final 6.529.328.993 bytes (6,081 GiB), ID `sha256:3dc438171b80...`; quick/tool-error/full-clean/full-finding aprovados; clean 20 analisadores MegaLinter + 8/8 ferramentas dedicadas, incluindo Terrascan v1.19.9 em project mode, 0 findings; finding smoke comprovou `AC_AWS_0207` cross-file em Terraform aninhado |
| Trivy local nas imagens finais | schema 2 e resultado `os-pkgs` presentes; zero vulnerabilidades `CRITICAL` corrigíveis de sistema nas duas flavors; scan completo: 18 ocorrências no `generic` e 13 no `dotnetweb`, portanto uma tag seria corretamente bloqueada |
| `actionlint` 1.7.12 + auditoria de pinos | workflows sem achados; 7 actions, 2 digests MegaLinter v9.5.0 e checksum Gitleaks conferidos |
| `npm audit --omit=dev --workspaces=false` | zero vulnerabilidades em root, Semantic e Quality |
| Gitleaks 8.30.1 pinned, config/ignore governados e redaction | 13 commits + 62,02 MB do diretório; zero leaks |
| `python -m compileall`, `bash -n`, parse JSON/PyYAML e `git diff --check` | aprovados; apenas avisos de normalização EOL |

Essas verificações não substituem clean clone no GitHub Actions, CI Lint ou piloto no GitLab. O workflow já evita rebuild divergente no job de publicação, mas uma tag real não deve ser criada enquanto o scan completo continuar encontrando `CRITICAL` corrigíveis nas toolchains; depois da remediação, ainda será necessário comprovar `release-candidate`/`publish`, o artifact Trivy e o digest promovido remotamente.

## Como atualizar este plano

Ao concluir um item, registre no mesmo PR:

- estado novo;
- comando/job usado;
- arquivo, URL pública ou digest que serve de evidência;
- limitação que continua válida.

Não substitua `PENDENTE EXTERNO` por `CONCLUÍDO` usando apenas source inspection ou um smoke quick.
