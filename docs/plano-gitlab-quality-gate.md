# Plano revisado: Quality Gate no GitLab com imagem no GHCR

## Decisão arquitetural

Para a necessidade atual, será mantida uma única imagem do Quality Gate. Ela será construída pelo GitHub Actions, publicada no GitHub Container Registry (GHCR) e executada diretamente pelo Docker executor do GitLab Runner.

```text
GitHub (código e release) -> GHCR (imagem versionada) -> GitLab Runner (job do MR)
                                                        |-> SonarQube
                                                        |-> Quality Gate
```

O job do Merge Request não executa Docker dentro de Docker, não recebe `/var/run/docker.sock`, não instala npm e não contém o Semantic Gate. O Docker é usado apenas pelo GitLab Runner para iniciar a imagem do job.

Compose não é necessário nesse fluxo. Ele seria útil para subir serviços que precisassem conversar entre si; o Quality Gate é um processo de análise que termina e devolve um código de saída. SonarQube continua sendo um serviço externo já administrado separadamente.

## O que mudou em relação ao plano original

O plano original continua útil como visão de longo prazo, mas tenta resolver muitas questões antes de colocar o primeiro gate em operação. Para o piloto, ficam removidos do caminho crítico:

- criação de uma segunda imagem ou de um target `gitlab`;
- implementação de `--engine=local` no wrapper Node;
- publicação npm do wrapper;
- Container Registry no GitLab;
- runner privilegiado para construir imagens;
- Docker-in-Docker em pipelines de Merge Request;
- integração de cobertura antes de confirmar o artifact produzido pelo projeto consumidor;
- relatório CodeClimate e comentários automáticos no Merge Request;
- escopo baseado em diff antes de existir uma implementação testada.

A imagem atual já instala o comando `quality-sidecar`. No GitLab, o template sobrescreve o entrypoint da imagem e chama esse comando diretamente. O wrapper `quality-check` continua container-first para uso em desktops.

Como o primeiro consumidor é uma aplicação .NET web, a imagem usa a flavor oficial `dotnetweb` do MegaLinter. Ela inclui linters de C#, arquivos web e formatos de infraestrutura relevantes, e reduz aproximadamente pela metade o tamanho compactado da base completa. Antes do rollout para stacks diferentes, valide outra flavor ou uma variante da imagem; não presuma que uma imagem otimizada para .NET cobre todas as linguagens.

## Limitação conhecida do primeiro piloto

O Quality Gate atual analisa todo o checkout. Ele ainda não separa arquivos alterados de arquivos usados apenas como contexto. Portanto, a promessa do plano original de que dívida legada não alterada nunca bloqueará o MR ainda não está implementada.

Por esse motivo, o template começa com:

```yaml
CODE_APPROVAL_QUALITY_BLOCKING: "false"
```

Nesse modo, o job executa, gera relatórios e pode falhar sem bloquear o merge. Depois de levantar o baseline e corrigir ou tratar falsos positivos de forma explícita, altere a variável para `"true"`. A implementação de escopo por diff deve ser uma fase posterior, com testes próprios para ranges de Merge Request do GitLab.

## Publicação no GHCR

O workflow `.github/workflows/quality-gate-image.yml`:

- constrói a imagem em Pull Requests que alterem o Quality Gate;
- publica apenas quando uma tag `quality-v*` é enviada;
- usa o `GITHUB_TOKEN`, sem PAT adicional para publicação;
- publica tags versionadas e uma tag baseada no SHA;
- não publica `latest`;
- gera SBOM e proveniência pelo BuildKit;
- fixa as GitHub Actions por commit SHA.

Primeira publicação sugerida, depois que as mudanças estiverem revisadas e commitadas:

```powershell
git tag -s quality-v0.2.0 -m "Quality Gate 0.2.0"
git push origin quality-v0.2.0
```

Se a assinatura de tags ainda não estiver configurada, use uma tag anotada com `git tag -a` e registre a configuração de assinatura como melhoria posterior.

Isso publicará:

```text
ghcr.io/rodrigojager/code-approval-quality-gate:0.2.0
```

O GHCR cria o primeiro pacote como privado. Mantenha essa visibilidade durante a primeira publicação e verifique o conteúdo e os metadados da imagem antes de tomar outra decisão.

Se a imagem continuar privada, use uma conta técnica separada, com acesso `Read` somente ao package e PAT classic limitado a `read:packages`. Armazene essa credencial no host de um runner dedicado, não no repositório nem no script do job de Merge Request. Se a imagem contiver apenas conteúdo que já é público neste repositório, torná-la pública posteriormente elimina a necessidade de uma credencial GitHub no GitLab, mas essa mudança de visibilidade é irreversível.

O procedimento completo de revisão, credenciais, push, publicação e configuração segura do runner está em `docs/proximos-passos-publicacao-segura.md`.

## Preparação do GitLab Runner

O runner consumidor deve continuar com:

```toml
[runners.docker]
  privileged = false
  pull_policy = "always"
  allowed_images = [
    "ghcr.io/rodrigojager/code-approval-quality-gate:*",
    "mcr.microsoft.com/dotnet/sdk:*"
  ]
```

Não monte o socket Docker no runner. Se `allowed_images` já existe, acrescente a imagem do Quality Gate sem remover as imagens necessárias aos outros jobs.

A imagem usa o usuário não privilegiado `quality` por padrão. O template seleciona UID 0 explicitamente apenas dentro do container isolado do job para gravar relatórios em checkouts do GitLab com diferentes modelos de ownership. Isso exige uma versão do GitLab e do Runner compatível com `image:docker:user`. O usuário do container não recebe privilégio no host: `privileged` permanece `false`, o socket Docker não é montado e `allowed_images` restringe a imagem. O template publica como artifacts apenas os relatórios normalizados JSON e Markdown; evidências brutas dos scanners não são enviadas.

## Integração no pipeline consumidor

Copie ou inclua `examples/ci/gitlab-quality-gate.yml` no template central usado pelo projeto consumidor. O job usa o stage `quality`; ajuste apenas o nome do stage se a pipeline central usar outro.

SonarQube e Quality Gate podem rodar em paralelo no mesmo stage. Ambos bloqueiam o merge quando seus jobs são obrigatórios e a opção `Pipelines must succeed` está habilitada. Não existe necessidade técnica de executar o Quality Gate depois do SonarQube.

Para o piloto:

```yaml
variables:
  CODE_APPROVAL_QUALITY_ENABLED: "true"
  CODE_APPROVAL_QUALITY_BLOCKING: "false"
```

Para ativar o bloqueio após o baseline:

```yaml
variables:
  CODE_APPROVAL_QUALITY_BLOCKING: "true"
```

Mantenha coverage desabilitado até que um job anterior publique um arquivo Cobertura em caminho confirmado. Depois disso, habilite:

```yaml
variables:
  CODE_APPROVAL_QUALITY_ENABLE_COVERAGE: "true"
  CODE_APPROVAL_QUALITY_COVERAGE_REPORT: "TestResults/**/coverage.cobertura.xml"
  CODE_APPROVAL_QUALITY_MIN_LINE_COVERAGE: "80"
```

PII também começa desabilitado por causa do risco de falsos positivos em fixtures e documentação. A detecção de secrets começa habilitada.

## Critérios de aceite do MVP

- uma tag `quality-v*` publica uma imagem versionada no GHCR;
- a imagem não contém nem instala o Semantic Gate;
- o GitLab Runner baixa a imagem sem modo privilegiado e sem socket Docker;
- o job roda somente em Merge Requests destinados a `develop`;
- os relatórios JSON e Markdown ficam disponíveis mesmo quando o gate reprova;
- `CODE_APPROVAL_QUALITY_BLOCKING="true"` faz um resultado não aprovado bloquear o merge;
- SonarQube continua funcionando como gate independente;
- coverage só é habilitado quando seu artifact existir;
- nenhuma tag `latest` é usada no pipeline consumidor.

## Próximas fases, na ordem recomendada

1. Publicar `quality-v0.2.0` e executar o job em modo não bloqueante em três MRs representativos.
2. Corrigir falhas operacionais da imagem e levantar o baseline de findings.
3. Confirmar tempo, memória e acesso de rede para as bases do Trivy, Semgrep e OSV Scanner.
4. Tornar o job bloqueante.
5. Integrar coverage usando o artifact real do job .NET.
6. Implementar escopo por diff do GitLab para evitar bloqueio por dívida legada não alterada.
7. Melhorar a normalização dos resultados do MegaLinter e adicionar relatório CodeClimate, se ainda houver valor após SonarQube.
