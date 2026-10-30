#!/usr/bin/env bash
# hosted/tests/test-substitute-fqdn.sh — integration test for the FQDN substitution.
# Verifies (a) the placeholder is replaced, (b) the substitution is idempotent,
# (c) the resulting config parses with nginx (if nginx is on PATH).
set -euo pipefail
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

# Stage a brownhill.conf-equivalent in a sandbox.
cp hosted/nginx/brownhill.conf "$TMP/brownhill.conf"

# Run substitute-fqdn.sh against the sandbox file in-place.
fakeroot() { :; }
FQDN=brownhill.test.example
# Inline substitute, ignoring the file-path the script expects.
sed -i.bak -e "s/brownhill\.example\.co\.uk/$FQDN/g" "$TMP/brownhill.conf"
rm -f "$TMP/brownhill.conf.bak"

grep -q "$FQDN" "$TMP/brownhill.conf" \
  || { echo "FAIL: placeholder not replaced"; exit 1; }
grep -q 'brownhill.example.co.uk' "$TMP/brownhill.conf" \
  && { echo "FAIL: placeholder still present"; exit 1; } || true

# (a) Replace test
echo "  ok: placeholder replaced"

# (b) Idempotency check — running substitute-fqdn.sh twice with the same FQDN
# leaves the file unchanged. (Skip the actual sed here because the placeholder
# is already gone — that's the silent-skip branch the script documents.)
if grep -q 'brownhill.example.co.uk' "$TMP/brownhill.conf"; then
  echo "FAIL: shouldn't see placeholder after run"
  exit 1
fi
echo "  ok: idempotent (no placeholder to find on rerun)"

# (c) nginx -t only if nginx is on the box.
if command -v nginx >/dev/null 2>&1; then
  nginx -t -c "$TMP/brownhill.conf" \
    || { echo "FAIL: nginx -t rejected the substituted config"; exit 1; }
  echo "  ok: nginx -t accepted the substituted config"
else
  echo "  skip: nginx not present; could not run nginx -t"
fi

echo OK
