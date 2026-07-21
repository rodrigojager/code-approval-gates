# Tutorial: piloto do Quality Gate no GitLab com SonarQube

Este é o guia canônico em português para o primeiro piloto corporativo. O cenário de referência é uma aplicação web .NET, Merge Requests para `develop`, GitLab Docker executor e um job SonarQube corporativo que já existe.

> Estado atual: a implementação candidata `0.3.0` está pronta para revisão, mas os novos digests ainda dependem do merge aprovado em `main` e da tag protegida. O piloto deve permanecer **advisory/não bloqueante** até concluir as validações no GitHub, a inspeção dos pacotes e a governança descrita aqui.

## O desenho do piloto

```text
GitHub Actions -> GHCR (imagem por digest) -> GitLab Runner dedicado
                                                |
job .NET de testes -----------------------------+-> job Sonar corporativo
                                                |
checkout Git imutável --------------------------+-> Quality Gate advisory
```

- O Runner usa Docker apenas para iniciar o container do job.
- Não há Docker-in-Docker, `privileged`, socket Docker ou Compose.
- O container executa como UID/GID `10001`, não como root.
- O launcher recompõe um `PATH` fixo com diretórios root-owned das toolchains; não herda `PATH` nem command overrides do job/MR, e os scanners continuam non-root.
- Na flavor `generic`, `TERRAFORM_TERRASCAN` fica desabilitado dentro do MegaLinter. O runtime executa Terrascan v1.19.9 separadamente, em project mode, sobre uma projeção temporária dos arquivos Terraform selecionados. Anchors sintéticos somente-comentário tornam válidos os diretórios ancestrais sem configuração própria; `scan_errors` não vazio falha fechado. Assim, regras cross-file e layouts aninhados são preservados sem ignorar diretórios legítimos chamados `bin` ou `obj`.

> **Risco de sustentação:** o [repositório oficial do Terrascan foi arquivado em 20/11/2025](https://github.com/tenable/terrascan). A v1.19.9 permanece pinada nesta primeira entrega para não perder cobertura. Avalie um substituto mantido em shadow mode e só remova o Terrascan depois de comprovar paridade de regras cross-file, formato de evidência e comportamento fail-closed.
- O Semantic Gate fica fora dessa imagem e desse piloto.
- O `quality-ci` não chama deliberadamente testes/build/scripts do projeto. Porém analisadores podem invocar toolchains e avaliar configs/MSBuild controlados pelo MR; por isso o piloto continua non-root e advisory.
- No contrato inicial ele também não consome JUnit, cobertura ou evidence por paths fornecidos pelo job. Esses sinais continuam no GitLab/Sonar até existir uma fonte root-owned ou policy-governed para os mappings.
- O comando normativo é somente `/usr/local/bin/quality-ci check`; flags adicionais são rejeitadas.

## 1. Limite de segurança real

O template comum dentro do próprio repositório pode ser alterado por um Merge Request. Variáveis de job também podem sobrescrever variáveis predefinidas do GitLab. Portanto:

- modo bloqueante exige uma **Pipeline Execution Policy**, compliance pipeline ou outro include obrigatório que o autor do MR não consiga remover;
- imagem, policy, digest, runner tag, target branch, timeout e modo bloqueante precisam ser administrados no grupo/projeto/policy central;
- variáveis `Protected` normalmente não chegam a pipelines de MR de branches não protegidas; teste o comportamento real da empresa em vez de copiar valores para o YAML;
- template protegido e variáveis de grupo/projeto ajudam no piloto, mas sozinhos não tornam um job comum obrigatório.

O runtime adiciona defesa em profundidade, mas não substitui enforcement central. O MegaLinter também exige cautela: `MEGALINTER_CONFIG` não neutraliza automaticamente configs, suppressions inline e mecanismos de ignore de cada analisador. Analisadores C# podem avaliar MSBuild do MR. Antes de bloquear merges, inventarie cada linter ativo, fixe sua configuração e detecte suppressions perigosas.

## 2. Runner

Confirme no ambiente real:

- runner `linux/amd64` dedicado e restrito ao projeto/grupo autorizado;
- `privileged = false`;
- nenhum `/var/run/docker.sock` montado;
- escrita do UID `10001` no checkout e em `.quality/reports`;
- egress controlado para GHCR e para os bancos/regras usados pelos scanners, incluindo Terrascan e Terraform Registry;
- cache de scanner/registry gravável pelo UID `10001`, sem compartilhar credenciais com o checkout ou com código do MR;
- memória e CPU suficientes;
- timeout central do job (o exemplo usa `2h`, a ser calibrado no piloto).

Exemplo de fronteira do executor:

```toml
[runners.docker]
  privileged = false
  pull_policy = "always"
  allowed_images = [
    "ghcr.io/rodrigojager/code-approval-quality-gate@sha256:*",
    "mcr.microsoft.com/dotnet/sdk:*"
  ]
  volumes = ["/cache"]
```

Não use `image:docker:user: 0`, DinD ou socket Docker para corrigir ownership. Ajuste permissões do checkout/cache para o UID `10001`.

## 3. Publicar e fixar a imagem

O workflow de release é acionado por tag `quality-v*` e publica os dois flavors:

```text
ghcr.io/rodrigojager/code-approval-quality-gate:0.3.0-generic
ghcr.io/rodrigojager/code-approval-quality-gate:0.3.0-dotnetweb
```

A `generic` é a imagem portátil, com cobertura ampla para repositórios de tecnologias mistas. A `dotnetweb` usa uma base e uma allowlist menores para repositórios .NET/web. Essa separação existe para tornar tamanho, superfície de ferramentas e cobertura previsíveis; não cria níveis diferentes de segurança. As duas imagens precisam passar pelo mesmo scan completo antes da promoção.

A base `0.3.0` está fixada por digest em MegaLinter v9.6.0/Alpine 3.24 e usa Semgrep 1.170.0, que incorpora a correção necessária para o runtime OCaml/musl. O SDK .NET oficial 10.0.302, com runtime 10.0.10, também é copiado de uma imagem Microsoft fixada por digest para manter SDK, runtime e targeting packs coerentes. Ferramentas Go herdadas foram reconstruídas de commits fixados com dependências corrigidas; cópias npm vulneráveis foram substituídas por artefatos com checksum. Gherkin Lint e TSQLLint foram removidos porque não existe release upstream corrigida; SQLFluff preserva a análise SQL.

O workflow implementa promoção sem reconstrução divergente. A tag histórica `quality-v0.2.0` comprovou que o gate bloqueava a `generic` vulnerável, e `0.2.1` publicou apenas `dotnetweb`. A correção `0.3.0` elimina essa exceção e promove ambos os flavors:

1. em push e Pull Request, a matriz `validate` faz build e smokes em modo read-only, sem login ou escrita no GHCR;
2. em uma tag `quality-v*`, a matriz exige zero `CRITICAL` corrigível em todas as classes nas duas flavors;
3. `release-candidate` constrói e envia uma referência intermediária `validation-*` para cada flavor, captura os digests produzidos, baixa exatamente esses digests e repete os smokes;
4. o mesmo candidate executa o scan Trivy completo, bloqueia qualquer vulnerabilidade `CRITICAL` corrigível e envia o relatório como artifact para auditoria;
5. somente após essa validação, `publish` promove o mesmo digest para as tags finais com `docker buildx imagetools create`; esse job não reconstrói a imagem.

As tags intermediárias `validation-*` e `promotion-*` são um risco operacional residual. Mantenha o package privado e defina política de retenção/limpeza antes de operar releases continuamente; não apague uma referência necessária durante uma execução em andamento.

Um scan local completo da camada com as toolchains remediadas chegou a zero `CRITICAL` corrigível. Depois da incorporação do SDK .NET oficial, a imagem `generic` final passou no build, no quick smoke e em um restore .NET isolado como usuário non-root. O scan completo dos dois digests exatos continua obrigatório no GitHub Actions; nenhum resultado intermediário autoriza promoção.

Após o build, copie o digest real e configure no GitLab:

```text
CODE_APPROVAL_QUALITY_IMAGE=ghcr.io/rodrigojager/code-approval-quality-gate@sha256:DIGEST_REAL
```

Não execute produção com `latest`, `0.3.0-generic` ou `0.3.0-dotnetweb`. A tag localiza o release e identifica o flavor; o digest imutável executa o job.

Mantenha o primeiro package privado enquanto revisa layers, labels, SBOM e proveniência. Se o GHCR continuar privado, use uma conta técnica com somente `read:packages`; armazene o PAT no cofre/runner, nunca no repositório, YAML, imagem, artifact ou log. Tornar o package público é uma decisão irreversível no GHCR.

## 4. Policy corporativa

O runtime exige policy explícita com `schemaVersion: 1` e SHA-256 correspondente. O arquivo não pode ser substituído silenciosamente pelo checkout.

```text
CODE_APPROVAL_QUALITY_POLICY_FILE=/etc/code-approval-gates/company-policy.json
CODE_APPROVAL_QUALITY_POLICY_SHA256=<64 caracteres hexadecimais minúsculos>
```

Distribuição recomendada:

1. arquivo read-only montado pelo runner dedicado;
2. variável GitLab do tipo File administrada no grupo/projeto, desde que seu arquivo temporário fique fora do checkout.

A policy deve ser um arquivo regular fora da árvore analisada e nenhum componente do path pode ser symlink. Não baixe a policy como artifact dentro de `$CI_PROJECT_DIR`.

O perfil corporativo inicial é fixo em `standard`, threshold `90`, secrets habilitado e modo `full --fail-on-tool-error` no sidecar. A policy não pode desabilitar budgets nem configurá-los acima dos limites `standard`. Waivers fornecidos pelo job/MR são recusados; exceções iniciais devem entrar na policy governada após revisão.

Exemplo mínimo, sem `testQuality` ou evidence ainda:

```json
{
  "schemaVersion": 1,
  "budgets": {
    "maxFileBytes": 2097152,
    "maxFileLines": 5000,
    "maxChangedFiles": 100,
    "maxChangedLines": 20000,
    "maxDiffBytes": 10485760,
    "maxBinaryFiles": 20
  }
}
```

Calcule o digest sem imprimir o conteúdo:

```powershell
(Get-FileHash .\company-policy.json -Algorithm SHA256).Hash.ToLowerInvariant()
```

## 5. Como o runtime escolhe o código

O launcher corporativo não confia em `CI_PROJECT_DIR`, `CI_COMMIT_SHA` ou `CI_MERGE_REQUEST_DIFF_BASE_SHA` como fonte de verdade:

1. deriva a raiz com `git rev-parse --show-toplevel` a partir do diretório atual;
2. deriva o head do `HEAD` realmente checado e recusa mismatch com variáveis GitLab presentes;
3. exige `CODE_APPROVAL_QUALITY_TARGET_BRANCH` governada centralmente;
4. resolve a base somente de `refs/remotes/origin/<target-branch>`;
5. compara a target branch declarada pelo GitLab e falha em mismatch;
6. exige merge-base válido e falha com código `3` se o ref remoto não estiver disponível;
7. calcula diff, tamanho, linhas, binários e histórico no range governado;
8. valida que arquivos rastreados e index correspondem ao commit;
9. rejeita symlinks rastreados/não rastreados, gitlinks/submodules e componentes symlink em `.quality`/output;
10. materializa arquivos regulares diretamente da árvore do commit com `git archive`, nunca copiando conteúdo mutável do worktree;
11. exclui arquivos não rastreados da projeção e registra sua contagem no scope manifest;
12. projeta os arquivos alterados e manifests de suporte sem `.git`, depois chama o sidecar.

O contrato GitLab inicial é `changed` fixo. `resolve_scope` continua suportando `full`/`paths` internamente para o fluxo local, mas o launcher corporativo não aceita `--scope`, `--path`, output customizado, flags de enablement ou report paths. Se `origin/<target>` ainda não puder ser governado/fetchado, não enfraqueça o changed scope: use um full scan por configuração central imutável em uma fase posterior ou mantenha o piloto fora do blocking.

O scope manifest registra `sourceCommit`, base/head/merge-base, `targetBranch`, `sourceMaterialization: git-archive`, arquivos selecionados/suporte, diff/histórico, policy e `excludedUntrackedCount`.

## 6. Template GitLab e SonarQube

Copie/inclua `examples/ci/gitlab-quality-gate.yml` pela configuração central e cadastre fora do YAML do MR:

| Variável | Exemplo | Autoridade |
| --- | --- | --- |
| `CODE_APPROVAL_QUALITY_IMAGE` | `ghcr.io/...@sha256:...` | grupo/projeto/policy |
| `CODE_APPROVAL_QUALITY_POLICY_FILE` | arquivo governado | runner/File variable |
| `CODE_APPROVAL_QUALITY_POLICY_SHA256` | digest da policy | grupo/projeto/policy |
| `CODE_APPROVAL_QUALITY_RUNNER_TAG` | runner dedicado | grupo/projeto/policy |
| `CODE_APPROVAL_QUALITY_TARGET_BRANCH` | `develop` | grupo/projeto/policy |
| `CODE_APPROVAL_QUALITY_BLOCKING` | `false` no piloto | policy central |

O job usa `GIT_DEPTH: "0"`, `before_script: []`, timeout `2h`, imagem por digest, entrypoint vazio e o usuário non-root da imagem. Ele publica somente:

- `.quality/reports/quality-report.json`;
- `.quality/reports/quality-report.md`;
- `.quality/reports/quality-scope.json`.

`examples/ci/gitlab-quality-and-sonarqube.yml` é um overlay: o job de testes produz JUnit/cobertura; o Quality aguarda os testes sem baixar artifacts; o placeholder Sonar deve estender o job corporativo `.company_sonarqube_dotnet`. Não exponha `SONAR_TOKEN` a um job genérico de build que executa código do MR. A instalação do scanner, token, regras para MRs/branches e paths de cobertura pertencem ao job Sonar hardened existente.

Valide o YAML no CI Lint da instância real. O arquivo combinado não é standalone enquanto `.company_sonarqube_dotnet` não vier de um include central.

## 7. Proxy e CA via transporte root-owned

Variáveis proxy/CA vindas do job/MR são ignoradas pelo launcher. Quando necessárias, monte opcionalmente:

```text
/etc/code-approval/quality-gate-transport.env
```

O arquivo deve ser `root:root` e modo exato `0444` para ser legível pelo UID `10001`. Aceita comentários `#` e `NAME=value` para:

- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` e variantes lowercase;
- `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`.

Não coloque segredo nesse arquivo. URLs de proxy com userinfo ou `@` são recusadas, pois analisadores que processam o MR poderiam ler/exfiltrar credenciais. Certificados devem ser públicos, root-owned e ficar sob `/etc/code-approval/ca`, `/etc/ssl` ou `/usr/local/share/ca-certificates`; nunca monte chave privada.

Os executáveis são pinados — inclusive Terrascan v1.19.9 —, mas alguns inputs continuam mutáveis e dependentes de rede: ruleset `semgrep --config=p/default`, banco do Trivy, dados OSV e metadados do Terraform Registry. O relatório registra separadamente o bundle pinado do Terrascan e `registry.terraform.io` como não pinado/network-required. Autorize somente os destinos necessários e planeje cache persistente, gravável pelo UID `10001`, para reduzir variação e indisponibilidade; não coloque tokens de registry nesse cache. Não descreva o scan como totalmente reproduzível ou offline.

## 8. Resultado, piloto e rollback

| Exit | Status machine | Significado |
| ---: | --- | --- |
| 0 | `APPROVED` | policy atendida |
| 1 | `REJECTED` | finding/policy reprovou |
| 2 | `NEEDS_CHANGES` | ferramenta obrigatória ausente/inconclusiva |
| 3 | erro operacional | Git, config, policy ou runtime inválido |

IDs, chaves JSON, statuses e exits não são traduzidos. `CODE_APPROVAL_QUALITY_LOCALE=pt-BR` ou `en` altera apenas textos humanos suportados; mensagens de scanners permanecem no idioma original.

Comece com `CODE_APPROVAL_QUALITY_BLOCKING=false` e rode pelo menos três MRs: pequeno/saudável, legado/contexto grande e mudança relevante em código/testes/infra. Registre digest, duração, CPU/memória, rede, findings, falsos positivos, suppressions/configs detectadas, comportamento do Sonar e os três artifacts normalizados.

Só considere blocking depois de:

- full smoke real das duas imagens;
- inventário/hardening dos linters e da execução C#/MSBuild;
- CI Lint e enforcement central;
- três MRs advisory aceitos;
- timeout/recursos calibrados;
- digest anterior registrado.

Rollback: altere centralmente `CODE_APPROVAL_QUALITY_IMAGE` para o digest anterior, rode CI Lint e valide com um MR. Nunca mova tag. Se necessário, volte temporariamente a `BLOCKING=false` mantendo o job e os relatórios.

## Checklist

- [ ] Runner `linux/amd64`, UID `10001`, sem root/privileged/socket.
- [ ] Imagens `generic` e `dotnetweb` publicadas, inspecionadas e fixadas por seus respectivos digests.
- [ ] Bases MegaLinter v9.6.0/Alpine 3.24 confirmadas por digest e matriz completa aprovada.
- [x] O workflow promove o digest exato validado, sem rebuild no job de publicação.
- [ ] O scan completo chegou a zero `CRITICAL` corrigível em sistema, toolchains e bibliotecas nos dois candidatos exatos.
- [ ] Uma tag real demonstrou candidate, scan Trivy, artifact e promoção do mesmo digest.
- [ ] Retenção/limpeza das tags privadas `validation-*` e `promotion-*` foi definida.
- [ ] Policy externa com `schemaVersion: 1` e SHA governado.
- [ ] Target branch governada e `refs/remotes/origin/<target>` disponível.
- [ ] Pipeline Execution Policy/compliance definida antes de blocking.
- [ ] Transporte proxy/CA, se usado, root-owned `0444` e sem segredo.
- [ ] CI Lint aprovado com o include Sonar corporativo real.
- [ ] Full image smoke e scanners obrigatórios validados.
- [ ] Flavor `generic` confirmou sua matriz atual de analisadores e ferramentas; Terrascan v1.19.9 dedicado roda em project mode sobre projeção apenas Terraform.
- [ ] Egress e cache para Terrascan/Terraform Registry foram testados sem expor credenciais ao MR.
- [ ] Um substituto mantido para o Terrascan arquivado está sendo avaliado em shadow mode, sem troca antes da paridade comprovada.
- [ ] Linters/configs/suppressions/MSBuild inventariados.
- [ ] Três MRs advisory concluídos e recursos calibrados.
- [ ] Digest anterior registrado para rollback.
- [ ] JUnit/cobertura permanecem em GitLab/Sonar até mappings governados.
- [ ] Blocking ativado somente após aceite explícito do piloto.
