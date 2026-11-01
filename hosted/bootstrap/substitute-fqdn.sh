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

# Phase 1 — the application's own environment.
#
# The deployment's address is not the nginx configuration's business, and the
# two used to be coupled by accident. This script exited as soon as it found
# the placeholder already replaced, so on a box where the placeholder was
# gone — a second run, or a box whose configuration had been installed from
# somewhere else — the application's address was never written, and every
# link the application sent still pointed at the placeholder. The exit was
# silent and the script's name says nothing about the environment, so
# nothing looked wrong.
#
# The application reads its address at run time, so this is where it is set.
hosted/bootstrap/write-app-env.sh /etc/brownhill/secrets "$fqdn"

# Phase 2 — substitute the placeholder throughout the nginx config.
nginx_config=hosted/nginx/brownhill.conf
if [[ ! -f "$nginx_config" ]]; then
  echo "no nginx config at $nginx_config; the application's environment was still written"
  exit 0
fi

# Idempotency guard: if the placeholder is already absent, skip silently.
if ! grep -q 'brownhill.example.co.uk' "$nginx_config"; then
  echo "placeholder already replaced in $nginx_config; the application's environment was still written"
  exit 0
fi

sed -i.bak -e "s/brownhill\.example\.co\.uk/$fqdn/g" "$nginx_config"

# nginx config check (best-effort; non-fatal if nginx isn't on PATH).
#
# The check is skipped when certbot has not run yet: the configuration
# includes /etc/letsencrypt/options-ssl-nginx.conf, which only exists once a
# certificate has been issued, so `nginx -t` would fail on a missing include
# rather than on anything this substitution did.
if command -v nginx >/dev/null 2>&1 && [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]]; then
  nginx -t -c "$(pwd)/$nginx_config" || {
    echo "nginx -t failed after substitution; reverting $nginx_config" >&2
    mv -f "$nginx_config.bak" "$nginx_config"
    exit 3
  }
fi

rm -f "$nginx_config.bak"

echo "substituted placeholder → $fqdn in $nginx_config"
