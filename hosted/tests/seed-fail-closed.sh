#!/usr/bin/env bash
# hosted/tests/seed-fail-closed.sh — prove that a seed which FAILS partway
# leaves the database fail-closed.
#
# WHY THIS TEST EXISTS
# --------------------
# supabase/seed.sql reinstates a `tenant_id` default for the duration of its
# inserts and drops it again at the very bottom of the file. The teardown is
# the LAST statement, so a seed that failed partway through left the default
# SET — which is the opposite of the state the seed exists to restore.
#
# That is not a cosmetic problem. Migration 0052 deliberately removed the
# transitional `tenant_id` default so that an application write which forgets
# tenant_id raises 23502 instead of silently landing in the wrong tenant's
# books. A failed seed took that guard away and put it back only on success:
#
#   $ psql -v ON_ERROR_STOP=1 -f supabase/seed.sql
#   ERROR:  duplicate key value violates unique constraint "vehicles_pkey"
#   $ psql -c "select count(*) from information_schema.columns
#              where column_name='tenant_id' and column_default is not null"
#    count
#   -------
#       15          <-- every one of the seeded tables is now fail-OPEN
#
# So the seed is now ONE TRANSACTION. Postgres rolls an open transaction back
# when the client disconnects, and psql's ON_ERROR_STOP exits on the first
# error, so a failed seed leaves the database exactly as it found it.
#
# THE ARGUMENT IS DIFFERENTIAL
# ----------------------------
# Three runs, against the same schema:
#
#   1. the seed WITHOUT its transaction wrapper — the defect — must fail and
#      must leave the database fail-OPEN. This is what proves the gate can
#      see the defect rather than rubber-stamping whatever the seed does;
#   2. the seed AS IT IS, with the same failure injected at the same point,
#      must fail and must leave the database fail-CLOSED;
#   3. the seed AS IT IS, with no failure injected, must succeed and must
#      also leave the database fail-closed.
#
# The failure is injected by hand, at the same point in all three runs, so
# the runs differ in exactly one thing: whether the seed is a transaction.
#
# It needs docker: it builds a throwaway postgres, replays the migrations
# into it and runs the seed against that.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# The one rule for waiting on a containerised postgres. See the file for why
# the socket is a trap and TCP is not.
# shellcheck source=scripts/lib/postgres-container.sh
source "$ROOT/scripts/lib/postgres-container.sh"

export MSYS_NO_PATHCONV=1

PASS=0
FAIL=0
ok()  { echo "  ok: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }
fail() { echo "FAIL: $*"; echo "Result: $PASS passed, $FAIL failed"; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not present; skipping seed-fail-closed"
  exit 0
fi

SEED="supabase/seed.sql"
[[ -r "$SEED" ]] || fail "the seed $SEED is not readable"

WORK="$(mktemp -d)"
cid=""
trap 'rm -rf "$WORK"; [[ -n "$cid" ]] && docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT

# ── the throwaway postgres ──────────────────────────────────────────────────
cid=$(docker run -d --rm -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16) \
  || fail "could not start a throwaway postgres"

# Wait for the REAL server, over TCP.
#
# This used to be a socket probe — `psql -c 'SELECT 1'` — and it was a race:
# the postgres image answers a socket probe from the TEMPORARY server it
# starts to run initdb, then shuts that server down. The gate would declare
# the database ready, and the very next command would find the server gone
# and report "the throwaway postgres never came up" — a failure with nothing
# to do with the seed. It failed on 2026-11-03, twice, at the same second,
# and it had been failing at other steps on other days.
if ! wait_for_container_postgres "$cid" 60; then
  fail "the throwaway postgres never came up"
fi

# ── 0: the readiness probe can fail ─────────────────────────────────────────
#
# Everything below runs only if this wait said "ready". So the wait has to be
# able to say no — otherwise it is a formality that decides nothing.
#
# The proof is the same probe, asked about a port where nothing is listening.
# It must say no.
echo
echo "== 0: the readiness probe can fail =="
if container_postgres_probe "$cid" 5433; then
  bad "the readiness probe reported a database on a port with nothing listening — it cannot fail, so a pass would prove nothing"
else
  ok "the readiness probe fails when there is no server to talk to — so a pass means something"
fi

# ── the schema, from the shipped migrations ─────────────────────────────────
#
# The seed inserts into fifteen tables with real columns and real foreign
# keys, so it needs the real schema. The migrations are the only honest
# source of that schema, and replaying them is what a fresh box does.
docker cp standalone/sql/0000_supabase_shim.sql "$cid":/tmp/
docker exec -u postgres "$cid" mkdir -p /tmp/migrations
docker cp supabase/migrations/. "$cid":/tmp/migrations/
docker cp "$SEED" "$cid":/tmp/seed.sql

docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -c 'create database seedprobe'
docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -d seedprobe -f /tmp/0000_supabase_shim.sql
for f in $(ls -1 supabase/migrations/*.sql | sort); do
  bn=$(basename "$f")
  docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -d seedprobe -f "/tmp/migrations/$bn" \
    || fail "migration $bn did not apply — the gate cannot judge the seed on a broken schema"
done

# A copy of that schema, so the defect run and the fixed run cannot tread on
# each other. The template copy is instant; a second migration replay is not.
docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 \
  -c 'create database seedprobe_old template seedprobe' \
  || fail "could not copy the schema for the defect run"

# ── the seed, in the two shapes being compared ─────────────────────────────
#
# "The seed as it was" is derived from the seed as it is, by taking the
# transaction wrapper off it. So this gate cannot rot: if someone removes
# the wrapper from the real seed, the defect run and the fixed run become
# the same file, the defect run stops leaving the database fail-open, and
# this gate says so.
strip_transaction() {
  sed -e '/^begin;$/d' -e '/^commit;$/d' "$1"
}

# The injected failure: a statement that always fails, placed after the
# seed's FIRST insert has landed. So the seed has done real work before it
# breaks — which is the case that matters, and the case that leaves the
# old seed fail-open.
#
# The injection point is "before the second insert", which is a structural
# fact of the file rather than a line number.
inject_failure() {
  awk '
    /^insert into / {
      n++
      if (n == 2) print "select 1/0;  -- INJECTED FAILURE"
    }
    { print }
  ' "$1"
}

strip_transaction "$SEED" >"$WORK/old.sql"
inject_failure "$WORK/old.sql" >"$WORK/old-broken.sql"
inject_failure "$SEED" >"$WORK/new-broken.sql"

for f in old.sql old-broken.sql new-broken.sql; do
  # Through stdin, not `docker cp`: the file lives in a temp directory whose
  # absolute path Git Bash hands to a native Windows binary as a POSIX path
  # it cannot resolve. The container's /tmp is the same either way.
  docker exec -i "$cid" sh -c "cat > /tmp/$f" <"$WORK/$f"
done

if grep -q "INJECTED FAILURE" "$WORK/old-broken.sql" && grep -q "INJECTED FAILURE" "$WORK/new-broken.sql"; then
  ok "the failure was injected into both copies of the seed"
else
  fail "the failure was not injected — the gate would have proved nothing"
fi

if grep -q "^begin;$" "$WORK/old.sql"; then
  bad "the defect copy still carries a transaction — the control is not the defect"
else
  ok "the defect copy is the seed without its transaction, which is how the defect behaved"
fi

if grep -q "^begin;$" "$SEED"; then
  ok "the seed is one transaction, so a failure rolls the whole thing back"
else
  bad "the seed is not one transaction — a failed seed can leave the database fail-open"
fi

# ── the two questions, asked of any database ───────────────────────────────
#
# How many of the seeded tables still carry a tenant_id default? Zero means
# the database is fail-closed: an application write that forgets tenant_id
# raises 23502. Anything above zero means it is fail-open.
defaulted_tables() {
  docker exec -u postgres "$cid" psql -tAq -d "$1" -c "
    select count(*) from information_schema.columns
     where table_schema='public' and column_name='tenant_id'
       and column_default is not null;"
}
row_count() {
  docker exec -u postgres "$cid" psql -tAq -d "$1" -c "select count(*) from public.vehicles;"
}

echo
echo "== 1: the seed as it was — a failed seed leaves the database fail-OPEN =="

docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -d seedprobe_old -f /tmp/old-broken.sql >"$WORK/old.out" 2>&1
if [[ $? -ne 0 ]]; then
  ok "the defect copy failed, as it was made to"
else
  bad "the defect copy SUCCEEDED — the failure was not injected where it should have been"
  sed 's/^/    /' "$WORK/old.out"
fi

if grep -qi "division by zero" "$WORK/old.out"; then
  ok "it failed with the injected failure, not with something else"
else
  bad "it failed, but not with the injected failure"
  sed 's/^/    /' "$WORK/old.out"
fi

old_defaults="$(defaulted_tables seedprobe_old)"
if [[ "${old_defaults:-0}" -gt 0 ]]; then
  ok "the defect leaves $old_defaults tables fail-OPEN — this is the defect, and the gate can see it"
else
  bad "the defect did NOT leave the database fail-open ($old_defaults) — the gate cannot see the defect it exists to catch"
fi

old_rows="$(row_count seedprobe_old)"
if [[ "${old_rows:-0}" -gt 0 ]]; then
  ok "the defect also left $old_rows stray vehicle rows behind — it left the database half-seeded"
else
  bad "the defect left no stray rows, so the half-seeded state is not being exercised"
fi

echo
echo "== 2: the seed as it is — a failed seed leaves the database fail-CLOSED =="

docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -d seedprobe -f /tmp/new-broken.sql >"$WORK/new.out" 2>&1
if [[ $? -ne 0 ]]; then
  ok "the seed failed, as it was made to"
else
  bad "the seed SUCCEEDED — the failure was not injected where it should have been"
  sed 's/^/    /' "$WORK/new.out"
fi

if grep -qi "division by zero" "$WORK/new.out"; then
  ok "it failed with the injected failure, not with something else"
else
  bad "it failed, but not with the injected failure"
  sed 's/^/    /' "$WORK/new.out"
fi

new_defaults="$(defaulted_tables seedprobe)"
if [[ "${new_defaults:-1}" -eq 0 ]]; then
  ok "the database is still fail-closed after the failed seed — no tenant_id default survived"
else
  bad "$new_defaults tables are still fail-OPEN after a failed seed — the guard is gone"
fi

new_rows="$(row_count seedprobe)"
if [[ "${new_rows:-1}" -eq 0 ]]; then
  ok "the failed seed left nothing behind — the whole transaction rolled back"
else
  bad "$new_rows vehicle rows survived a failed seed — the rollback did not roll back"
fi

# The guard itself, asked of the database rather than of the catalog: a write
# that forgets tenant_id must be refused.
refused=$(docker exec -u postgres "$cid" psql -tAq -d seedprobe -c "
  insert into public.obligations (entity_type, entity_id, type, title, due_date, severity, status)
  values ('vehicle','22222222-2222-2222-2222-222222222222','ved_renewal','seed-fail-closed probe',current_date,'info','open');" 2>&1)
if grep -qi "tenant_id" <<<"$refused"; then
  ok "a write that forgets tenant_id is refused — the 23502 guard is in place"
else
  bad "a write that forgets tenant_id was NOT refused — the database is not fail-closed"
  echo "    $refused"
fi

echo
echo "== 3: the seed as it is — a clean seed succeeds and still leaves it fail-closed =="

docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -d seedprobe -f /tmp/seed.sql >"$WORK/clean.out" 2>&1
if [[ $? -ne 0 ]]; then
  bad "the seed did not run cleanly against a freshly migrated database"
  sed 's/^/    /' "$WORK/clean.out" | tail -30
else
  ok "the seed runs cleanly against a freshly migrated database"
fi

clean_defaults="$(defaulted_tables seedprobe)"
if [[ "${clean_defaults:-1}" -eq 0 ]]; then
  ok "a clean seed leaves the database fail-closed too"
else
  bad "$clean_defaults tables are fail-OPEN after a clean seed"
fi

clean_rows="$(row_count seedprobe)"
if [[ "${clean_rows:-0}" -eq 4 ]]; then
  ok "the seed's four vehicles are there"
else
  bad "the seed left $clean_rows vehicles, expected 4"
fi

echo
echo "== 4: the seeded books tell the truth — the invoices carry a VAT code =="

# The demo seed runs AFTER the migrations, so migration 0086's backfill had
# already been through by the time its invoices were created and could not
# help them: they were created with a null `vat_code_id`.
#
# That state is invisible in the schema and fatal in the return. The VAT
# return groups the invoices on the code, adds every row's net to box 4
# whatever its code, and only sets box 1 — the output VAT due to HMRC — from
# the row whose code IS 'T1'. So a null code left box 1 at zero while box 4
# carried that month's net sales: the return said "you owe no VAT" and "you
# sold £25,500 of rentals" in the same breath.
#
# The questions are therefore asked of the DATABASE, not of the seed's text:
# what did the seeded invoices actually end up with?
seeded_invoices() {
  docker exec -u postgres "$cid" psql -tAq -d seedprobe -c \
    "select count(*) from public.invoices;" | tr -d ' '
}
seeded_without_a_code() {
  docker exec -u postgres "$cid" psql -tAq -d seedprobe -c \
    "select count(*) from public.invoices where vat_code_id is null;" | tr -d ' '
}
seeded_standard_rated() {
  docker exec -u postgres "$cid" psql -tAq -d seedprobe -c \
    "select count(*) from public.invoices i
       join accounting.vat_codes vc on vc.id = i.vat_code_id
      where vc.code = 'T1';" | tr -d ' '
}
seeded_vat_total() {
  docker exec -u postgres "$cid" psql -tAq -d seedprobe -c \
    "select coalesce(sum(i.vat_pence), 0) from public.invoices i
       join accounting.vat_codes vc on vc.id = i.vat_code_id
      where vc.code = 'T1';" | tr -d ' '
}
seeded_net_total() {
  docker exec -u postgres "$cid" psql -tAq -d seedprobe -c \
    "select coalesce(sum(i.net_pence), 0) from public.invoices i
       join accounting.vat_codes vc on vc.id = i.vat_code_id
      where vc.code = 'T1';" | tr -d ' '
}

invoices="$(seeded_invoices)"
without_code="$(seeded_without_a_code)"
standard_rated="$(seeded_standard_rated)"
vat_total="$(seeded_vat_total)"
net_total="$(seeded_net_total)"

if [[ "${without_code:-1}" -eq 0 && "${invoices:-0}" -gt 0 ]]; then
  ok "every seeded invoice carries a VAT code ($invoices invoices, none without one)"
else
  bad "$without_code of $invoices seeded invoices carry no VAT code — the VAT return cannot see them"
fi

if [[ "${standard_rated:-0}" -eq "${invoices:-0}" && "${invoices:-0}" -gt 0 ]]; then
  ok "and it is T1 — every seeded invoice carries VAT, so every one is standard-rated"
else
  bad "$standard_rated of $invoices seeded invoices are standard-rated (T1) — the return would miss the rest"
fi

if [[ "${vat_total:-0}" -gt 0 ]]; then
  ok "the output VAT the return will report is $vat_total pence — it was zero while the codes were missing"
else
  bad "the output VAT the return will report is zero — box 1 is empty while box 4 carries the net sales"
fi

if [[ "${vat_total:-0}" -eq 510000 && "${net_total:-0}" -eq 2550000 ]]; then
  ok "the return's figures are £5,100 of output VAT against £25,500 of net sales — the figures the index publishes"
else
  bad "the seeded totals are $vat_total pence of output VAT and $net_total pence of net sales, not 510000 and 2550000 — the index's figures have to change with them"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
