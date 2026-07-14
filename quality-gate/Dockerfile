FROM ghcr.io/oxsecurity/megalinter-dotnetweb:v9.6.0@sha256:f7a17985de07b494e09952d5689f3cf978a270bb46ca5c4d5e1a05e262977a84

USER root

ARG TARGETARCH
ARG CHECKOV_INSTALL_VERSION=3.3.8
ARG JSCPD_INSTALL_VERSION=5.0.12
ARG SEMGREP_INSTALL_VERSION=1.169.0
ARG TRIVY_INSTALL_VERSION=0.72.0
ARG GITLEAKS_INSTALL_VERSION=8.30.1
ARG OSV_SCANNER_INSTALL_VERSION=2.4.0

LABEL org.opencontainers.image.source="https://github.com/rodrigojager/code-approval-gates" \
      org.opencontainers.image.description="Quality Gate determinístico para execução local e no GitLab CI" \
      org.opencontainers.image.licenses="MIT"

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
    tar \
    unzip

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN python3 -m pip install --break-system-packages --no-cache-dir \
    "semgrep==${SEMGREP_INSTALL_VERSION}" \
    "checkov==${CHECKOV_INSTALL_VERSION}"

RUN set -eux; \
  version="${GITLEAKS_INSTALL_VERSION#v}"; \
  case "${TARGETARCH:-amd64}" in \
    amd64) release_arch="x64" ;; \
    arm64) release_arch="arm64" ;; \
    *) echo "Unsupported architecture for gitleaks: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -sSfL \
    "https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_${release_arch}.tar.gz" \
    -o /tmp/gitleaks.tar.gz; \
  curl -sSfL \
    "https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_checksums.txt" \
    -o /tmp/gitleaks_checksums.txt; \
  grep "  gitleaks_${version}_linux_${release_arch}.tar.gz$" /tmp/gitleaks_checksums.txt \
    | sed "s#gitleaks_${version}_linux_${release_arch}.tar.gz#/tmp/gitleaks.tar.gz#" \
    | sha256sum -c -; \
  tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks; \
  chmod +x /usr/local/bin/gitleaks; \
  rm /tmp/gitleaks.tar.gz /tmp/gitleaks_checksums.txt

RUN set -eux; \
  version="${TRIVY_INSTALL_VERSION#v}"; \
  case "${TARGETARCH:-amd64}" in \
    amd64) release_arch="64bit" ;; \
    arm64) release_arch="ARM64" ;; \
    *) echo "Unsupported architecture for trivy: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  artifact="trivy_${version}_Linux-${release_arch}.tar.gz"; \
  curl -sSfL \
    "https://github.com/aquasecurity/trivy/releases/download/v${version}/${artifact}" \
    -o "/tmp/${artifact}"; \
  curl -sSfL \
    "https://github.com/aquasecurity/trivy/releases/download/v${version}/trivy_${version}_checksums.txt" \
    -o /tmp/trivy_checksums.txt; \
  grep "  ${artifact}$" /tmp/trivy_checksums.txt \
    | sed "s#${artifact}#/tmp/${artifact}#" \
    | sha256sum -c -; \
  tar -xzf "/tmp/${artifact}" -C /usr/local/bin trivy; \
  chmod +x /usr/local/bin/trivy; \
  rm "/tmp/${artifact}" /tmp/trivy_checksums.txt

RUN set -eux; \
  version="${OSV_SCANNER_INSTALL_VERSION#v}"; \
  case "${TARGETARCH:-amd64}" in \
    amd64) release_arch="amd64" ;; \
    arm64) release_arch="arm64" ;; \
    *) echo "Unsupported architecture for osv-scanner: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -sSfL \
    "https://github.com/google/osv-scanner/releases/download/v${version}/osv-scanner_linux_${release_arch}" \
    -o /usr/local/bin/osv-scanner; \
  curl -sSfL \
    "https://github.com/google/osv-scanner/releases/download/v${version}/osv-scanner_SHA256SUMS" \
    -o /tmp/osv-scanner_SHA256SUMS; \
  grep "  osv-scanner_linux_${release_arch}$" /tmp/osv-scanner_SHA256SUMS \
    | sed "s#osv-scanner_linux_${release_arch}#/usr/local/bin/osv-scanner#" \
    | sha256sum -c -; \
  chmod +x /usr/local/bin/osv-scanner; \
  rm /tmp/osv-scanner_SHA256SUMS

RUN npm install -g "jscpd@${JSCPD_INSTALL_VERSION}"

WORKDIR /opt/quality-sidecar
COPY pyproject.toml /opt/quality-sidecar/pyproject.toml
COPY sidecar /opt/quality-sidecar/sidecar
COPY docker/entrypoint.sh /opt/quality-sidecar/entrypoint.sh
RUN chmod +x /opt/quality-sidecar/entrypoint.sh \
  && python3 -m pip install --break-system-packages --no-cache-dir /opt/quality-sidecar

RUN addgroup -S -g 10001 quality \
  && adduser -S -D -u 10001 -h /home/quality -G quality quality \
  && mkdir -p /home/quality/.cache /workspace \
  && chown -R quality:quality /home/quality /opt/quality-sidecar /workspace

ENV HOME=/home/quality \
    XDG_CACHE_HOME=/home/quality/.cache

WORKDIR /workspace
USER quality
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python3 -c "import quality_sidecar" || exit 1
ENTRYPOINT ["/opt/quality-sidecar/entrypoint.sh"]
CMD ["check", "/workspace"]
