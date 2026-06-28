ARG MEGALINTER_IMAGE=ghcr.io/oxsecurity/megalinter:v9
FROM ${MEGALINTER_IMAGE}

USER root

ARG TARGETARCH
ARG TRIVY_INSTALL_VERSION=latest
ARG GITLEAKS_INSTALL_VERSION=8.30.1
ARG OSV_SCANNER_INSTALL_VERSION=2.4.0

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

RUN python3 -m pip install --break-system-packages --no-cache-dir semgrep checkov

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
  tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks; \
  chmod +x /usr/local/bin/gitleaks; \
  rm /tmp/gitleaks.tar.gz

RUN if [[ "${TRIVY_INSTALL_VERSION}" == "latest" ]]; then \
    curl -sSfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
      | sh -s -- -b /usr/local/bin; \
  else \
    curl -sSfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
      | sh -s -- -b /usr/local/bin "${TRIVY_INSTALL_VERSION}"; \
  fi

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
  chmod +x /usr/local/bin/osv-scanner

RUN npm install -g jscpd

WORKDIR /opt/quality-sidecar
COPY pyproject.toml /opt/quality-sidecar/pyproject.toml
COPY sidecar /opt/quality-sidecar/sidecar
COPY docker/entrypoint.sh /opt/quality-sidecar/entrypoint.sh
RUN chmod +x /opt/quality-sidecar/entrypoint.sh \
  && python3 -m pip install --break-system-packages --no-cache-dir /opt/quality-sidecar

WORKDIR /workspace
ENTRYPOINT ["/opt/quality-sidecar/entrypoint.sh"]
CMD ["check", "/workspace"]
