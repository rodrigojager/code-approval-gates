# Publicação segura do Quality Gate e entrega ao GitLab

Este checklist começa quando a branch `final` estiver revisada. Ele não contém credenciais, URLs internas ou valores do GitLab da empresa.

## Estado que deve existir antes do release

- `final` publicada no GitHub para revisão;
- PR de `final` para `main` com checks obrigatórios;
- unit tests, clean-clone verify, build das flavors `generic` e `dotnetweb`, full smoke e scan da imagem aprovados;
- Gitleaks aprovado no histórico e na árvore atual com redaction;
- branch `main` e tags `quality-v*` protegidas;
- nenhum package/tag criado a partir de commit fora de `main`.

Não crie uma tag apenas para testar se o workflow funciona. Pull Requests validam o build sem conceder `packages: write`; a publicação ocorre somente depois do merge.

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

```powershell
git switch main
git pull --ff-only origin main
git tag -s quality-v0.2.0 -m "Quality Gate 0.2.0"
git push origin quality-v0.2.0
```

Se assinatura ainda não estiver configurada, use temporariamente tag anotada com `git tag -a` e registre assinatura como hardening pendente.

O release inicial esperado para a aplicação .NET é:

```text
ghcr.io/rodrigojager/code-approval-quality-gate:0.2.0-dotnetweb
```

Também será produzida uma tag `sha-<commit>-dotnetweb`. Não use a tag ambígua `0.2.0` e não publique/use `latest`.

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
8. Calibre rede, recursos, policy, linters, suppressions, C#/MSBuild e falsos positivos.
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
- [ ] Flavor `dotnetweb` e arquitetura confirmadas.
- [ ] SBOM, proveniência e digest registrados.
- [ ] Pull privado usa conta técnica `read:packages`, se necessário.
- [ ] GitLab fixa a imagem por digest.
- [ ] Política e SHA ficam fora do MR.
- [ ] Target branch/ref remoto e timeout são governados centralmente.
- [ ] Runtime non-root UID `10001` validado no runner real.
- [ ] CI Lint e três MRs não bloqueantes concluídos.
- [ ] Linters/suppressions e C#/MSBuild inventariados antes de blocking.
- [ ] Pipeline Execution Policy/compliance CI impede remoção do gate pelo MR.
- [ ] Digest anterior registrado para rollback.
- [ ] Bloqueio habilitado somente após aceite.
