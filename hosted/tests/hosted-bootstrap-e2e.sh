#!/usr/bin/env bash
set -euo pipefail
tmp=$(mktemp -d)
trap "rm -rf $tmp; systemctl stop brownhill-bootstrap-test-pg 2>/dev/null || true" EXIT

# initdb a throwaway cluster on a non-default port
mkdir -p "$tmp/data"
chmod 0700 "$tmp/data"
/opt/brownhill/pgsql/bin/initdb -D "$tmp/data" --auth=trust --username=postgres >/dev/null
echo "port = 55433" >> "$tmp/data/postgresql.conf"
echo "data-checksums" >> "$tmp/data/postgresql.conf"
/opt/brownhill/pgsql/bin/pg_ctl -D "$tmp/data" -l "$tmp/pg.log" -o "-p 55433" start
sleep 1

# wait for a real query
for _ in 1 30; do
  if /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55433 -U postgres -d postgres -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 0.5
done

# apply shim + migrations
/opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55433 -U postgres -d postgres -v ON_ERROR_STOP=1 -f standalone/sql/0000_supabase_shim.sql
for f in supabase/migrations/*.sql; do
  /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55433 -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$f"
done

# assertions
assert_table() {
  /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55433 -U postgres -d postgres -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_schema='$1' AND table_name='$2'" \
    | grep -q '^1$' || { echo "FAIL: $1.$2 missing"; exit 1; }
}

assert_table auth users
assert_table public profiles
assert_table public vehicles
# Insert the bootstrap_pending row the bootstrap service is meant to write.
/opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55433 -U postgres -d postgres -c \
  "INSERT INTO app_state(key, value) VALUES ('bootstrap_pending','1') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value"

# Replay portable RLS proof — every existing assertion must still pass
for f in standalone/sql/portable-rls-proof.sql; do
  /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55433 -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$f"
done

# stop
/opt/brownhill/pgsql/bin/pg_ctl -D "$tmp/data" stop
echo OK
