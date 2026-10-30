#!/usr/bin/env bash
set -euo pipefail
# Standalone-only config-syntax probe. The shared restart-policy.sh test
# covers the systemd units; this one covers the nginx config.
if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx not installed; skipping hosted/tests/nginx/test-config-syntax.sh"
  exit 0
fi
nginx -t -c /dev/stdin <<EOF
$(cat hosted/nginx/brownhill.conf)
EOF
