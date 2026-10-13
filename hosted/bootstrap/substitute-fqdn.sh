#!/usr/bin/env bash
# hosted/bootstrap/substitute-fqdn.sh — replace the `brownhill.example.co.uk`
# placeholder throughout the nginx config with the operator's real FQDN.
# Idempotent: running a second time with the same FQDN is a no-op.
#
# Usage: substitute-fqdn.sh <fqdn>
#   example: sudo ./hosted/bootstrap/substitute-fqdn.sh brownhill.example.co.uk
#
# Does not reload nginx — the caller (initial-cert.sh, install.sh) does that.

set -euo pipefail
fqdn="${1:?fqdn required, e.g. brownhill.example.co.uk}"

# sanity: FQDN-shaped input (one or more dot-separated labels, lowercase letters/digits/hyphens/dots)
if ! [[ "$fqdn" =~ ^[a-z0-9]([a-z0-9.-]{0,253}[a-z0-9])?$ ]] || [[ "$fqdn" != *.** ]]; then
  echo "not an FQDN: $fqdn"; exit 2
fi

cd "$(dirname "$0")/../.."

# Phase 1 — substitute the placeholder throughout the nginx config.
nginx_config=hosted/nginx/brownhill.conf
if [[ ! -f "$nginx_config" ]]; then
  echo "no nginx config at $nginx_config; nothing to do"; exit 0
fi

# Idempotency guard: if the placeholder is already absent, skip silently.
if ! grep -q 'brownhill.example.co.uk' "$nginx_config"; then
  echo "placeholder already replaced in $nginx_config; nothing to do"
  exit 0
fi

sed -i.bak -e "s/brownhill\.example\.co\.uk/$fqdn/g" "$nginx_config"
rm -f "$nginx_config.bak"

# nginx config check (best-effort; non-fatal if nginx isn't on PATH)
if command -v nginx >/dev/null 2>&1; then
  nginx -t -c "$(pwd)/$nginx_config" || {
    echo "nginx -t failed after substitution; reverting $nginx_config"
    git checkout -- "$nginx_config" 2>/dev/null || true
    exit 3
  }
fi

echo "substituted placeholder → $fqdn in $nginx_config"
