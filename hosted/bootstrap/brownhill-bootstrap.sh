#! /usr/bin/env bash
# /usr/local/bin/brownhill-bootstrap.sh — installed by Task 2's install.sh.
#
# Applies the Supabase shim and every migration to the local Postgres.
#
# Two properties this script now guarantees, both of which it previously
# lacked:
#
#   1. Each migration file is applied in its OWN transaction. Previously each
#      file ran as a bare sequence of statements, so a file that failed
#      half-way left its earlier statements COMMITTED. That is how 0069 came
#      to drop `periods_year_month_key` and `vat_submissions_period_id_key`
#      and then die on a syntax error, leaving the schema permanently broken
#      in a way no re-run could repair.
#
#   2. Applied files are recorded in a `schema_migrations` ledger, so a re-run
#      skips what is already applied. The old script re-applied every file on
#      every boot and failed on the first `create type`. The ledger also lets
#      the operator see, from one query, exactly which migrations a box has.
#
# The ledger records the migration's SHA-256. If a migration file is edited
# after it has been applied, the checksum no longer matches and the run
# aborts rather than silently diverging the box from the repository.
set -euo pipefail

# Connection settings. The defaults are the box's; the environment overrides
# exist so the acceptance gate can run THIS EXACT script against a throwaway
# container, rather than a parallel reimplementation of it that could drift.
export PGHOST="${BROWNHILL_PGHOST:-127.0.0.1}"
export PGPORT="${BROWNHILL_PGPORT:-55432}"
export PGUSER="${BROWNHILL_PGUSER:-postgres}"
pg_env_file="${BROWNHILL_PG_ENV_FILE:-/etc/brownhill/secrets/pg.env}"
export PGPASSWORD=$(grep '^PG_SUPERUSER_PASSWORD=' "$pg_env_file" | cut -d= -f2)

# Where the repository lives on the box. The previous calculation —
#   repo="$(dirname "$(realpath "$0")")/../../.."
# — resolved to "/" when this script is installed at /usr/local/bin, because
# /usr/local/bin/../../.. is the filesystem root. It only "worked" on a
# developer's laptop, where the script sits inside the repo. The deploy
# runbook records the same failure ("repo path calc is wrong (was resolving
# to /)"), patched by hand on the box and never brought back here.
#
# /opt/brownhill/repo is the canonical location (the same path the handoff,
# the runbook and brownhill-backup-verify.sh all use). Override it with
# BROWNHILL_REPO_DIR for a different layout.
repo="${BROWNHILL_REPO_DIR:-/opt/brownhill/repo}"
if [ ! -d "$repo/supabase/migrations" ]; then
  echo "ERROR: no migrations directory at $repo/supabase/migrations" >&2
  echo "       Set BROWNHILL_REPO_DIR to the repository root and re-run." >&2
  exit 1
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

# The ledger lives in `public` alongside app_state. It holds migration
# filenames and checksums — no customer data — and is not exposed to the
# application roles.
psql -v ON_ERROR_STOP=1 <<'SQL'
create table if not exists schema_migrations (
  filename    text primary key,
  checksum    text        not null,
  applied_at  timestamptz not null default now()
);
SQL

# Apply the shim first (idempotent — IF NOT EXISTS guards). It creates the
# auth/storage schemas and the roles the migrations grant to.
psql -v ON_ERROR_STOP=1 -f "$shim"

# An existing box already has the schema but no ledger: it was provisioned by
# the previous script, which recorded nothing. Without this branch the loop
# below would re-apply every migration and die on the first `create type`
# (0001 has no IF NOT EXISTS guard), because the ledger is empty even though
# the tables exist.
#
# A box is "legacy" when the ledger is empty but the schema is not:
# `public.tenants` is created by 0016 and exists on every provisioned box,
# and does not exist on a database where nothing has been applied yet.
#
# Which migrations a legacy box actually applied is NOT guessable — the live
# box skipped 0064-0071 by patching the old script, so "the schema is
# present" does not imply "every file ran". The operator states it:
#
#   BROWNHILL_ADOPTED_MIGRATIONS="0001_extensions.sql 0002_platform.sql ..."
#
# names the files already applied; those are recorded in the ledger without
# being re-run, and every other file is applied normally. With the variable
# unset the script refuses to touch a legacy database rather than corrupt it.
ledger_count=$(psql -tAc "select count(*) from schema_migrations" | tr -d ' ')
schema_present=$(psql -tAc "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'tenants'" | tr -d ' ')
legacy=0
if [ "${ledger_count:-0}" -eq 0 ] && [ "${schema_present:-0}" -gt 0 ]; then
  legacy=1
fi

for f in $(ls -1 "$migs"/*.sql | sort); do
  bn=$(basename "$f")
  sum=$(sha256sum "$f" | cut -d' ' -f1)

  applied_sum=$(psql -tAc "select checksum from schema_migrations where filename = '$bn'" | tr -d ' ')
  if [ -n "$applied_sum" ]; then
    if [ "$applied_sum" != "$sum" ]; then
      echo "ERROR: $bn was already applied with a different checksum." >&2
      echo "       A shipped migration was edited after it ran on this box." >&2
      echo "       Refusing to continue: the box and the repository now disagree." >&2
      exit 1
    fi
    continue   # already applied, checksum matches
  fi

  if [ "$legacy" -eq 1 ]; then
    # Is this one of the files the operator says already ran?
    skip_this=0
    for adopted in ${BROWNHILL_ADOPTED_MIGRATIONS:-}; do
      if [ "$adopted" = "$bn" ]; then skip_this=1; break; fi
    done
    if [ "$skip_this" -eq 1 ]; then
      echo "  recording $bn as already applied (legacy box)"
      psql -v ON_ERROR_STOP=1 -c \
        "insert into schema_migrations (filename, checksum) values ('$bn', '$sum')" >/dev/null
      continue
    fi
    if [ -z "${BROWNHILL_ADOPTED_MIGRATIONS:-}" ]; then
      echo "ERROR: this database already has a schema but no migration ledger." >&2
      echo "       Re-applying migrations from scratch would fail on the objects" >&2
      echo "       they already created, so the script will not do it." >&2
      echo >&2
      echo "       Re-run with the list of migrations this box already has, e.g.:" >&2
      echo >&2
      echo "         BROWNHILL_ADOPTED_MIGRATIONS=\"$(ls -1 "$migs"/*.sql | xargs -n1 basename | head -3 | tr '\n' ' ')...\"" >&2
      echo "         systemctl restart brownhill-bootstrap" >&2
      echo >&2
      echo "       Any file NOT in that list is applied normally, so a box that" >&2
      echo "       skipped a migration picks it up on this run." >&2
      exit 1
    fi
  fi

  echo "applying $bn"
  # One psql invocation applies the file AND records it, inside one
  # transaction. --single-transaction means the whole file commits or none of
  # it does; ON_ERROR_STOP aborts at the first error rather than carrying on.
  #
  # Recording in the same transaction is deliberate: if the ledger insert were
  # a separate statement, a crash between the two would leave the schema
  # migrated but the ledger not updated, and the next run would try to apply
  # the file again and fail on the objects it already created. Folding the
  # insert into the same transaction makes that state unreachable.
  psql -v ON_ERROR_STOP=1 --single-transaction \
    -f "$f" \
    -c "insert into schema_migrations (filename, checksum) values ('$bn', '$sum')"
done

# Mark the system bootstrap-pending so the first-run endpoint can serve.
psql -v ON_ERROR_STOP=1 -c "
  CREATE TABLE IF NOT EXISTS app_state (key text PRIMARY KEY, value text NOT NULL);
  INSERT INTO app_state(key, value) VALUES ('bootstrap_pending','1')
    ON CONFLICT (key) DO UPDATE SET value='1';
"
