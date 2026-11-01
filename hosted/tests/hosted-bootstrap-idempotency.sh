#!/usr/bin/env bash
# hosted/tests/hosted-bootstrap-idempotency.sh
#
# The bootstrap is a systemd oneshot with RemainAfterExit, so it runs on every
# boot of the box. It therefore has to be a no-op against a database that is
# already provisioned — and the script's own header has always claimed exactly
# that. It was false.
#
# Measured on 2026-10-30, against the compose stack's own volume:
#
#   psql:/opt/brownhill/supabase/migrations/0001_extensions.sql:17:
#   ERROR:  type "user_role" already exists
#
# 0001 creates twenty-three enum types with no guard, so the second run died
# on the first statement and the oneshot exited 3. On the production box that
# meant every reboot after the first one logged a failed unit, and the
# schema was one boot behind whatever had been deployed in the meantime.
#
# This gate proves the claim, and it proves the four things that make it true:
#
#   1. A first run applies the shim and every migration, and records them.
#   2. A second run applies NOTHING, exits 0, and leaves the schema byte for
#      byte as it found it.
#   3. A migration whose CONTENT changed after it was applied is refused,
#      loudly, naming the file — because the ledger stores a checksum.
#   4. An existing database with no ledger can be adopted (baselined), and a
#      baseline that over-claims what is actually there is refused.
#
# ...and the four operator-facing paths around that claim:
#
#   4c. A baseline that claims a migration creating only enum types is
#       refused — the case the fingerprint used to see nothing in, because
#       it saw tables only.
#   4d. A database that already has the WHOLE history applied can be adopted
#       without applying any of it again — the case the old "everything
#       strictly before FILE" semantics could not express at all.
#   5.  The status report tells the operator what is there, what is missing
#       and what to type to adopt it — and writes NOTHING: not a ledger row,
#       not the application schema, not the first-run door.
#   5b. On a fully migrated database the report says there is nothing to
#       adopt, and leaves bootstrap_pending alone.
#
# It runs the REAL hosted/bootstrap/brownhill-bootstrap.sh inside a real
# postgres:16 container, with the repository mounted — not a re-implementation
# of it, which would prove nothing about the script that ships.
#
# Skips gracefully when docker is absent; that env is for dev hosts without
# docker.

set -euo pipefail

# Git Bash on Windows rewrites a container path like /tmp/migrations into a
# Windows path before it reaches docker. Turning the rewriting off is a no-op
# on Linux, where CI runs this script.
export MSYS_NO_PATHCONV=1

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not present; skipping hosted-bootstrap-idempotency"
  exit 0
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Docker's daemon on Windows is a Linux VM: it cannot mount a Git Bash
# /c/Users/... path. `pwd -W` prints the path the daemon understands.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) REPO_MOUNT="$(cd "$REPO" && pwd -W)" ;;
  *) REPO_MOUNT="$REPO" ;;
esac

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

MIGRATIONS="$REPO/supabase/migrations"

# The number of migrations the repository ships. The ledger must hold one row
# per migration plus one for the shim.
expected_ledger_rows=$(( $(ls -1 "$MIGRATIONS"/*.sql | wc -l) + 1 ))

# ── container plumbing ──────────────────────────────────────────────────────

cids=()
cleanup() {
  for c in "${cids[@]:-}"; do
    [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# Starts a postgres and leaves its id in the global PG_CID.
#
# This used to `echo` the id and be called as `cid=$(start_pg)`. A command
# substitution runs in a subshell, so the `cids+=("$cid")` inside the function
# updated the SUBSHELL's array and the parent's stayed empty — the exit trap
# then had nothing to remove and every run leaked its containers. The id is a
# global now, so there is no subshell between here and the array.
PG_CID=""
start_pg() {
  local cid
  cid=$(docker run -d --rm -e POSTGRES_HOST_AUTH_METHOD=trust \
    -v "$REPO_MOUNT:/repo:ro" postgres:16)
  cids+=("$cid")
  PG_CID="$cid"
  for _ in $(seq 1 60); do
    if docker exec -e PGHOST=127.0.0.1 -e PGPORT=5432 "$cid" \
         psql -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "postgres did not come up" >&2
  docker logs --tail 30 "$cid" >&2 || true
  return 1
}

# The real bootstrap script, run inside the container against the real
# postgres. $1 container, $2 repo root inside the container, $3... extra args.
bootstrap() {
  local cid="$1" repo="$2"; shift 2
  docker exec \
    -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER=postgres -e PGDATABASE=postgres \
    -e BROWNHILL_REPO="$repo" \
    "$cid" bash /repo/hosted/bootstrap/brownhill-bootstrap.sh "$@"
}

q() {  # q <container> <sql>
  docker exec -e PGHOST=127.0.0.1 -e PGPORT=5432 "$1" \
    psql -U postgres -d postgres -tAc "$2"
}

ledger_rows() { q "$1" 'select count(*) from public.schema_migrations'; }

# Tables, enum types and functions — the shape of the schema, which a second
# run must not change by one.
schema_fingerprint() {
  q "$1" "select
      (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema')),
      (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace
        where t.typtype='e' and n.nspname not in ('pg_catalog','information_schema')),
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname not in ('pg_catalog','information_schema'))"
}

# ── 1. the first run applies everything and records it ──────────────────────

echo "== 1: the first run applies the shim and every migration =="
start_pg; cid="$PG_CID"
first_out=$(bootstrap "$cid" /repo 2>&1) || {
  bad "the first run failed"
  echo "$first_out" | tail -20
  exit 1
}
ok "the first run exited 0"

rows=$(ledger_rows "$cid" 2>/dev/null || echo 0)
if [ "$rows" = "$expected_ledger_rows" ]; then
  ok "the ledger holds $rows rows (one per migration, plus the shim)"
else
  bad "the ledger holds $rows rows, expected $expected_ledger_rows"
fi

# ── 2. the second run is a no-op ────────────────────────────────────────────

echo "== 2: the second run applies nothing =="
before=$(schema_fingerprint "$cid")
second_out=$(bootstrap "$cid" /repo 2>&1) && second_status=0 || second_status=$?

if [ "$second_status" -eq 0 ]; then
  ok "the second run exited 0"
else
  bad "the second run exited $second_status — it is not idempotent"
  echo "$second_out" | tail -20
fi

if echo "$second_out" | grep -q 'applied 0 migrations'; then
  ok "the second run applied 0 migrations"
else
  bad "the second run did not report 'applied 0 migrations'"
  echo "$second_out" | tail -20
fi

after=$(schema_fingerprint "$cid")
if [ "$before" = "$after" ]; then
  ok "the schema is unchanged by the second run ($before)"
else
  bad "the second run changed the schema: $before -> $after"
fi

rows=$(ledger_rows "$cid" 2>/dev/null || echo 0)
if [ "$rows" = "$expected_ledger_rows" ]; then
  ok "the ledger did not grow ($rows rows)"
else
  bad "the ledger grew to $rows rows, expected $expected_ledger_rows"
fi

# ── 3. a migration that changed after it was applied is refused ─────────────

echo "== 3: a tampered migration is refused =="
# Copy the repository's SQL into a second tree and change one already-applied
# migration's content. The ledger holds that file's checksum, so the run must
# refuse rather than silently skip it.
#
# The tree has to be a WHOLE repository, not just its SQL: the bootstrap looks
# for the ledger library at $repo/standalone/scripts/schema-ledger.sh, and
# without it the script exits 66 ("could not find schema-ledger.sh") before it
# ever reaches a checksum. A refusal for the wrong reason is not a pass, so
# the tree carries the library and the assertion below checks that the
# refusal names the migration that changed.
docker exec "$cid" bash -c '
  mkdir -p /tampered/supabase/migrations /tampered/standalone/sql /tampered/standalone/scripts
  cp /repo/supabase/migrations/*.sql /tampered/supabase/migrations/
  cp /repo/standalone/sql/0000_supabase_shim.sql /tampered/standalone/sql/
  cp /repo/standalone/scripts/schema-ledger.sh /tampered/standalone/scripts/
  printf "\n-- a line that was not there when the migration was applied\n" \
    >> /tampered/supabase/migrations/0002_platform.sql
'
tamper_out=$(bootstrap "$cid" /tampered 2>&1) && tamper_status=0 || tamper_status=$?
if [ "$tamper_status" -ne 0 ]; then
  ok "the run refused the changed migration (exit $tamper_status)"
else
  bad "the run applied a migration whose content had changed"
  echo "$tamper_out" | tail -20
fi
if echo "$tamper_out" | grep -q '0002_platform.sql'; then
  ok "the refusal names the file that changed"
else
  bad "the refusal did not name the file that changed"
  echo "$tamper_out" | tail -20
fi
# The refusal must be about the checksum, not about the ledger library being
# missing. Otherwise this phase would pass for the wrong reason.
if echo "$tamper_out" | grep -qi 'checksum'; then
  ok "the refusal is about the changed content, not a missing file"
else
  bad "the refusal was not about the changed content"
  echo "$tamper_out" | tail -20
fi

# ── 4. an existing database is adopted; an over-claim is refused ────────────

echo "== 4: baselining an existing database =="
start_pg; cid2="$PG_CID"
# Provision the database the way the box was provisioned: apply the shim and
# the first five migrations by hand, with no ledger, exactly as it was before
# the ledger existed.
docker exec -e PGHOST=127.0.0.1 -e PGPORT=5432 "$cid2" \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
  -f /repo/standalone/sql/0000_supabase_shim.sql
for f in "$MIGRATIONS"/000[1-5]_*.sql; do
  bn=$(basename "$f")
  docker exec -e PGHOST=127.0.0.1 -e PGPORT=5432 "$cid2" \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "/repo/supabase/migrations/$bn"
done

base_out=$(bootstrap "$cid2" /repo --baseline-through=0005_agreements.sql 2>&1) && base_status=0 || base_status=$?
if [ "$base_status" -eq 0 ]; then
  ok "the database was adopted and the rest applied (exit 0)"
else
  bad "adopting the database failed (exit $base_status)"
  echo "$base_out" | tail -25
fi

rows=$(ledger_rows "$cid2" 2>/dev/null || echo 0)
if [ "$rows" = "$expected_ledger_rows" ]; then
  ok "the ledger holds $rows rows after adoption"
else
  bad "the ledger holds $rows rows after adoption, expected $expected_ledger_rows"
fi

# And the adopted database is still a no-op on the next run.
base2_out=$(bootstrap "$cid2" /repo 2>&1) && base2_status=0 || base2_status=$?
if [ "$base2_status" -eq 0 ] && echo "$base2_out" | grep -q 'applied 0 migrations'; then
  ok "the adopted database is a no-op on the next run"
else
  bad "the adopted database was not a no-op on the next run (exit $base2_status)"
  echo "$base2_out" | tail -20
fi

echo "== 4b: a baseline that over-claims is refused =="
start_pg; cid3="$PG_CID"
over_out=$(bootstrap "$cid3" /repo --baseline-through=0006_billing.sql 2>&1) && over_status=0 || over_status=$?
if [ "$over_status" -ne 0 ]; then
  ok "the over-claiming baseline was refused (exit $over_status)"
else
  bad "the over-claiming baseline was accepted against an empty database"
fi
if echo "$over_out" | grep -qi 'baseline'; then
  ok "the refusal explains that the baseline does not match the database"
else
  bad "the refusal did not mention the baseline"
  echo "$over_out" | tail -20
fi

echo "== 4c: a baseline that claims a migration creating only enums is refused =="
# 0001 creates twenty-three enum types and a function, and no table at all.
#
# The fingerprint used to see tables only, so a baseline claiming 0001 against
# an empty database found nothing to check and was ACCEPTED. The ledger then
# recorded 0001 as applied, the migration loop skipped it as "already
# applied", and the database was left with no user_role enum and no
# set_updated_at function — while the ledger claimed the migration had been
# applied. A silently broken schema that the ledger says is fine.
#
# --baseline-through=0001 claims 0001 and everything before it — which is
# 0001 alone, the migration that creates twenty-three enum types and a
# function and no table at all.
start_pg; cid4="$PG_CID"
enum_out=$(bootstrap "$cid4" /repo --baseline-through=0001_extensions.sql 2>&1) && enum_status=0 || enum_status=$?
if [ "$enum_status" -ne 0 ]; then
  ok "the baseline claiming the enum-only migration was refused (exit $enum_status)"
else
  bad "the baseline claiming 0001 was accepted against an empty database"
fi
if echo "$enum_out" | grep -q 'user_role'; then
  ok "the refusal names the enum type that is missing"
else
  bad "the refusal did not name the missing enum type"
  echo "$enum_out" | tail -20
fi
# And the database must not have been half-migrated on the way out.
enum_rows=$(ledger_rows "$cid4" 2>/dev/null || echo 0)
if [ "$enum_rows" = "0" ]; then
  ok "the refused baseline recorded nothing in the ledger"
else
  bad "the refused baseline recorded $enum_rows ledger rows"
fi

# ── 5. the operator's status report ─────────────────────────────────────────

echo "== 4d: a database with the whole history applied can be adopted =="
# The case the old "everything strictly before FILE" semantics could not
# express: every migration is already applied, and the ledger has to say so
# WITHOUT applying any of them again.
#
# It is also the real shape of the adoption on the live box. That box was
# provisioned before the ledger existed, so its compatibility shim is already
# in place — and adopting it means the shim is applied a second time. If the
# shim were not re-runnable, adoption would fail there and nowhere else.
#
# So: take the fully-migrated database, empty the ledger, and adopt it.
docker exec -e PGHOST=127.0.0.1 -e PGPORT=5432 "$cid" \
  psql -U postgres -d postgres -q -c 'delete from public.schema_migrations'
last_migration="$(basename "$(ls -1 "$MIGRATIONS"/*.sql | tail -1)")"
adopt_out=$(bootstrap "$cid" /repo --baseline-through="$last_migration" 2>&1) && adopt_status=0 || adopt_status=$?
if [ "$adopt_status" -eq 0 ]; then
  ok "the fully-applied database was adopted (exit 0)"
else
  bad "adopting the fully-applied database failed (exit $adopt_status)"
  echo "$adopt_out" | tail -25
fi
if echo "$adopt_out" | grep -q 'applied 0 migrations'; then
  ok "adopting it applied 0 migrations"
else
  bad "adopting it applied something it should not have"
  echo "$adopt_out" | tail -25
fi
rows=$(ledger_rows "$cid" 2>/dev/null || echo 0)
if [ "$rows" = "$expected_ledger_rows" ]; then
  ok "the ledger holds all $rows rows after the adoption"
else
  bad "the ledger holds $rows rows after the adoption, expected $expected_ledger_rows"
fi

echo "== 5: the status report tells the operator what to adopt =="
# This is the FIRST thing the runbook tells the operator to do on the live
# box, so it has to work and it has to be safe to run there.
start_pg; cid5="$PG_CID"
docker exec -e PGHOST=127.0.0.1 -e PGPORT=5432 "$cid5" \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
  -f /repo/standalone/sql/0000_supabase_shim.sql
for f in "$MIGRATIONS"/000[1-5]_*.sql; do
  bn=$(basename "$f")
  docker exec -e PGHOST=127.0.0.1 -e PGPORT=5432 "$cid5" \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "/repo/supabase/migrations/$bn"
done

status_out=$(bootstrap "$cid5" /repo --status 2>&1) && status_code=0 || status_code=$?
if [ "$status_code" -eq 0 ]; then
  ok "the status report exited 0"
else
  bad "the status report exited $status_code"
  echo "$status_out" | tail -20
fi

if echo "$status_out" | grep -q 'present, not recorded'; then
  ok "the report says which migrations are already in the database"
else
  bad "the report does not say which migrations are already there"
  echo "$status_out" | tail -20
fi

if echo "$status_out" | grep -q 'absent'; then
  ok "the report says which migrations are missing"
else
  bad "the report does not say which migrations are missing"
  echo "$status_out" | tail -20
fi

# It must hand the operator the command to adopt the database.
if echo "$status_out" | grep -q -- '--baseline-through='; then
  ok "the report gives the operator the adopt command"
else
  bad "the report did not give the operator the adopt command"
  echo "$status_out" | tail -20
fi

# A status report must not APPLY anything.
status_rows=$(ledger_rows "$cid5" 2>/dev/null || echo 0)
if [ "$status_rows" = "0" ]; then
  ok "the status report recorded nothing in the ledger"
else
  bad "the status report recorded $status_rows ledger rows — it applied something"
fi

# And it must not write to the application schema either. The bootstrap's
# last act is to make sure `app_state.bootstrap_pending` is '1', which is
# the first-run door: on a database where that row is absent, the status
# report would create it and hand the first-run setup back to anyone
# holding BOOTSTRAP_TOKEN. A report must not open a door.
app_state=$(q "$cid5" "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relname='app_state' and n.nspname='public'")
if [ "$app_state" = "0" ]; then
  ok "the status report did not create the app_state table"
else
  bad "the status report created the app_state table — it wrote to the application schema"
fi

echo "== 5b: the status report on a migrated database says there is nothing to adopt =="
# The first database is fully migrated (phase 1). Its report must say so.
full_out=$(bootstrap "$cid" /repo --status 2>&1) && full_code=0 || full_code=$?
if [ "$full_code" -eq 0 ]; then
  ok "the status report on a migrated database exited 0"
else
  bad "the status report on a migrated database exited $full_code"
  echo "$full_out" | tail -20
fi
if echo "$full_out" | grep -qE '^[0-9]{4}_[^ ]+\.sql +(present|absent)'; then
  bad "the report claims a migration is not applied, on a fully migrated database"
  echo "$full_out" | grep -E '^[0-9]{4}_[^ ]+\.sql +(present|absent)' | head -5
else
  ok "every migration is reported as applied"
fi
if echo "$full_out" | grep -q 'Nothing to adopt'; then
  ok "the report says there is nothing to adopt"
else
  bad "the report does not say there is nothing to adopt"
  echo "$full_out" | tail -20
fi

# And it must not re-open the first-run door.
q "$cid" "update app_state set value='0' where key='bootstrap_pending'" >/dev/null 2>&1 || true
bootstrap "$cid" /repo --status >/dev/null 2>&1 || true
pending=$(q "$cid" "select value from app_state where key='bootstrap_pending'")
if [ "$pending" = "0" ]; then
  ok "the status report left bootstrap_pending alone (still 0)"
else
  bad "the status report reset bootstrap_pending to '$pending' — it re-opened the first-run door"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
