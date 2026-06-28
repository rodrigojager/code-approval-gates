#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "quality-sidecar" || "${1:-}" == "quality-check" ]]; then
  shift
fi

exec python3 -m quality_sidecar "$@"

