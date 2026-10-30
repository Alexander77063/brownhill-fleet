#! /usr/bin/env bash
# /usr/local/bin/brownhill-bootstrap.sh — installed by Task 2's install.sh.
set -euo pipefail
export PGHOST=127.0.0.1 PGPORT=55432
export PGUSER=postgres PGPASSWORD=$(grep '^PG_SUPERUSER_PASSWORD=' /etc/brownhill/secrets/pg.env | cut -d= -f2)

repo="$(dirname "$(realpath "$0")")/../../.."
shim="$repo/standalone/sql/0000_supabase_shim.sql"
migs="$repo/supabase/migrations"

# Wait for a real query — pg_isready answers yes while the server is still
# warming; the same rule the standalone README states.
for _ in $(seq 1 60); do
  if psql -tAc 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
psql -tAc 'SELECT 1' >/dev/null   # final assert

# Apply the shim first (idempotent — IF NOT EXISTS guards). Migrations
# are content-versioned by filename and the per-row ledger skips applied ones.
psql -v ON_ERROR_STOP=1 -f "$shim"
for f in $(ls -1 "$migs"/*.sql | sort); do
  psql -v ON_ERROR_STOP=1 -f "$f"
done

# Mark the system bootstrap-pending so the first-run endpoint can serve.
psql -v ON_ERROR_STOP=1 -c "
  CREATE TABLE IF NOT EXISTS app_state (key text PRIMARY KEY, value text NOT NULL);
  INSERT INTO app_state(key, value) VALUES ('bootstrap_pending','1')
    ON CONFLICT (key) DO UPDATE SET value='1';
"
