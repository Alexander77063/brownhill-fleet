#!/usr/bin/env bash
# hosted/tests/schema-ledger-check.sh — Gate 1, as it runs on a deployed box.
#
# Needs only psql, because the box does not have Docker: the hosted stack is
# a native Postgres under systemd, and the handoff says outright that the
# box does not need Docker. So this gate answers the question the box CAN
# answer — does the database this instance is running against match the
# migrations in this repository?
#
# The from-zero build and the RLS portability proof live in schema-gate.sh,
# which needs Docker and therefore runs in CI and on a developer machine.
# Between them, no gate can be silently green.
#
# It fails when:
#   - there is no schema_migrations ledger, i.e. the box predates the ledger
#     and the operator has not completed the adoption step
#   - a migration file in the repository is not recorded as applied
#   - a recorded checksum does not match the file's current checksum, i.e.
#     the migration was edited after it ran and the box now disagrees with
#     the repository
#   - the accounting objects the migrations create are missing
#   - the journal-balance trigger is missing, or is not deferred until COMMIT
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repo="${BROWNHILL_REPO_DIR:-$REPO_ROOT}"
migs="$repo/supabase/migrations"

# Connection settings — the same names and defaults the bootstrap script uses,
# so both read the same secret file and talk to the same database.
export PGHOST="${BROWNHILL_PGHOST:-127.0.0.1}"
export PGPORT="${BROWNHILL_PGPORT:-55432}"
export PGUSER="${BROWNHILL_PGUSER:-postgres}"
pg_env_file="${BROWNHILL_PG_ENV_FILE:-/etc/brownhill/secrets/pg.env}"
if [ -r "$pg_env_file" ]; then
  export PGPASSWORD=$(grep '^PG_SUPERUSER_PASSWORD=' "$pg_env_file" | cut -d= -f2)
fi

# The box installs Postgres under /opt/brownhill/pgsql; the bootstrap unit
# runs as the postgres user and finds psql on PATH. Fall back to the known
# install path so the gate works from a root shell that has never sourced
# the postgres profile.
if command -v psql >/dev/null 2>&1; then
  PSQL=psql
elif [ -x /opt/brownhill/pgsql/bin/psql ]; then
  PSQL=/opt/brownhill/pgsql/bin/psql
else
  echo "FAIL: no psql client found (looked on PATH and at /opt/brownhill/pgsql/bin/psql)" >&2
  exit 1
fi

q() { "$PSQL" -tAc "$1" 2>/dev/null | tr -d ' '; }

TAB=$(printf '\t')

# The whole ledger in ONE query: each applied migration's file name and
# checksum, tab-separated. The file names are then compared in the shell, so
# they never enter the SQL text — a repository file whose name contains a
# quote cannot break the query, and there is nothing to escape.
#
# One query rather than one per file also matters operationally: this check
# runs over every migration on the box, and a query per file means a psql
# process per file.
q_ledger() {
  "$PSQL" -tA -F "$TAB" -c \
    "select filename || chr(9) || checksum from schema_migrations order by filename" 2>/dev/null
}

# The checksum the ledger records for one file name, or nothing if the file
# is not recorded at all. The name is compared for exact equality, never as a
# substring, so one file can never be matched by another file's name.
ledger_checksum() {
  local want="$1" name sum
  while IFS="$TAB" read -r name sum; do
    if [ "$name" = "$want" ]; then
      printf '%s' "$sum"
      return 0
    fi
  done <<< "$ledger"
  return 1
}

fail=0
assert_eq() {
  local what="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ok: $what = $actual"
  else
    echo "  FAIL: $what — expected $expected, got ${actual:-<none>}"
    fail=1
  fi
}

echo "== schema ledger check =="

if [ ! -d "$migs" ]; then
  echo "FAIL: no migrations directory at $migs" >&2
  echo "      Set BROWNHILL_REPO_DIR to the repository root." >&2
  exit 1
fi

if ! q 'select 1' | grep -q '^1$'; then
  echo "FAIL: cannot connect to Postgres at $PGHOST:$PGPORT as $PGUSER" >&2
  exit 1
fi

# Is there a ledger at all?
ledger_exists=$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'schema_migrations'")
if [ "$ledger_exists" != "1" ]; then
  echo "FAIL: this database has no schema_migrations ledger." >&2
  echo "      It was provisioned before the ledger existed. Adopt the migrations" >&2
  echo "      it already has — see the handoff's Step E — before running this gate." >&2
  exit 1
fi

# Every file in the repository must be applied, with the checksum the file
# has NOW. A mismatch means the migration was edited after it ran on this
# box, so the box and the repository disagree about the schema.
total=0
missing=0
mismatched=0
ledger="$(q_ledger)"
for f in $(ls -1 "$migs"/*.sql | sort); do
  bn=$(basename "$f")
  # A file name is stored in the ledger as a plain string. Refuse names that
  # cannot round-trip: a tab or a newline in a name would make the ledger's
  # tab-separated form ambiguous, and the comparison below could then match
  # the wrong file.
  case "$bn" in
    *[[:cntrl:]]*)
      echo "FAIL: migration file name contains a control character: $bn" >&2
      echo "      A tab or newline in a file name makes the ledger ambiguous." >&2
      exit 1
      ;;
  esac
  sum=$(sha256sum "$f" | cut -d' ' -f1)
  total=$((total + 1))
  applied_sum=$(ledger_checksum "$bn")
  if [ -z "$applied_sum" ]; then
    echo "  FAIL: $bn is in the repository but not recorded as applied"
    missing=$((missing + 1))
  elif [ "$applied_sum" != "$sum" ]; then
    echo "  FAIL: $bn was applied with a different checksum — it was edited after it ran"
    mismatched=$((mismatched + 1))
  fi
done
assert_eq "migrations applied on this box" "$total" "$(q 'select count(*) from schema_migrations')"
assert_eq "migrations missing from this box" "0" "$missing"
assert_eq "migrations whose checksum differs" "0" "$mismatched"

# The accounting schema must exist, in the UK (not Nigeria) shape this
# repository's migrations specify.
assert_eq "accounting tables" "11" "$(q "select count(*) from pg_tables where schemaname='accounting'")"
assert_eq "mtd_credentials present (not renamed)" "1" \
  "$(q "select count(*) from pg_tables where schemaname='accounting' and tablename='mtd_credentials'")"
assert_eq "firs_credentials absent (Nigeria rename removed)" "0" \
  "$(q "select count(*) from pg_tables where schemaname='accounting' and tablename='firs_credentials'")"
assert_eq "periods unique(year,month) present" "1" \
  "$(q "select count(*) from pg_constraint where conname='periods_year_month_key'")"

# The journal-balance trigger must be a CONSTRAINT trigger: 0064's original
# `create trigger ... deferrable` was a syntax error, and the check has to
# run at COMMIT (once every line of the journal is present) rather than
# after each row.
assert_eq "journal balance trigger present" "1" \
  "$(q "select count(*) from pg_trigger where tgname='trg_journal_lines_balanced'")"
assert_eq "journal balance trigger is DEFERRED" "t" \
  "$(q "select tgdeferrable from pg_trigger where tgname='trg_journal_lines_balanced'")"
assert_eq "journal balance trigger is INITIALLY DEFERRED" "t" \
  "$(q "select tginitdeferred from pg_trigger where tgname='trg_journal_lines_balanced'")"

if [ "$fail" -ne 0 ]; then
  echo "SCHEMA LEDGER CHECK FAILED" >&2
  exit 1
fi
echo "SCHEMA LEDGER CHECK PASSED"
