# syntax=docker/dockerfile:1.7

# The portable image is the default. CI passes the pinned dotnetweb image and
# QUALITY_GATE_FLAVOR=dotnetweb for the first company-oriented publication.
ARG MEGALINTER_IMAGE=ghcr.io/oxsecurity/megalinter:v9.6.0@sha256:248e30b43bdfa7ce941fd5e410159da4d69716c68c48a459b08d1760c4625ef5
FROM ${MEGALINTER_IMAGE}

USER root

ARG TARGETARCH=amd64
ARG QUALITY_GATE_FLAVOR=generic
ARG CHECKOV_INSTALL_VERSION=3.3.8
ARG JSCPD_INSTALL_VERSION=5.0.12
ARG SEMGREP_INSTALL_VERSION=1.169.0
ARG TRIVY_INSTALL_VERSION=0.72.0
ARG TRIVY_INSTALL_SHA256=bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea
ARG GITLEAKS_INSTALL_VERSION=8.30.1
ARG GITLEAKS_INSTALL_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG OSV_SCANNER_INSTALL_VERSION=2.4.0
ARG OSV_SCANNER_INSTALL_SHA256=15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0

LABEL org.opencontainers.image.source="https://github.com/rodrigojager/code-approval-gates" \
      org.opencontainers.image.description="Deterministic Quality Gate for local and GitLab CI execution" \
      org.opencontainers.image.licenses="MIT" \
      io.code-approval.quality-gate.flavor="${QUALITY_GATE_FLAVOR}" \
      io.code-approval.quality-gate.platform="linux/amd64"

RUN set -eux; \
    test "${TARGETARCH}" = "amd64"; \
    case "${QUALITY_GATE_FLAVOR}" in generic|dotnetweb) ;; *) exit 1 ;; esac; \
    mkdir -p /etc/code-approval; \
    printf '%s\n' "${QUALITY_GATE_FLAVOR}" > /etc/code-approval/quality-gate-flavor; \
    : > /etc/code-approval/quality-gate-transport.env; \
    chown root:root /etc/code-approval/quality-gate-flavor; \
    chown root:root /etc/code-approval/quality-gate-transport.env; \
    chmod 0444 /etc/code-approval/quality-gate-flavor; \
    chmod 0444 /etc/code-approval/quality-gate-transport.env

RUN apk add --no-cache \
    ca-certificates \
    bash \
    curl \
    git \
    gzip \
    jq \
    nodejs \
    npm \
    python3 \
    py3-pip \
    py3-virtualenv \
    tar \
    unzip

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Preserve the base flavor's analyzer paths without trusting PATH supplied by
# a GitLab job. The corporate launcher reads only this root-owned snapshot.
RUN set -eux; \
    quality_gate_path="${PATH}"; \
    test -n "${quality_gate_path}"; \
    [[ "${quality_gate_path}" != *$'\n'* && "${quality_gate_path}" != *$'\r'* ]]; \
    case ":${quality_gate_path}:" in *:/usr/local/bin:*) ;; *) quality_gate_path="/usr/local/bin:${quality_gate_path}" ;; esac; \
    printf '%s\n' "${quality_gate_path}" > /etc/code-approval/quality-gate-path; \
    chown root:root /etc/code-approval/quality-gate-path; \
    chmod 0444 /etc/code-approval/quality-gate-path

# Semgrep and Checkov have overlapping but incompatible Python dependency
# graphs. Keep them isolated from one another and from MegaLinter's runtime.
RUN set -eux; \
    python3 -m venv /opt/venvs/semgrep; \
    /opt/venvs/semgrep/bin/pip install --no-cache-dir "semgrep==${SEMGREP_INSTALL_VERSION}"; \
    /opt/venvs/semgrep/bin/pip check; \
    ln -sf /opt/venvs/semgrep/bin/semgrep /usr/local/bin/semgrep

RUN set -eux; \
    python3 -m venv /opt/venvs/checkov; \
    /opt/venvs/checkov/bin/pip install --no-cache-dir "checkov==${CHECKOV_INSTALL_VERSION}"; \
    /opt/venvs/checkov/bin/pip check; \
    ln -sf /opt/venvs/checkov/bin/checkov /usr/local/bin/checkov

RUN set -eux; \
  version="${GITLEAKS_INSTALL_VERSION#v}"; \
  release_arch="x64"; \
  curl -sSfL \
    "https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_${release_arch}.tar.gz" \
    -o /tmp/gitleaks.tar.gz; \
  printf '%s  %s\n' "${GITLEAKS_INSTALL_SHA256}" /tmp/gitleaks.tar.gz | sha256sum -c -; \
  tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks; \
  chmod +x /usr/local/bin/gitleaks; \
  rm /tmp/gitleaks.tar.gz

RUN set -eux; \
  version="${TRIVY_INSTALL_VERSION#v}"; \
  release_arch="64bit"; \
  artifact="trivy_${version}_Linux-${release_arch}.tar.gz"; \
  curl -sSfL \
    "https://github.com/aquasecurity/trivy/releases/download/v${version}/${artifact}" \
    -o "/tmp/${artifact}"; \
  printf '%s  %s\n' "${TRIVY_INSTALL_SHA256}" "/tmp/${artifact}" | sha256sum -c -; \
  tar -xzf "/tmp/${artifact}" -C /usr/local/bin trivy; \
  chmod +x /usr/local/bin/trivy; \
  rm "/tmp/${artifact}"

RUN set -eux; \
  version="${OSV_SCANNER_INSTALL_VERSION#v}"; \
  release_arch="amd64"; \
  curl -sSfL \
    "https://github.com/google/osv-scanner/releases/download/v${version}/osv-scanner_linux_${release_arch}" \
    -o /usr/local/bin/osv-scanner; \
  printf '%s  %s\n' "${OSV_SCANNER_INSTALL_SHA256}" /usr/local/bin/osv-scanner | sha256sum -c -; \
  chmod +x /usr/local/bin/osv-scanner

RUN set -eux; \
    npm install -g "jscpd@${JSCPD_INSTALL_VERSION}"; \
    npm cache clean --force

WORKDIR /opt/quality-sidecar
COPY pyproject.toml /opt/quality-sidecar/pyproject.toml
COPY sidecar /opt/quality-sidecar/sidecar
COPY docker/entrypoint.sh /opt/quality-sidecar/entrypoint.sh
COPY docker/quality-ci /usr/local/bin/quality-ci
RUN set -eux; \
    chmod +x /opt/quality-sidecar/entrypoint.sh; \
    chmod 0555 /usr/local/bin/quality-ci; \
    python3 -m venv /opt/venvs/quality-sidecar; \
    /opt/venvs/quality-sidecar/bin/pip install --no-cache-dir /opt/quality-sidecar; \
    /opt/venvs/quality-sidecar/bin/pip check; \
    ln -sf /opt/venvs/quality-sidecar/bin/quality-sidecar /usr/local/bin/quality-sidecar; \
    ln -sf /opt/venvs/quality-sidecar/bin/quality-check /usr/local/bin/quality-check; \
    chown -R root:root /opt/quality-sidecar; \
    chmod -R go-w /opt/quality-sidecar

# Build-time smoke tests prove that every pinned executable starts and that
# each isolated Python environment is internally consistent.
RUN set -eux; \
    /opt/venvs/quality-sidecar/bin/pip check; \
    /opt/venvs/semgrep/bin/pip check; \
    /opt/venvs/checkov/bin/pip check; \
    quality-sidecar --help >/dev/null; \
    quality-ci --help >/dev/null; \
    test "$(/opt/venvs/semgrep/bin/python -c 'import importlib.metadata as m; print(m.version("semgrep"))')" = "${SEMGREP_INSTALL_VERSION}"; \
    /opt/venvs/semgrep/bin/semgrep --version >/dev/null; \
    test "$(/opt/venvs/checkov/bin/python -c 'import importlib.metadata as m; print(m.version("checkov"))')" = "${CHECKOV_INSTALL_VERSION}"; \
    /opt/venvs/checkov/bin/checkov --version >/dev/null; \
    test "$(gitleaks version | head -n 1)" = "${GITLEAKS_INSTALL_VERSION}"; \
    test "$(trivy --version | awk -F ': ' '/^Version:/ {print $2; exit}')" = "${TRIVY_INSTALL_VERSION}"; \
    test "$(osv-scanner --version | awk '/^osv-scanner version:/ {print $3; exit}')" = "${OSV_SCANNER_INSTALL_VERSION}"; \
    test "$(node -p 'require("/usr/local/lib/node_modules/jscpd/package.json").version')" = "${JSCPD_INSTALL_VERSION}"; \
    jscpd --version >/dev/null; \
    test "$(stat -c '%u:%g:%a' /node-deps/package.json)" = "0:0:644"; \
    test "$(stat -c '%u:%g:%a' /node-deps/node_modules/@eslint/js/package.json)" = "0:0:644"; \
    test "$(node -e 'const { createRequire } = require("node:module"); const trustedRequire = createRequire("/node-deps/package.json"); process.stdout.write(trustedRequire.resolve("@eslint/js"));')" = "/node-deps/node_modules/@eslint/js/src/index.js"; \
    node --input-type=module -e 'await import("/opt/quality-sidecar/sidecar/config/eslint.config.mjs")'; \
    if [[ "${QUALITY_GATE_FLAVOR}" == "generic" ]]; then \
      tflint_smoke_dir="$(mktemp -d)"; \
      printf '%s\n' 'terraform {' '  required_version = ">= 1.5.0"' '}' > "${tflint_smoke_dir}/main.tf"; \
      tflint --config /opt/quality-sidecar/sidecar/config/tflint-ci.hcl --chdir "${tflint_smoke_dir}" --format compact; \
      rm "${tflint_smoke_dir}/main.tf"; \
      rmdir "${tflint_smoke_dir}"; \
    fi; \
    test -x /entrypoint.sh; \
    test -x /opt/quality-sidecar/entrypoint.sh; \
    test -x /usr/local/bin/quality-ci; \
    test "$(stat -c '%u:%g:%a' /etc/code-approval/quality-gate-flavor)" = "0:0:444"; \
    test "$(stat -c '%u:%g:%a' /etc/code-approval/quality-gate-path)" = "0:0:444"; \
    test "$(stat -c '%u:%g:%a' /etc/code-approval/quality-gate-transport.env)" = "0:0:444"; \
    test -s /etc/code-approval/quality-gate-path; \
    for config in \
      eslint.config.mjs \
      megalinter-ci.yml \
      checkov-ci.yml \
      gitleaks-ci.toml \
      gitleaksignore-ci \
      jscpd-ci.json \
      osv-scanner-ci.toml \
      tflint-ci.hcl \
      trivy-ci.yaml \
      trivyignore-ci; do \
        path="/opt/quality-sidecar/sidecar/config/${config}"; \
        test -r "${path}"; \
        test "$(stat -c '%u:%g' "${path}")" = "0:0"; \
        case "$(stat -c '%a' "${path}")" in [0-7][0145][0145]) ;; *) exit 1 ;; esac; \
    done

RUN addgroup -S -g 10001 quality \
  && adduser -S -D -u 10001 -h /home/quality -G quality quality \
  && mkdir -p /home/quality/.cache /workspace \
  && chown -R quality:quality /home/quality /workspace

ENV HOME=/home/quality \
    XDG_CACHE_HOME=/home/quality/.cache

WORKDIR /workspace
USER quality
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD /opt/venvs/quality-sidecar/bin/python -c "import quality_sidecar" || exit 1
ENTRYPOINT ["/opt/quality-sidecar/entrypoint.sh"]
CMD ["check", "/workspace"]
