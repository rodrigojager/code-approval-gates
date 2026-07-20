# syntax=docker/dockerfile:1.7

ARG MEGALINTER_IMAGE=ghcr.io/oxsecurity/megalinter:v9.5.0@sha256:00830d91da662d05221c1c0005f9010416030bd1da89afbcb55a9c52945ebd48
ARG GITLEAKS_BUILDER_IMAGE=golang:1.25.7-alpine3.23@sha256:724e212d86d79b45b7ace725b44ff3b6c2684bfd3131c43d5d60441de151d98e
ARG GITLEAKS_INSTALL_VERSION=8.30.1
ARG GITLEAKS_SOURCE_COMMIT=83d9cd684c87d95d656c1458ef04895a7f1cbd8e
ARG GITLEAKS_SOURCE_SHA256=6b2638a733b85619dc80bdf28e84e4fed7e526a761ab5c148fbf67695aea2115

# Rebuild the released Gitleaks source with the first Go 1.25 patch that fixes
# CVE-2025-68121. The upstream v8.30.1 binary was compiled with Go 1.24.11.
FROM ${GITLEAKS_BUILDER_IMAGE} AS gitleaks-builder

ARG GITLEAKS_INSTALL_VERSION
ARG GITLEAKS_SOURCE_COMMIT
ARG GITLEAKS_SOURCE_SHA256

RUN set -eux; \
    apk add --no-cache ca-certificates curl tar; \
    mkdir -p /src/gitleaks /out; \
    curl -sSfL \
      "https://github.com/gitleaks/gitleaks/archive/${GITLEAKS_SOURCE_COMMIT}.tar.gz" \
      -o /tmp/gitleaks-source.tar.gz; \
    printf '%s  %s\n' "${GITLEAKS_SOURCE_SHA256}" /tmp/gitleaks-source.tar.gz | sha256sum -c -; \
    tar -xzf /tmp/gitleaks-source.tar.gz -C /src/gitleaks --strip-components=1; \
    cd /src/gitleaks; \
    go mod download; \
    CGO_ENABLED=0 go build \
      -trimpath \
      -tags gore2regex \
      -ldflags "-s -w -buildid= -X=github.com/zricethezav/gitleaks/v8/version.Version=${GITLEAKS_INSTALL_VERSION}" \
      -o /out/gitleaks \
      ./main.go; \
    test "$(/out/gitleaks version | head -n 1)" = "${GITLEAKS_INSTALL_VERSION}"; \
    go version -m /out/gitleaks | grep -F ': go1.25.7'

# The portable image is the default. CI passes the pinned dotnetweb image and
# QUALITY_GATE_FLAVOR=dotnetweb for the first company-oriented publication.
# Keep the v9.5/Alpine 3.23 base until a released Semgrep build contains the
# upstream OCaml fix for musl 1.2.6 signal stacks on affected Intel CPUs.
FROM ${MEGALINTER_IMAGE}

USER root

ARG TARGETARCH=amd64
ARG QUALITY_GATE_FLAVOR=generic
ARG CHECKOV_INSTALL_VERSION=3.3.8
ARG JSCPD_INSTALL_VERSION=5.0.12
ARG SEMGREP_INSTALL_VERSION=1.169.0
ARG TRIVY_INSTALL_VERSION=0.72.0
ARG TRIVY_INSTALL_SHA256=bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea
ARG GITLEAKS_INSTALL_VERSION
ARG OSV_SCANNER_INSTALL_VERSION=2.4.0
ARG OSV_SCANNER_INSTALL_SHA256=15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0
ARG TERRASCAN_INSTALL_VERSION=1.19.9

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

RUN apk upgrade --no-cache \
  && apk add --no-cache \
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

# MegaLinter v9.5 ships hadolint as mode 0777. A non-root merge request could
# otherwise replace that executable before another analyzer resolves it.
RUN set -eux; \
    test -f /usr/bin/hadolint; \
    chown root:root /usr/bin/hadolint; \
    chmod 0555 /usr/bin/hadolint; \
    test "$(stat -c '%u:%g:%a' /usr/bin/hadolint)" = "0:0:555"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# MegaLinter v9.5 keeps its .NET global tools below /root and places its
# bundled Node tools ahead of /usr/local/bin. The production user cannot
# traverse /root, and that ordering would also shadow our pinned JSCPD. The
# dotnetweb gate enables an explicit linter allowlist, so remove inherited
# analyzers outside that allowlist before copying the required .NET tools.
# This also removes their unreachable vulnerable runtimes from the image.
RUN set -eux; \
    mkdir -p \
      /opt/megalinter-dotnet-tools \
      /opt/megalinter-composer/vendor/bin \
      /opt/megalinter-rust-toolchain/bin; \
    if [[ "${QUALITY_GATE_FLAVOR}" == "dotnetweb" ]]; then \
      test -d /root/.dotnet/tools; \
      for unused_binary in editorconfig-checker kubeconform ls-lint protolint; do \
        rm -f "/usr/bin/${unused_binary}"; \
        ! command -v "${unused_binary}"; \
      done; \
      test -d /root/.dotnet/tools/.store/tsqllint; \
      rm -rf \
        /root/.dotnet/tools/.store/tsqllint \
        /root/.dotnet/tools/tsqllint; \
      test -d /node-deps/node_modules/gherkin-lint; \
      test -d /node-deps/node_modules/protobufjs; \
      npm pkg delete 'dependencies.gherkin-lint' --prefix /node-deps; \
      rm -rf \
        /node-deps/node_modules/gherkin-lint \
        /node-deps/node_modules/gherkin \
        /node-deps/node_modules/cucumber-messages \
        /node-deps/node_modules/protobufjs; \
      node -e 'const p = require("/node-deps/package.json"); if (p.dependencies?.["gherkin-lint"]) process.exit(1)'; \
      cp -al /root/.dotnet/tools/. /opt/megalinter-dotnet-tools/; \
    fi; \
    chown -R root:root \
      /opt/megalinter-dotnet-tools \
      /opt/megalinter-composer \
      /opt/megalinter-rust-toolchain; \
    chmod -R a+rX,go-w \
      /opt/megalinter-dotnet-tools \
      /opt/megalinter-composer \
      /opt/megalinter-rust-toolchain

# MegaLinter v9.5's dotnet-format adapter mirrors output to /dev/tty2, which
# is intentionally unavailable to the non-root production user. Both flavors
# can auto-detect C#, so patch the reviewed upstream file in both and refuse to
# continue if its digest or exact source line changes.
RUN set -eux; \
    adapter=/megalinter/linters/DotnetFormatLinter.py; \
    printf '%s  %s\n' \
      'aa3808d2dbb71e8522c274ace56b86bddbd6e41e8c93e1626fe8c0693c5ab72a' \
      "${adapter}" | sha256sum -c -; \
    test "$(grep -Fxc '            dotnet_format_command + " | tee /dev/tty2 2>&1",' "${adapter}")" = "1"; \
    sed -i 's# | tee /dev/tty2 2>&1# | tee /dev/stderr 2>\&1#' "${adapter}"; \
    test "$(grep -Fxc '            dotnet_format_command + " | tee /dev/stderr 2>&1",' "${adapter}")" = "1"; \
    ! grep -F 'tee /dev/tty2' "${adapter}"

ENV PATH="/usr/local/bin:/opt/megalinter-dotnet-tools:/opt/megalinter-composer/vendor/bin:/opt/megalinter-rust-toolchain/bin:${PATH}"

# Preserve the base flavor's analyzer paths without trusting PATH supplied by
# a GitLab job. The corporate launcher reads only this root-owned snapshot.
RUN set -eux; \
    quality_gate_path=""; \
    append_trusted_path() { \
      candidate="$1"; \
      case "${candidate}" in /*) ;; *) return 0 ;; esac; \
      case "${candidate}" in /root|/root/*) return 0 ;; esac; \
      canonical="$(readlink -f "${candidate}")" || return 0; \
      test -d "${canonical}" || return 0; \
      case "${canonical}" in /root|/root/*) return 0 ;; esac; \
      current="${canonical}"; \
      while [[ "${current}" != "/" ]]; do \
        [[ "$(stat -c '%u:%g' "${current}")" == "0:0" ]] || return 0; \
        case "$(stat -c '%a' "${current}")" in [0-7][0145][15]) ;; *) return 0 ;; esac; \
        current="${current%/*}"; \
        [[ -n "${current}" ]] || current="/"; \
      done; \
      case ":${quality_gate_path}:" in *:"${canonical}":*) return 0 ;; esac; \
      quality_gate_path="${quality_gate_path:+${quality_gate_path}:}${canonical}"; \
    }; \
    append_trusted_path /usr/local/bin; \
    append_trusted_path /opt/megalinter-dotnet-tools; \
    append_trusted_path /opt/megalinter-composer/vendor/bin; \
    append_trusted_path /opt/megalinter-rust-toolchain/bin; \
    IFS=: read -r -a base_path_entries <<< "${PATH}"; \
    for path_entry in "${base_path_entries[@]}"; do \
      append_trusted_path "${path_entry}"; \
    done; \
    test -n "${quality_gate_path}"; \
    [[ "${quality_gate_path}" != *$'\n'* && "${quality_gate_path}" != *$'\r'* ]]; \
    case ":${quality_gate_path}:" in *:/usr/local/bin:*) ;; *) exit 1 ;; esac; \
    case "${quality_gate_path}" in *'~'*|*'/root/'*) exit 1 ;; esac; \
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

RUN rm -f /usr/bin/gitleaks
COPY --from=gitleaks-builder --chown=0:0 --chmod=0555 /out/gitleaks /usr/local/bin/gitleaks

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

# The generic v9.5 base also stores DevSkim and the rest of its .NET-backed
# language analyzers under /root. Copy them after the gate toolchains so this
# large compatibility layer does not invalidate unrelated dependency caches.
RUN set -eux; \
    if [[ "${QUALITY_GATE_FLAVOR}" == "generic" ]]; then \
      test -d /root/.dotnet/tools; \
      test -d /root/.composer/vendor; \
      test -d /root/.rustup/toolchains/stable-x86_64-unknown-linux-musl; \
      cp -al /root/.dotnet/tools/. /opt/megalinter-dotnet-tools/; \
      cp -al /root/.composer/vendor/. /opt/megalinter-composer/vendor/; \
      cp -al /root/.rustup/toolchains/stable-x86_64-unknown-linux-musl/. /opt/megalinter-rust-toolchain/; \
      test ! -e /opt/megalinter-composer/auth.json; \
      test ! -e /opt/megalinter-composer/config.json; \
      chown -R root:root \
        /opt/megalinter-dotnet-tools \
        /opt/megalinter-composer \
        /opt/megalinter-rust-toolchain; \
      chmod -R a+rX,go-w \
        /opt/megalinter-dotnet-tools \
        /opt/megalinter-composer \
        /opt/megalinter-rust-toolchain; \
    fi

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
    test "$(command -v jscpd)" = "/usr/local/bin/jscpd"; \
    test "$(jscpd --version)" = "cpd ${JSCPD_INSTALL_VERSION}"; \
    printf '%s  %s\n' \
      '54ccd8bc063777753f3f55b8d61cd85c6fa972c140729ad939225ee60db94d20' \
      /megalinter/linters/DotnetFormatLinter.py | sha256sum -c -; \
    test "$(stat -c '%u:%g:%a' /megalinter/linters/DotnetFormatLinter.py)" = "0:0:644"; \
    if [[ "${QUALITY_GATE_FLAVOR}" == "dotnetweb" ]]; then \
      test "$(command -v csharpier)" = "/opt/megalinter-dotnet-tools/csharpier"; \
      test "$(command -v roslynator)" = "/opt/megalinter-dotnet-tools/roslynator"; \
      csharpier --version >/dev/null; \
      roslynator --version >/dev/null; \
      for unused_binary in editorconfig-checker kubeconform ls-lint protolint tsqllint; do \
        ! command -v "${unused_binary}"; \
      done; \
      test ! -e /root/.dotnet/tools/.store/tsqllint; \
      test ! -e /opt/megalinter-dotnet-tools/.store/tsqllint; \
      test ! -e /node-deps/node_modules/gherkin-lint; \
      test ! -e /node-deps/node_modules/protobufjs; \
    else \
      for tool in csharpier devskim roslynator tsqllint; do \
        test "$(command -v "${tool}")" = "/opt/megalinter-dotnet-tools/${tool}"; \
        "${tool}" --version >/dev/null; \
      done; \
      for tool in phpcs phpstan psalm phplint php-cs-fixer; do \
        test "$(command -v "${tool}")" = "/opt/megalinter-composer/vendor/bin/${tool}"; \
        "${tool}" --version >/dev/null; \
      done; \
      test "$(command -v cargo-clippy)" = "/opt/megalinter-rust-toolchain/bin/cargo-clippy"; \
      cargo-clippy --version >/dev/null; \
    fi; \
    test "$(stat -c '%u:%g:%a' /node-deps/package.json)" = "0:0:644"; \
    test "$(stat -c '%u:%g:%a' /node-deps/node_modules/@eslint/js/package.json)" = "0:0:644"; \
    test "$(node -e 'const { createRequire } = require("node:module"); const trustedRequire = createRequire("/node-deps/package.json"); process.stdout.write(trustedRequire.resolve("@eslint/js"));')" = "/node-deps/node_modules/@eslint/js/src/index.js"; \
    node --input-type=module -e 'await import("/opt/quality-sidecar/sidecar/config/eslint.config.mjs")'; \
    if [[ "${QUALITY_GATE_FLAVOR}" == "generic" ]]; then \
      test "$(command -v terrascan)" = "/usr/bin/terrascan"; \
      test "$(terrascan version)" = "version: v${TERRASCAN_INSTALL_VERSION}"; \
      tflint_smoke_dir="$(mktemp -d)"; \
      printf '%s\n' 'terraform {' '  required_version = ">= 1.5.0"' '}' > "${tflint_smoke_dir}/main.tf"; \
      tflint --config /opt/quality-sidecar/sidecar/config/tflint-ci.hcl --chdir "${tflint_smoke_dir}" --format compact; \
      rm "${tflint_smoke_dir}/main.tf"; \
      rmdir "${tflint_smoke_dir}"; \
    fi; \
    test -x /entrypoint.sh; \
    test -x /opt/quality-sidecar/entrypoint.sh; \
    test -x /usr/local/bin/quality-ci; \
    test "$(stat -c '%u:%g:%a' /usr/local/bin/gitleaks)" = "0:0:555"; \
    test ! -e /usr/bin/gitleaks; \
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
  && chown -R quality:quality /home/quality /workspace \
  && if [[ "${QUALITY_GATE_FLAVOR}" == "dotnetweb" ]]; then \
       su quality -s /bin/sh -c '/opt/megalinter-dotnet-tools/csharpier --version >/dev/null'; \
       su quality -s /bin/sh -c '/opt/megalinter-dotnet-tools/roslynator --version >/dev/null'; \
     else \
       for tool in csharpier devskim roslynator tsqllint; do \
         su quality -s /bin/sh -c "/opt/megalinter-dotnet-tools/${tool} --version >/dev/null"; \
       done; \
       for tool in phpcs phpstan psalm phplint php-cs-fixer; do \
         su quality -s /bin/sh -c "/opt/megalinter-composer/vendor/bin/${tool} --version >/dev/null"; \
       done; \
       su quality -s /bin/sh -c '/opt/megalinter-rust-toolchain/bin/cargo-clippy --version >/dev/null'; \
     fi \
  && su quality -s /bin/sh -c '\
       set -eu; \
       trusted_path="$(cat /etc/code-approval/quality-gate-path)"; \
       old_ifs=$IFS; IFS=:; \
       for path_dir in $trusted_path; do \
         test -x "$path_dir"; \
         for candidate in "$path_dir"/*; do \
           test -e "$candidate" || continue; \
           test -f "$candidate" || continue; \
           test -x "$candidate" || continue; \
           test ! -w "$candidate"; \
         done; \
       done; \
       IFS=$old_ifs'

ENV HOME=/home/quality \
    XDG_CACHE_HOME=/home/quality/.cache

WORKDIR /workspace
USER quality
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD /opt/venvs/quality-sidecar/bin/python -c "import quality_sidecar" || exit 1
ENTRYPOINT ["/opt/quality-sidecar/entrypoint.sh"]
CMD ["check", "/workspace"]
