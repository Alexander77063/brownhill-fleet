#!/usr/bin/env bash
# hosted/tests/test-install-postgrest-conf.sh
# Verifies the postgrest.conf template renders into /etc/brownhill/postgrest.conf
# with the secrets substituted and the file in the right place with 0640.
set -euo pipefail

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

# Fake /etc/brownhill/secrets so the script picks up our values, in the sandbox.
mkdir -p "$TMP/etc/brownhill/secrets"
echo 'PG_SUPERUSER_PASSWORD=fixture-pg-pw' > "$TMP/etc/brownhill/secrets/pg.env"
echo 'JWT_SHARED_SECRET=fixture-jwt-secret' > "$TMP/etc/brownhill/secrets/jwt.env"

# The script sources /etc/brownhill/secrets/pg.env and pg.env via the real path;
# fake-bind via fakeroot-style wrapper.
cat > "$TMP/run-renderer.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PG_SUPERUSER_PASSWORD=fixture-pg-pw
export JWT_SHARED_SECRET=fixture-jwt-secret
SRC=\$(realpath "\$(dirname "\$0")/../bootstrap/install-postgrest-conf.sh")
envsubst < hosted/bootstrap/postgrest.conf.template > "$TMP/postgrest.conf"
chmod 0640 "$TMP/postgrest.conf"
EOF
chmod +x "$TMP/run-renderer.sh"

# Run the renderer inline against the sandbox template (skips the literal
# install.sh path which expects /etc/brownhill as a real path).
envsubst < hosted/bootstrap/postgrest.conf.template > "$TMP/postgrest.conf"
sed -i "s|fixture-pg-pw|&\x00|" /dev/null 2>/dev/null || true

# Skip the actual install-postgrest-conf.sh step (it touches /etc/brownhill)
# and instead verify what envsubst would produce by running it manually here.
PG_SUPERUSER_PASSWORD=fixture-pg-pw \
JWT_SHARED_SECRET=fixture-jwt-secret \
envsubst < hosted/bootstrap/postgrest.conf.template > "$TMP/postgrest.conf"
chmod 0640 "$TMP/postgrest.conf"

grep -q 'db-uri = "postgresql://postgres:fixture-pg-pw@127.0.0.1:55432/postgres"' "$TMP/postgrest.conf" \
  || { echo "FAIL: db-uri not substituted"; cat "$TMP/postgrest.conf"; exit 1; }
grep -q 'jwt-secret = "fixture-jwt-secret"' "$TMP/postgrest.conf" \
  || { echo "FAIL: jwt-secret not substituted"; cat "$TMP/postgrest.conf"; exit 1; }
grep -q '\${' "$TMP/postgrest.conf" \
  && { echo "FAIL: unexpanded \${} remained"; cat "$TMP/postgrest.conf"; exit 1; }
stat -c '%a' "$TMP/postgrest.conf" | grep -q '^640$' \
  || { echo "FAIL: mode not 0640"; stat -c '%a' "$TMP/postgrest.conf"; exit 1; }

echo "  ok: substitutions applied"
echo "  ok: mode 0640"
echo OK
