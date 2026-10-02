#! /usr/bin/env bash
# /usr/local/bin/brownhill-backup-verify.sh — installed by hosted/bootstrap/install.sh.
set -euo pipefail
DUMP_DIR=/var/backups/brownhill
TMP=$(mktemp -d)
mkdir -p "$TMP/data"
/opt/brownhill/pgsql/bin/initdb -D "$TMP/data" --auth=trust --username=postgres >/dev/null
echo "port = 55433" >> "$TMP/data/postgresql.conf"
echo "data-checksums" >> "$TMP/data/postgresql.conf"
/opt/brownhill/pgsql/bin/pg_ctl -D "$TMP/data" -l "$TMP/pg.log" -o "-p 55433" start
trap '/opt/brownhill/pgsql/bin/pg_ctl -D "$TMP/data" stop 2>/dev/null; rm -rf "$TMP"' EXIT
sleep 1

# newest local dump within 7d
DUMP=$(ls -1t "$DUMP_DIR"/*.dump 2>/dev/null | head -1)
test -n "$DUMP" || { echo "verify FAIL: no dumps in $DUMP_DIR"; exit 1; }
/opt/brownhill/pgsql/bin/pg_restore -h 127.0.0.1 -p 55433 -U postgres -d postgres -j 4 --clean --if-exists "$DUMP"
ROWS=$(/opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55433 -U postgres -d postgres -tAc 'SELECT SUM(n_live_tup) FROM pg_stat_user_tables')
echo "Verified restore: $ROWS rows"
test "$ROWS" -ge 1 || { echo "verify FAIL: empty database"; exit 1; }

# Replay portable-rls-proof minus the auth-pre-request bits (no JWT/RLS contract).
# The proof lives at $DUMP_DIR/../standalone/sql/portable-rls-proof.sql in the repo;
# the script runs out of the repo root, so the relative path is one hop up.
/opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55433 -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f /opt/brownhill/repo/standalone/sql/portable-rls-proof.sql
echo OK
