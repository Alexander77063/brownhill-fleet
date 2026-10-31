#!/usr/bin/env bash
# hosted/bootstrap/brownhill-bootstrap.sh — installed by Task 2's install.sh.
#
# Applies the compatibility shim and every application migration, in order,
# to the PostgreSQL instance this deployment owns, and marks the system
# bootstrap-pending so the first-run endpoint serves.
#
# Idempotent: re-running against an already-provisioned database is a no-op,
# which is what makes it safe as a systemd oneshot that runs on every boot.
#
# That claim was false until 2026-10-31. The script applied every migration
# from the top on every run, and migration 0001 creates twenty-three enum
# types with no guard, so the second run died on its first statement:
#
#   ERROR:  type "user_role" already exists
#
# and the oneshot exited 3. What is applied is now recorded in the migration
# ledger (public.schema_migrations), so a second run applies nothing.
#
# Options (the systemd unit passes none; use a drop-in to set the environment):
#   --baseline-through=FILE   adopt a database that was provisioned before the
#                             ledger existed. Checked against the database, and
#                             refused if the claim is not true.
#   --skip=FILE[,FILE...]     do not apply these migrations.
#   BROWNHILL_BASELINE_THROUGH / BROWNHILL_SKIP_MIGRATIONS do the same thing
#   through the environment, which is how a systemd drop-in sets them.
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
# BROWNHILL_REPO overrides the search. The compose stack mounts the repository
# at /opt/brownhill and sets it.
#
# The spelling of that variable was corrected across the whole repository when
# this work started: the product's name is Brownhill, so the prefix is
# BROWNHILL_. Before the correction the script, the compose stack and the
# documentation all carried the one-letter-short spelling, so they agreed with
# each other and nothing was broken by that alone — but the two spellings are
# impossible to tell apart at a glance, and a file corrected to one spelling
# while its neighbours keep the other is a setting that silently stops being
# honoured: the override is ignored and the script falls back to a path that
# happens to work on the developer's machine and not on the box.
#
# There is now one spelling, and hosted/tests/env-var-names.sh fails the build
# if a second one appears.
repo=""
for candidate in "${BROWNHILL_REPO:-}" "$(dirname "$(realpath "$0")")/../.." "$(dirname "$(realpath "$0")")/../../.." /opt/brownhill/repo; do
  if [ -n "$candidate" ] && [ -d "$candidate/supabase/migrations" ]; then
    repo="$(cd "$candidate" && pwd)"
    break
  fi
done
if [ -z "$repo" ]; then
  echo "brownhill-bootstrap: could not find the repository root (looked for supabase/migrations)." >&2
  echo "  Set BROWNHILL_REPO to the directory that holds it." >&2
  exit 66
fi

shim="$repo/standalone/sql/0000_supabase_shim.sql"
migs="$repo/supabase/migrations"

# ── where the ledger lives ───────────────────────────────────────────────────
# The ledger is the record of what has been applied, and it is what makes this
# script idempotent. It is looked for in three places, in order:
#
#   1. BROWNHILL_LEDGER_LIB, if the operator set it.
#   2. /usr/local/lib/brownhill/schema-ledger.sh — where install.sh puts it.
#      The installed copy is preferred over the one in the repository because
#      the script that runs at boot must not depend on a git checkout that may
#      be half-updated.
#   3. The repository's own copy.
ledger_lib=""
for candidate in "${BROWNHILL_LEDGER_LIB:-}" /usr/local/lib/brownhill/schema-ledger.sh "$repo/standalone/scripts/schema-ledger.sh"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    ledger_lib="$candidate"
    break
  fi
done
if [ -z "$ledger_lib" ]; then
  echo "brownhill-bootstrap: could not find schema-ledger.sh." >&2
  echo "  Looked in \$BROWNHILL_LEDGER_LIB, /usr/local/lib/brownhill/ and $repo/standalone/scripts/." >&2
  echo "  The ledger is what makes this script safe to run on every boot." >&2
  exit 66
fi

# shellcheck source=../../standalone/scripts/schema-ledger.sh
source "$ledger_lib"

# ── wait for the database ────────────────────────────────────────────────────
# Wait for a real query — pg_isready answers yes while the server is still
# warming; the same rule the standalone README states.
for _ in $(seq 1 60); do
  if psql -tAc 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
psql -tAc 'SELECT 1' >/dev/null   # final assert

# ── apply ────────────────────────────────────────────────────────────────────
LEDGER_PSQL=(psql)
ledger_parse_args "$@"
ledger_apply_all "$shim" "$migs"

# A status report is a REPORT. It must not write to the application schema.
#
# The block below makes sure `app_state.bootstrap_pending` is '1', which is
# the first-run door: the first-run endpoint flips it to '0' when the operator
# completes setup, and after that it must stay closed. The statement is
# `ON CONFLICT DO NOTHING`, so on a database that has the row it changes
# nothing — but on a database that does NOT have the row yet, running the
# status report would create the table and insert '1', handing the first-run
# setup back to anyone holding BOOTSTRAP_TOKEN.
#
# That matters most exactly when the report is run: on a box being adopted
# into the ledger, before its setup is finished. A report that opens a door
# is not a report.
if [ "${LEDGER_STATUS:-0}" = "1" ]; then
  echo "==> status only: the application schema was not touched"
  exit 0
fi

# Mark the system bootstrap-pending so the first-run endpoint can serve.
#
# Migration 0080 creates this table and inserts this row, so on a database
# provisioned through the migration history it already exists. The statement is
# kept because this script is also the path for a database that was provisioned
# some other way, and `if not exists` makes it harmless there.
#
# It is `DO NOTHING`, not `DO UPDATE`, and that is the whole point of the
# line. The flag is a one-way door: the first-run endpoint flips
# bootstrap_pending to '0' when the operator completes setup, and after that
# the endpoint must stay closed. Re-opening it on every boot would hand the
# first-run setup back to anyone holding BOOTSTRAP_TOKEN.
#
# The old `DO UPDATE SET value='1'` never showed the bug because the script
# never got this far twice — it died on migration 0001 first. Now that the
# script completes on a re-run, the line is reached on every boot, and it has
# to be right.
psql -v ON_ERROR_STOP=1 -c "
  CREATE TABLE IF NOT EXISTS app_state (key text PRIMARY KEY, value text NOT NULL);
  INSERT INTO app_state(key, value) VALUES ('bootstrap_pending','1')
    ON CONFLICT (key) DO NOTHING;
"
