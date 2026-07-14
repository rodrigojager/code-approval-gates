# Próximos passos para publicação segura do Quality Gate

Este documento descreve como enviar as alterações deste repositório ao GitHub, publicar a imagem do Quality Gate no GitHub Container Registry (GHCR) e permitir que o GitLab Runner execute essa imagem sem expor credenciais.

O objetivo de segurança é simples: nenhuma senha, chave, token pessoal, arquivo `.env`, configuração do Docker ou credencial do GitHub pode entrar no histórico Git, na imagem, no YAML público da pipeline ou nos logs dos jobs.

## Decisão inicial

1. Enviar o código por Pull Request, sem publicar a imagem durante o PR.
2. Publicar a imagem apenas por uma tag `quality-v*`, depois do merge.
3. Usar somente o `GITHUB_TOKEN` automático do GitHub Actions para publicar no GHCR.
4. Manter o primeiro package do GHCR privado enquanto seu conteúdo e seus metadados são verificados.
5. Se a imagem continuar privada, usar uma conta técnica separada, com acesso de leitura somente a esse package, para o GitLab Runner baixá-la.
6. Armazenar essa credencial no host do runner dedicado, e não no repositório nem no job de Merge Request.

O GHCR já é o registry necessário. Não é preciso criar outro repositório GitHub só para hospedar a imagem.

## Credenciais necessárias

| Credencial | É necessária? | Onde fica | Pode aparecer no repositório? |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | Sim, para a publicação | É criado automaticamente pelo GitHub para cada job e expira depois dele | O nome `${{ secrets.GITHUB_TOKEN }}` pode aparecer no workflow; o valor nunca |
| PAT pessoal do proprietário | Não | Não deve ser criado para este fluxo | Não |
| Token `GHCR_READ_TOKEN` | Somente se o package continuar privado | Cofre de senhas e configuração local do GitLab Runner | Não |
| Senha da conta GitHub | Não | Nunca é usada na pipeline | Não |
| Token do SonarQube | Continua sendo administrado no GitLab atual | Variável protegida já existente, fora deste repositório | Não |

O workflow de publicação deve autenticar no GHCR assim:

```yaml
username: ${{ github.actor }}
password: ${{ secrets.GITHUB_TOKEN }}
```

Não crie um secret chamado `GITHUB_TOKEN`: o próprio GitHub o fornece. Também não substitua esse valor por um PAT. A documentação oficial recomenda o `GITHUB_TOKEN` para publicar packages pertencentes ao mesmo repositório: [publicação de imagens Docker](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images) e [permissões do GitHub Packages](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages).

## 1. Endurecer o workflow antes do push

O arquivo `.github/workflows/quality-gate-image.yml` já fixa as Actions por commit SHA e publica somente para tags `quality-v*`. Antes do envio, faça mais uma separação de privilégios:

- o job que valida Pull Requests deve ter somente `contents: read`;
- esse job não deve fazer login no GHCR;
- um segundo job, executado somente para tags `quality-v*`, deve ter `contents: read` e `packages: write`;
- somente o segundo job deve usar `${{ secrets.GITHUB_TOKEN }}` e publicar a imagem;
- não use `pull_request_target` para construir código de Pull Requests;
- não passe tokens como `build-arg`, variável de ambiente, label ou arquivo copiado pelo Dockerfile.

Essa separação evita conceder `packages: write` ao job que compila conteúdo de um Pull Request. O GitHub recomenda conceder ao `GITHUB_TOKEN` somente as permissões mínimas de cada job: [controle de permissões do `GITHUB_TOKEN`](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-what-your-workflow-does/controlling-permissions-for-github_token).

No GitHub, abra **Settings > Actions > General** e:

- permita somente as Actions necessárias ao projeto;
- habilite a exigência de Actions fixadas por SHA completo, se essa opção estiver disponível;
- mantenha as permissões padrão do workflow no nível mais restritivo; o job de publicação concede `packages: write` explicitamente.

## 2. Verificar o repositório local antes de criar o commit

Confirme primeiro que a URL do remote não contém usuário nem token:

```powershell
git remote get-url origin
```

O valor esperado neste projeto é:

```text
https://github.com/rodrigojager/code-approval-gates.git
```

Nunca use uma URL como `https://usuario:token@github.com/...`. Para o `git push`, use o Git Credential Manager, uma chave SSH protegida por senha ou a autenticação interativa oficial do GitHub.

Revise todos os arquivos locais:

```powershell
git status --short
git diff --check
git diff
git ls-files --others --exclude-standard
```

Não envie:

- `.env`, `.env.*` ou arquivos de secrets;
- `.quality/`, relatórios, logs ou dumps;
- `.docker/config.json` ou conteúdo de `DOCKER_AUTH_CONFIG`;
- chaves SSH, certificados privados, arquivos `.pfx`, `.p12`, `.pem` privados ou keystores;
- tokens do GitHub, GitLab, SonarQube, OpenAI ou qualquer outro serviço;
- arquivos de configuração locais contendo nomes de usuários, URLs internas ou credenciais;
- artefatos gerados e dependências como `node_modules/`.

O `.gitignore` já ignora `.quality/`, logs e dependências principais, mas o `.gitignore` não substitui a revisão manual.

### Varredura de secrets

Com a imagem local já construída, este comando verifica tanto o histórico Git quanto os arquivos atuais, inclusive arquivos ainda não rastreados. A montagem é somente leitura e os possíveis valores encontrados são ocultados na saída:

```powershell
docker run --rm --mount "type=bind,source=$((Get-Location).Path),target=/repo,readonly" --entrypoint sh code-approval-gates/quality-sidecar:gitlab-local -lc "git config --global --add safe.directory /repo && gitleaks --redact --no-banner git /repo && gitleaks --redact --no-banner dir /repo"
```

Só continue se os dois scans terminarem sem leaks. Se algum segredo real já tiver sido commitado, não basta apagar o arquivo: revogue e rotacione a credencial antes de limpar o histórico.

## 3. Criar uma branch e preparar somente os arquivos pretendidos

Crie uma branch para a entrega:

```powershell
git switch -c feat/gitlab-quality-gate-ghcr
```

Adicione explicitamente os arquivos do Quality Gate. Evite `git add .`, pois ele pode incluir um arquivo local criado por engano:

```powershell
git add -- README.md .github/workflows/quality-gate-image.yml docs/plano-gitlab-quality-gate.md docs/proximos-passos-publicacao-segura.md examples/ci/gitlab-quality-gate.yml quality-gate/
```

As alterações locais em `package.json`, `package-lock.json`, `bin/`, `scripts/` e `tests/` devem ser revisadas separadamente. Inclua-as apenas se fizerem parte da mesma entrega e, de preferência, em um commit próprio.

Revise exatamente o que será enviado:

```powershell
git status --short
git diff --cached --check
git diff --cached --name-only
git diff --cached
```

Se um arquivo inesperado estiver no stage, retire somente esse arquivo com:

```powershell
git restore --staged -- caminho/do/arquivo
```

Depois da revisão:

```powershell
git commit -m "feat: preparar Quality Gate independente para GitLab"
git push -u origin feat/gitlab-quality-gate-ghcr
```

O comando `git push` não deve receber token na linha de comando. Abra um Pull Request para `main` e aguarde os checks.

## 4. Proteger o repositório no GitHub

Antes do merge, configure uma regra de branch ou ruleset para `main` com:

- alterações somente por Pull Request;
- aprovação obrigatória;
- checks obrigatórios, incluindo o build da imagem;
- rejeição de aprovação antiga quando novos commits forem enviados;
- bloqueio de force push e exclusão da branch;
- revisão de mudanças em `.github/workflows/` por responsável autorizado, preferencialmente por `CODEOWNERS`.

Em **Settings > Security**, habilite Secret scanning e Push protection se estiverem disponíveis para o repositório. Não ignore um alerta de push protection sem investigar o valor encontrado. Consulte [push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection) e [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).

Crie também um ruleset para tags `quality-v*`:

- somente mantenedores autorizados podem criar a tag;
- atualização e exclusão da tag ficam bloqueadas;
- a tag só é criada para um commit já integrado em `main`.

## 5. Publicar a primeira imagem

Depois do merge e dos checks aprovados:

```powershell
git switch main
git pull --ff-only origin main
git tag -s quality-v0.2.0 -m "Quality Gate 0.2.0"
git push origin quality-v0.2.0
```

Use `git tag -a` no lugar de `git tag -s` somente se a assinatura de commits e tags ainda não estiver configurada. A tag dispara o workflow e publica:

```text
ghcr.io/rodrigojager/code-approval-quality-gate:0.2.0
```

Não use `latest`. Registre também o digest `sha256:` mostrado no resumo do GitHub Actions. Para produção, o GitLab pode fixar a imagem por digest, eliminando o risco de uma tag ser movida:

```yaml
CODE_APPROVAL_QUALITY_IMAGE: "ghcr.io/rodrigojager/code-approval-quality-gate@sha256:DIGEST_VERIFICADO"
```

## 6. Verificar o package antes de decidir sua visibilidade

O primeiro package de Container Registry publicado em uma conta pessoal é privado por padrão. Depois da publicação, abra **GitHub > perfil `rodrigojager` > Packages > code-approval-quality-gate > Package settings** e confirme:

- Visibility: `Private`;
- nenhuma pessoa ou equipe inesperada possui acesso;
- somente o repositório necessário está em `Manage Actions access`;
- a versão e o digest correspondem ao workflow executado;
- descrição, labels, SBOM e proveniência não revelam caminhos, URLs ou dados internos;
- a imagem não contém arquivos de configuração local nem credenciais.

Não altere a visibilidade para pública durante essa primeira verificação. Segundo o GitHub, depois de tornar um package público, não é possível torná-lo privado novamente: [controle de acesso e visibilidade de packages](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

Não trate a visibilidade privada como proteção para um segredo incluído por engano na imagem. Quem consegue baixar uma imagem pode inspecionar suas camadas, inclusive arquivos removidos em uma camada posterior. O GitHub também alerta que conceder a um repositório público acesso de Actions a um package privado pode estender esse acesso aos forks; por isso, não adicione repositórios além do estritamente necessário e nunca coloque dados confidenciais na imagem.

### Escolha posterior entre package público e privado

Se tudo que existe na imagem já está no repositório público e não há artefato proprietário, tornar somente a imagem pública reduz o risco operacional: o GitLab Runner fará o pull anônimo e nenhuma credencial do GitHub precisará existir no ambiente GitLab.

Se houver conteúdo que não deva ser distribuído, mantenha o package privado e siga a seção seguinte. A decisão de torná-lo público deve ser explícita, porque é irreversível.

## 7. Dar acesso ao GitLab Runner quando o package for privado

Não use a conta pessoal do proprietário no runner. Crie uma conta técnica GitHub exclusiva, por exemplo `quality-gate-reader`, com:

- autenticação de dois fatores;
- nenhuma permissão de escrita no repositório ou no package;
- acesso `Read` somente ao package `code-approval-quality-gate`;
- um PAT classic com apenas o scope `read:packages` e prazo de expiração curto;
- token guardado no cofre de senhas corporativo, com responsável e data de rotação.

No package, abra **Package settings > Manage access > Invite teams or people**, adicione a conta técnica e selecione `Read`. Em seguida, autenticado como a conta técnica, crie o token em **Settings > Developer settings > Personal access tokens > Tokens (classic)**.

O GHCR exige um PAT classic com `read:packages` para um cliente externo baixar um package privado. O usuário dono do token também precisa ter permissão de leitura no package: [autenticação e permissões do GitHub Packages](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages).

### Local recomendado para a credencial

Configure a autenticação no host de um GitLab Runner dedicado e bloqueado para os projetos autorizados. Assim, o runner usa a credencial apenas para baixar a imagem; o valor não vira variável do script do job de Merge Request.

Em um runner Linux instalado como serviço, confirme primeiro qual usuário executa o processo. Se for `gitlab-runner`, execute no host:

```bash
read -rsp "Token de leitura do GHCR: " GHCR_READ_TOKEN
printf '%s' "$GHCR_READ_TOKEN" | sudo -H -u gitlab-runner docker login ghcr.io --username quality-gate-reader --password-stdin
unset GHCR_READ_TOKEN
sudo chmod 600 /home/gitlab-runner/.docker/config.json
```

O token não aparece na linha de comando nem no histórico. O arquivo `config.json` ainda contém uma credencial reutilizável e deve ser legível somente pelo usuário do serviço. Se o runner executar dentro de container ou como `root`, o diretório correto será diferente; configure o arquivo persistente usado pelo processo do runner, não copie o arquivo para o repositório.

Se a infraestrutura oferecer um Docker credential helper compatível com o GitLab Runner, prefira-o ao armazenamento direto em `config.json`.

Não use uma variável `DOCKER_AUTH_CONFIG` no nível do projeto para o piloto se código não confiável de Merge Requests puder executar no mesmo job. Variáveis mascaradas reduzem exposição acidental em logs, mas continuam disponíveis ao processo autorizado a recebê-las. A configuração por runner dedicado reduz essa superfície. O GitLab documenta a autenticação por `${GITLAB_RUNNER_HOME}/.docker/config.json` e por configuração do runner em [uso de imagens Docker privadas](https://docs.gitlab.com/ci/docker/using_docker_images/).

O runner deve permanecer restrito:

```toml
[runners.docker]
  privileged = false
  pull_policy = "always"
  allowed_images = [
    "ghcr.io/rodrigojager/code-approval-quality-gate:*",
    "mcr.microsoft.com/dotnet/sdk:*"
  ]
```

Não monte `/var/run/docker.sock` no job. Bloqueie o runner para o projeto ou grupo autorizado e não permita que projetos arbitrários o utilizem.

A imagem usa o usuário não privilegiado `quality` por padrão. O template do GitLab e os wrappers locais selecionam UID 0 explicitamente somente dentro do container de análise para gravar os relatórios em volumes montados, independentemente do UID usado pelo host. Confirme que as versões do GitLab e do Runner suportam `image:docker:user`. Isso não equivale a root no runner: mantenha `privileged = false`, não monte o socket Docker e restrinja `allowed_images`. O template envia como artifacts somente `quality-report.json` e `quality-report.md`; a pasta `raw/` não deve ser publicada, e o Gitleaks deve manter redaction habilitado.

Teste o acesso no host e remova a imagem local antes do segundo pull para evitar um falso positivo causado por cache:

```bash
sudo -H -u gitlab-runner docker pull ghcr.io/rodrigojager/code-approval-quality-gate:0.2.0
```

## 8. Ativar o Quality Gate no GitLab

Integre `examples/ci/gitlab-quality-gate.yml` ao template central. No piloto, mantenha:

```yaml
variables:
  CODE_APPROVAL_QUALITY_ENABLED: "true"
  CODE_APPROVAL_QUALITY_BLOCKING: "false"
```

O job será executado somente em Merge Requests destinados a `develop`, conforme as regras atuais. Ele pode rodar no mesmo stage do SonarQube; os dois gates são independentes.

Execute pelo menos três MRs representativos e verifique:

- pull da imagem sem erro de autenticação;
- nenhuma credencial presente nos logs ou artifacts;
- reports JSON e Markdown disponíveis em `.quality/reports/`;
- ausência de Docker-in-Docker, modo privilegiado e socket Docker;
- tempo, CPU, memória e acesso às bases dos scanners;
- falsos positivos e findings da dívida legada.

Depois de corrigir problemas operacionais e estabelecer o baseline:

```yaml
variables:
  CODE_APPROVAL_QUALITY_BLOCKING: "true"
```

Confirme no GitLab que **Pipelines must succeed** está habilitado para a branch de destino. A partir desse momento, uma reprovação do Quality Gate ou do SonarQube deve impedir o merge.

## 9. Rotação e resposta a incidentes

Para o token somente leitura do GHCR:

- defina uma validade curta e um lembrete antes do vencimento;
- gere o token substituto com a mesma permissão mínima;
- atualize o login no runner;
- teste o pull;
- revogue o token antigo;
- registre a rotação sem registrar o valor do token.

Se qualquer token aparecer em commit, Pull Request, issue, artifact, screenshot ou log:

1. revogue o token imediatamente;
2. gere outro token com permissão mínima;
3. verifique os logs de acesso e os packages alcançáveis pela conta;
4. remova o segredo do histórico Git com procedimento próprio;
5. invalide caches, artifacts e forks que possam conservar o conteúdo;
6. execute novamente o Gitleaks no histórico e no diretório atual.

Nunca cole um token real neste documento, em chats, comandos salvos, issues ou exemplos de YAML.

## Checklist de liberação

- [ ] Workflow separado em job de PR somente leitura e job de tag com `packages: write`.
- [ ] Nenhum PAT configurado no GitHub Actions.
- [ ] Remote Git sem credencial embutida na URL.
- [ ] `git diff --cached` revisado arquivo por arquivo.
- [ ] Gitleaks aprovado no histórico e no diretório atual.
- [ ] Branch e tag protegidas por rulesets.
- [ ] Pull Request aprovado antes do merge.
- [ ] Tag criada somente a partir de `main` atualizada.
- [ ] Primeiro package confirmado como privado.
- [ ] Conteúdo, metadados, SBOM e proveniência da imagem revisados.
- [ ] Se privado, conta técnica com somente `read:packages` e acesso `Read` ao package.
- [ ] Token armazenado no runner dedicado, nunca no repositório ou script do job.
- [ ] Runner sem modo privilegiado e sem socket Docker.
- [ ] Imagem fixada por versão e, após validação, preferencialmente por digest.
- [ ] Três MRs executados em modo não bloqueante antes de ativar o bloqueio.
