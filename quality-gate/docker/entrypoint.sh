#!/bin/bash
set -euo pipefail

case "${1:-}" in
  quality-sidecar|quality-check)
    shift
    ;;
  quality-ci)
    shift
    exec /usr/local/bin/quality-ci "$@"
    ;;
esac

exec /opt/venvs/quality-sidecar/bin/python -m quality_sidecar "$@"
