#!/usr/bin/env bash
# hosted/tests/schema-gate.sh — THE gate.
#
# Proves the schema can be built from zero by the repo's own provisioning
# script, and that the result passes the RLS portability proof. This is the
# check that was missing: five migrations shipped unverified because nothing
# replayed them against a real PostgreSQL 16, and the acceptance script's
# gates could not fail (Gate 1 ran `pnpm --filter @brownhill/webapp test`,
# which matches no package and exits 0).
#
# What it does:
#   1. Starts a throwaway postgres:16.
#   2. Runs hosted/bootstrap/brownhill-bootstrap.sh against it — the REAL
#      script that provisions a box, not a reimplementation of it.
#   3. Asserts the ledger recorded every migration, and that the objects the
#      recent migrations create are actually present.
#   4. Re-runs the bootstrap and asserts it is a clean no-op.
#   5. Runs the RLS portability proof.
#
# Runs on any machine with Docker. No self-hosted runner required.
set -euo pipefail

# Git Bash rewrites any argument that looks like an absolute POSIX path into
# a Windows path before handing it to a native program. Every /tmp/... path
# below is meant for the CONTAINER, not for the host, so the rewriting has
# to be off — otherwise `docker exec ... mkdir -p /tmp/gate-sql` tries to
# create "C:/Program Files/Git/tmp/gate-sql" on the host and fails with
# "Permission denied". This variable has no effect on Linux CI.
export MSYS_NO_PATHCONV=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

WORK="$(mktemp -d)"
# CID is assigned below; the trap may fire before that, so expand it safely.
trap 'rm -rf "$WORK"; [ -n "${CID:-}" ] && docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

echo "== schema gate: starting a throwaway postgres:16 =="
CID=$(docker run -d --rm -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16)

# Every psql call inside the container connects over TCP on 127.0.0.1:5432.
#
# `docker exec` does NOT inherit the caller's environment, so PGHOST/PGPORT
# set in the bootstrap script never reach the container. Without them psql
# falls back to the Unix socket at /var/run/postgresql/.s.PGSQL.5432, which
# the container image does not create the way a package-installed Postgres
# does — the connection fails with "No such file or directory" before a
# single migration runs. Passing -h/-p explicitly is what makes the
# container's psql reach its own server.
psql_in() {
  docker exec -u postgres "$CID" psql -h 127.0.0.1 -p 5432 "$@"
}
for _ in $(seq 1 60); do
  psql_in -c 'SELECT 1' >/dev/null 2>&1 && break
  sleep 0.5
done
psql_in -c 'SELECT 1' >/dev/null

# The bootstrap script calls `psql` from PATH. There is no psql client on the
# CI runner, so put a forwarding wrapper earlier on PATH.
#
# The wrapper has to translate file arguments: `psql -f <path>` names a file
# on the machine running the script, but psql runs INSIDE the container and
# cannot read a host path. So the SQL files are staged into the container
# once, up front, and the wrapper maps each -f argument to its staged copy by
# basename. Everything else (-c, -v, --single-transaction, and SQL arriving on
# stdin) passes straight through.
#
# Staging up front rather than copying per invocation matters: the bootstrap
# applies ~75 migrations, and a `docker cp` per file is slow and, on a busy
# machine, intermittently fails to fork.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/psql" <<'WRAP'
#!/usr/bin/env bash
args=()
want_file=0
for a in "$@"; do
  if [ "$want_file" -eq 1 ]; then
    want_file=0
    # Every SQL file the bootstrap reads was staged into the container
    # before the run, so mapping by basename is enough. The host-side -f
    # test is what decides whether this is a file argument at all.
    if [ -f "$a" ]; then
      args+=("/tmp/gate-sql/$(basename "$a")")
      continue
    fi
  fi
  [ "$a" = "-f" ] && want_file=1
  args+=("$a")
done
exec docker exec -u postgres -i "$PG_CID" psql -h 127.0.0.1 -p 5432 "${args[@]}"
WRAP
chmod +x "$WORK/bin/psql"
export PG_CID="$CID"
export PATH="$WORK/bin:$PATH"

# Stage the SQL the bootstrap will read. `docker cp` needs a path its client
# understands: on a Git-Bash-for-Windows host the path is MSYS-style (/c/...),
# which the Windows docker client cannot resolve, so cygpath converts it.
# On Linux CI there is no cygpath and the path is already correct.
stage_cp() {
  local src="$1" dst="$2"
  if command -v cygpath >/dev/null 2>&1; then
    src=$(cygpath -w "$src")
  fi
  docker cp "$src" "$dst" >/dev/null
}
docker exec -u postgres "$CID" mkdir -p /tmp/gate-sql
stage_cp "$REPO_ROOT/standalone/sql/0000_supabase_shim.sql" "$CID:/tmp/gate-sql/0000_supabase_shim.sql"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  stage_cp "$f" "$CID:/tmp/gate-sql/$(basename "$f")"
done

# A throwaway secret file in the shape the script reads.
mkdir -p "$WORK/secrets"
echo "PG_SUPERUSER_PASSWORD=trust" > "$WORK/secrets/pg.env"

export BROWNHILL_REPO_DIR="$REPO_ROOT"
export BROWNHILL_PGHOST=127.0.0.1
export BROWNHILL_PGPORT=5432
export BROWNHILL_PG_ENV_FILE="$WORK/secrets/pg.env"

q() { psql_in -tAc "$1" | tr -d ' '; }

echo "== schema gate: running hosted/bootstrap/brownhill-bootstrap.sh =="
bash hosted/bootstrap/brownhill-bootstrap.sh

echo "== schema gate: asserting the schema =="
fail=0
assert_eq() {
  local what="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ok: $what = $actual"
  else
    echo "  FAIL: $what — expected $expected, got $actual"
    fail=1
  fi
}

mig_count=$(ls -1 supabase/migrations/*.sql | wc -l | tr -d ' ')
assert_eq "migrations in the ledger" "$mig_count" "$(q 'select count(*) from schema_migrations')"

# The accounting schema must exist, with the UK (not Nigeria) shape.
assert_eq "accounting tables" "11" "$(q "select count(*) from pg_tables where schemaname='accounting'")"
assert_eq "mtd_credentials present (not renamed)" "1" \
  "$(q "select count(*) from pg_tables where schemaname='accounting' and tablename='mtd_credentials'")"
assert_eq "firs_credentials absent (Nigeria rename removed)" "0" \
  "$(q "select count(*) from pg_tables where schemaname='accounting' and tablename='firs_credentials'")"
assert_eq "periods unique(year,month) restored" "1" \
  "$(q "select count(*) from pg_constraint where conname='periods_year_month_key'")"
assert_eq "journal balance trigger present" "1" \
  "$(q "select count(*) from pg_trigger where tgname='trg_journal_lines_balanced'")"
# It has to be a CONSTRAINT trigger, and it has to be deferred: the balance
# check must run at COMMIT, once every line of the journal is present, not
# after each row. `create trigger ... deferrable` was a syntax error, and a
# regression that quietly downgraded it to a row-level trigger would still
# pass a check that only looked for the trigger's existence.
assert_eq "journal balance trigger is DEFERRED" "t" \
  "$(q "select tgdeferrable from pg_trigger where tgname='trg_journal_lines_balanced'")"
assert_eq "journal balance trigger is INITIALLY DEFERRED" "t" \
  "$(q "select tginitdeferred from pg_trigger where tgname='trg_journal_lines_balanced'")"

# The tables added by the recent feature migrations.
assert_eq "driver damage / booking series / payment links / handover photos" "4" \
  "$(q "select count(*) from pg_tables where schemaname='public' and tablename in
        ('driver_damage_reports','booking_series','payment_link_tokens','agreement_handover_photos')")"

echo "== schema gate: re-running the bootstrap (must be a clean no-op) =="
before=$(q 'select count(*) from schema_migrations')
out=$(bash hosted/bootstrap/brownhill-bootstrap.sh 2>&1) || {
  echo "  FAIL: the second bootstrap run exited non-zero" >&2
  echo "$out" | tail -20 >&2
  fail=1
}
after=$(q 'select count(*) from schema_migrations')
assert_eq "ledger rows unchanged by the re-run" "$before" "$after"
if echo "$out" | grep -q '^applying '; then
  echo "  FAIL: the second run re-applied migrations" >&2
  echo "$out" | grep '^applying ' >&2
  fail=1
else
  echo "  ok: the second run applied nothing"
fi

echo "== schema gate: ledger check (the box-side half of the guarantee) =="
# The gate that runs on a deployed box. Run it here too, against the database
# this gate just built, so CI proves both halves: the schema builds from
# zero, and a database that has been built carries a ledger that matches the
# repository exactly.
if ! bash hosted/tests/schema-ledger-check.sh; then
  echo "  FAIL: the ledger check rejected the schema this gate just built" >&2
  fail=1
fi

echo "== schema gate: RLS portability proof =="
stage_cp "$REPO_ROOT/standalone/sql/portable-rls-proof.sql" "$CID:/tmp/gate-sql/portable-rls-proof.sql"
psql_in -v ON_ERROR_STOP=1 -f /tmp/gate-sql/portable-rls-proof.sql

if [ "$fail" -ne 0 ]; then
  echo "SCHEMA GATE FAILED" >&2
  exit 1
fi
echo "SCHEMA GATE PASSED"
