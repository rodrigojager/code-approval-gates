# Publicação segura do Quality Gate e entrega ao GitLab

Este checklist começa quando a branch `final` estiver revisada. Ele não contém credenciais, URLs internas ou valores do GitLab da empresa.

## Estado que deve existir antes do release

- `final` publicada no GitHub para revisão;
- PR de `final` para `main` com checks obrigatórios;
- unit tests, clean-clone verify, build das flavors `generic` e `dotnetweb`, full smoke e scan da imagem aprovados;
- bases MegaLinter v9.6.0/Alpine 3.24 fixadas por digest, Semgrep 1.170.0 e matriz completa validados;
- `PATH` root-owned/toolchains e execução non-root validados nas duas flavors;
- flavor `generic` validada com sua matriz ampla de analisadores: `TERRAFORM_TERRASCAN` desabilitado no MegaLinter e Terrascan v1.19.9 dedicado, em project mode, sobre projeção temporária Terraform com anchors somente-comentário nos ancestrais necessários e falha fechada para `scan_errors`;
- risco de manutenção registrado: o [repositório oficial do Terrascan foi arquivado em 20/11/2025](https://github.com/tenable/terrascan); manter v1.19.9 nesta entrega evita regressão, mas um substituto mantido deve ser avaliado em shadow mode antes de qualquer troca;
- workflow implementado para promover exatamente o manifesto/digest validado, sem rebuild no job de publicação, ainda não exercitado por tag real;
- Gitleaks aprovado no histórico e na árvore atual com redaction;
- branch `main` e tags `quality-v*` protegidas;
- nenhum package/tag criado a partir de commit fora de `main`.

Não crie uma tag apenas para testar se o workflow funciona. Pushes e Pull Requests fazem build e smokes read-only, sem conceder `packages: write`; candidate e publicação existem somente no fluxo futuro de tag, depois do merge e das proteções exigidas.

## Credenciais

| Credencial | Uso | Local correto | Nunca colocar em |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` automático | publicar no GHCR | job de release do GitHub Actions | secret criado manualmente, Dockerfile ou log |
| PAT classic `read:packages` | pull de package privado | conta técnica + runner dedicado | repositório ou script do MR |
| `SONAR_TOKEN` | SonarQube existente | variável GitLab masked/protected | YAML público ou artifact |
| política corporativa | enforcement | arquivo governado externo | branch do MR |
| SHA-256 da política | integridade | variável de grupo/projeto | default mutável no YAML |

O workflow deve usar `${{ secrets.GITHUB_TOKEN }}` apenas no job de tag com `packages: write`. O job de PR permanece `contents: read`, não faz login no GHCR e nunca usa `pull_request_target` para construir o código do PR.

## Revisão local antes do push

```powershell
git rev-parse --show-toplevel
git branch --show-current
git remote get-url origin
git status --short
git diff --check
git diff
git ls-files --others --exclude-standard
```

O remote esperado é `https://github.com/rodrigojager/code-approval-gates.git`, sem credencial embutida. Não envie `.env`, `.quality/`, logs, dumps, `.docker/config.json`, chaves, certificados privados, tokens, artifacts ou dados internos.

Antes do commit/release:

```powershell
gitleaks git . --log-opts="--all" --redact=100
gitleaks dir . --redact=100
```

Se houver segredo real, revogue-o primeiro. Remover somente o arquivo não invalida uma credencial já exposta.

## Proteções no GitHub

Crie rulesets para `main` e `quality-v*`:

- merge somente por PR aprovado;
- checks obrigatórios;
- aprovação invalidada após novo commit;
- force push e exclusão bloqueados;
- mudanças em `.github/workflows/**` revisadas por responsável autorizado;
- somente mantenedores autorizados criam tags de release;
- tag de release aponta para commit já integrado em `main`.

Mantenha Secret scanning e Push protection habilitados.

## Primeira publicação

Depois do merge e de atualizar `main` por fast-forward:

> **Estado atual:** a tag histórica `quality-v0.2.0`, criada em 2026-07-20, foi bloqueada corretamente pela `generic` vulnerável; `0.2.1` publicou apenas `dotnetweb`. Não mova nem reutilize essas tags. A correção que torna os dois flavors publicáveis segue como `0.3.0`.

> **Escopo corrigido em `0.3.0`:** `generic` e `dotnetweb` são promovidas e ambas precisam ter zero `CRITICAL` corrigível em sistema operacional, toolchains e bibliotecas. A base foi atualizada para MegaLinter v9.6.0/Alpine 3.24 e Semgrep 1.170.0. O SDK .NET oficial 10.0.302, com runtime 10.0.10, vem de uma imagem Microsoft fixada por digest. Toolchains Go vulneráveis foram reconstruídas a partir de commits fixados com dependências atualizadas; dependências npm aninhadas foram substituídas por artefatos com checksum. Gherkin Lint e TSQLLint foram removidos por não terem release upstream corrigida; SQLFluff continua disponível.

Quando todos os pré-requisitos externos estiverem atendidos, a tag acionará este fluxo:

1. `release-candidate` constrói a imagem e envia uma referência privada `validation-*`;
2. o digest retornado pelo build é baixado e recebe novamente todos os smokes e o scan Trivy completo;
3. o relatório Trivy é preservado como artifact e qualquer `CRITICAL` corrigível interrompe o release;
4. `publish` usa `docker buildx imagetools create` para promover exatamente esse digest às tags finais, sem novo build.

```powershell
git switch main
git pull --ff-only origin main
git tag -s quality-v0.3.0 -m "Quality Gate 0.3.0"
git push origin quality-v0.3.0
```

Se assinatura ainda não estiver configurada, use temporariamente tag anotada com `git tag -a` e registre assinatura como hardening pendente.

O release esperado produz duas referências versionadas:

```text
ghcr.io/rodrigojager/code-approval-quality-gate:0.3.0-generic
ghcr.io/rodrigojager/code-approval-quality-gate:0.3.0-dotnetweb
```

Também serão produzidas tags `sha-<commit>-generic` e `sha-<commit>-dotnetweb`. Não use tags mutáveis em execução: após a inspeção, fixe o digest do flavor escolhido.

As referências intermediárias `validation-*` e `promotion-*` não são tags finais de consumo, mas permanecem no registry para permitir validação e promoção. Defina uma política de retenção/limpeza para o package privado antes da operação contínua e nunca remova uma referência usada por um workflow em andamento.

## Inspeção do package

Mantenha a primeira publicação privada e confira:

- commit, versão e flavor;
- digest `sha256:`;
- arquitetura `linux/amd64`;
- layers e arquivos da imagem;
- usuário padrão não-root;
- SBOM e proveniência;
- ausência de paths, URLs ou dados internos;
- ausência de Semantic Gate;
- versões dos scanners e `pip check`.

Uma imagem privada não é lugar seguro para secrets. Qualquer usuário com pull pode inspecionar todas as layers. Tornar o package público é irreversível; faça isso somente após revisão explícita.

Terrascan v1.19.9 está pinado, mas os metadados de `registry.terraform.io` continuam um input mutável/network-required, assim como regras e bancos dos demais scanners. O relatório distingue o bundle pinado desse input de runtime não pinado. Antes do GitLab, teste allowlist de egress e cache persistente gravável pelo UID `10001`; não armazene token de registry no cache, na imagem, no checkout ou em artifacts.

## Pull privado no runner

Use conta técnica GitHub com acesso `Read` somente ao package e PAT classic limitado a `read:packages`. No host do runner, autentique o usuário real do serviço com `--password-stdin`; não passe o token na linha de comando.

```bash
read -rsp "GHCR read token: " GHCR_READ_TOKEN
printf '%s' "$GHCR_READ_TOKEN" | sudo -H -u gitlab-runner \
  docker login ghcr.io --username quality-gate-reader --password-stdin
unset GHCR_READ_TOKEN
sudo chmod 600 /home/gitlab-runner/.docker/config.json
```

Prefira credential helper quando a infraestrutura oferecer um. O runner precisa ser dedicado, bloqueado para projetos autorizados, sem privileged/socket e com `allowed_images` restritivo.

## Fixação por digest

Depois da inspeção, configure fora do repositório consumidor:

```text
CODE_APPROVAL_QUALITY_IMAGE=ghcr.io/rodrigojager/code-approval-quality-gate@sha256:DIGEST_VERIFICADO
```

Registre também o digest anterior aprovado. O rollback altera essa variável para o digest anterior; tags não são movidas ou apagadas.

## Validação no GitLab

1. Cadastre imagem, policy externa ao checkout, digest, target branch e tag do runner em configuração administrada centralmente.
2. Garanta que `refs/remotes/origin/<target-branch>` exista no checkout com histórico completo.
3. Integre `examples/ci/gitlab-quality-gate.yml` em modo advisory.
4. Adapte `examples/ci/gitlab-quality-and-sonarqube.yml` para estender o job Sonar hardened existente; não copie token/build para o exemplo público.
5. Rode CI Lint na instância real e valide UID `10001`, timeout e ownership.
6. Execute três MRs com `CODE_APPROVAL_QUALITY_BLOCKING=false`.
7. Inspecione logs e apenas os artifacts JSON/Markdown/manifesto.
8. Calibre rede, cache, recursos, policy, linters, suppressions, C#/MSBuild e falsos positivos; confirme egress para Terrascan/Terraform Registry sem expor credenciais ao MR.
9. Antes de bloquear, torne o job obrigatório por Pipeline Execution Policy/compliance CI e confirme `Pipelines must succeed`.

Detalhes de runner, política, evidências, proxy/CA e rollback estão em `docs/plano-gitlab-quality-gate.md`. A versão inglesa está em `docs/gitlab-quality-gate.en.md`.

## Resposta a incidente

Se token aparecer em commit, PR, issue, artifact, screenshot ou log:

1. revogue imediatamente;
2. gere substituto com permissão mínima;
3. revise acesso e downloads;
4. limpe o histórico com procedimento aprovado;
5. invalide caches/artifacts alcançáveis;
6. repita Gitleaks no histórico e diretório atual.

## Checklist

- [ ] `final` revisada por PR, sem push direto em `main`.
- [ ] Actions e permissões revisadas.
- [ ] Gitleaks histórico/diretório aprovado.
- [ ] Rulesets de branch e tags ativos.
- [ ] Tag criada a partir do `main` aprovado.
- [ ] Package privado inspecionado.
- [ ] Flavors `generic` e `dotnetweb` e arquitetura confirmadas.
- [ ] Bases MegaLinter v9.6.0/Alpine 3.24 e seus digests conferidos.
- [ ] Semgrep 1.170.0 e nova matriz completa confirmados.
- [x] Workflow implementa promoção do digest exato validado, sem rebuild divergente.
- [ ] Uma tag real comprovou candidate, report Trivy e promoção do mesmo digest.
- [ ] Scan Trivy completo chegou a zero `CRITICAL` corrigível em toolchains e bibliotecas.
- [ ] Retenção/limpeza das referências privadas `validation-*` e `promotion-*` foi definida.
- [ ] SBOM, proveniência e digest registrados.
- [ ] Pull privado usa conta técnica `read:packages`, se necessário.
- [ ] GitLab fixa a imagem por digest.
- [ ] Política e SHA ficam fora do MR.
- [ ] Target branch/ref remoto e timeout são governados centralmente.
- [ ] Runtime non-root UID `10001` validado no runner real.
- [ ] `generic` confirmou sua matriz ampla atual, com Terrascan v1.19.9 dedicado em project mode sobre projeção somente Terraform.
- [ ] Egress/cache de Terrascan e Terraform Registry testados sem credenciais no checkout, imagem ou artifacts.
- [ ] Substituto mantido para o Terrascan arquivado avaliado em shadow mode; remoção condicionada à paridade cross-file/evidência/fail-closed.
- [ ] CI Lint e três MRs não bloqueantes concluídos.
- [ ] Linters/suppressions e C#/MSBuild inventariados antes de blocking.
- [ ] Pipeline Execution Policy/compliance CI impede remoção do gate pelo MR.
- [ ] Digest anterior registrado para rollback.
- [ ] Bloqueio habilitado somente após aceite.
