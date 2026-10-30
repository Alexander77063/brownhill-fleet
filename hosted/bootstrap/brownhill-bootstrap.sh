#! /usr/bin/env bash
# hosted/bootstrap/brownhill-bootstrap.sh — installed by Task 2's install.sh.
#
# Applies the compatibility shim and every application migration, in order,
# to the PostgreSQL instance this deployment owns, and marks the system
# bootstrap-pending so the first-run endpoint serves.
#
# Idempotent: re-running against an already-provisioned database is a no-op,
# which is what makes it safe as a systemd oneshot that runs on every boot.
set -euo pipefail

# ── how to reach the database ────────────────────────────────────────────────
# Production values are the defaults; the environment overrides them so the
# same script serves the production host, the compose stack and a developer's
# machine.
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-55432}"
export PGUSER="${PGUSER:-postgres}"
export PGDATABASE="${PGDATABASE:-postgres}"

# The production password lives in a secrets file the installer writes. If the
# environment already carries one — trust auth in the compose stack, or a
# developer's own — that wins and the file is not consulted.
if [ -z "${PGPASSWORD:-}" ] && [ -f /etc/brownhill/secrets/pg.env ]; then
  export PGPASSWORD="$(grep '^PG_SUPERUSER_PASSWORD=' /etc/brownhill/secrets/pg.env | cut -d= -f2)"
fi

# ── where the code is ────────────────────────────────────────────────────────
# This used to be `dirname "$(realpath "$0")")/../../..`, which is right only
# while the script sits three directories below the repository root. The
# installer copies it to /usr/local/bin, where that expression resolves to `/`
# — so the script looked for /standalone/sql/0000_supabase_shim.sql and
# /supabase/migrations, neither of which exists, and the schema was never
# applied on a fresh install. The script's own location says nothing about
# where the code is, so look for the repository instead: the one directory
# that has supabase/migrations under it is the one.
#
# BROWNILL_REPO overrides the search. The compose stack mounts the repository
# at /opt/brownhill and sets it.
repo=""
for candidate in "${BROWNILL_REPO:-}" "$(dirname "$(realpath "$0")")/../.." "$(dirname "$(realpath "$0")")/../../.." /opt/brownhill/repo; do
  if [ -n "$candidate" ] && [ -d "$candidate/supabase/migrations" ]; then
    repo="$(cd "$candidate" && pwd)"
    break
  fi
done
if [ -z "$repo" ]; then
  echo "brownhill-bootstrap: could not find the repository root (looked for supabase/migrations)." >&2
  echo "  Set BROWNILL_REPO to the directory that holds it." >&2
  exit 66
fi

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
# are content-versioned by filename and are written to be re-runnable.
psql -v ON_ERROR_STOP=1 -f "$shim"
for f in $(ls -1 "$migs"/*.sql | sort); do
  psql -v ON_ERROR_STOP=1 -f "$f"
done

# Mark the system bootstrap-pending so the first-run endpoint can serve.
#
# Migration 0080 creates this table, so on a database provisioned through the
# migration history it already exists. The statement is kept because this
# script is also the path for a database that was provisioned some other way,
# and `if not exists` makes it harmless there.
psql -v ON_ERROR_STOP=1 -c "
  CREATE TABLE IF NOT EXISTS app_state (key text PRIMARY KEY, value text NOT NULL);
  INSERT INTO app_state(key, value) VALUES ('bootstrap_pending','1')
    ON CONFLICT (key) DO UPDATE SET value='1';
"
