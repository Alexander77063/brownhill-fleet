#!/usr/bin/env bash
# hosted/tests/chaos/01-power-loss.sh
#
# The database is killed outright. The box must come back consistent.
#
# WHAT THIS USED TO BE
# -------------------
#
#     #!/usr/bin/env bash
#     set -euo pipefail
#     if ! command -v systemctl >/dev/null 2>&1; then
#       echo "systemd not available; skipping"; exit 0
#     fi
#     ...
#     sudo -u postgres /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres ...
#
# It asserted nothing about recovery. It restarted the database, timed a
# loop, and then ran the RLS proof from
# /opt/brownhill/repo/standalone/sql/portable-rls-proof.sql — a path that
# does not exist on a box deployed from a tarball, because the proof is
# staged at /opt/brownhill/sql/ by hosted/scripts/fetch-runtime.sh. So on
# the customer's own box the drill died at its last line, on a file it
# could not find, after having proved nothing at all.
#
# And the `sudo -u postgres` was wrong twice over. The box does not
# install sudo — the installer uses `runuser -u postgres --`, which is
# util-linux and always present — and the cluster's pg_hba is
# `--auth-local=peer`, so over TCP (which is where -h 127.0.0.1 points)
# the connection needs a password whatever user runs it.
#
# WHAT THIS DRILL PROVES
# ----------------------
# Against the deployment that is here:
#
#   1. the database really is GONE after the kill — not "slow", gone;
#   2. it comes back inside a minute;
#   3. the rows that were committed before the kill are still there —
#      measured against real rows, not asserted;
#   4. it is not left in recovery: `pg_is_in_recovery()` is false, so it
#      takes writes again;
#   5. the row-level policies still hold — the RLS proof is replayed, and
#      it is the proof that raises an exception if a policy has stopped
#      enforcing;
#   6. the application is serving again.
#
# Point (3) is the heart of it. "The cluster comes back consistent with
# data-checksums + WAL replay" is a claim about DATA, and a drill that
# does not look at any data proves nothing about it. So the drill builds a
# tenant with a vehicle, a driver, an agreement and an invoice, kills the
# database underneath it, and checks that all four are still there
# afterwards.
#
# It runs against whichever deployment is here: the compose stack (CI) or
# the deployed box (the monthly run).
set -uo pipefail

DRILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/drill-lib.sh
source "$DRILL_DIR/lib/drill-lib.sh"

cleanup() {
  drill_cleanup
}
trap cleanup EXIT

echo "Chaos 01: the database is killed, and it comes back with its data."

drill_setup
fixture_create "$DRILL_PERIOD"

# ── what must survive ───────────────────────────────────────────────────────
#
# The rows the drill is going to look for after the kill. They are read
# NOW, before the kill, so the assertion afterwards is "the same values
# are still there" rather than "some rows exist" — which would pass on a
# database that had lost most of its data and kept one row.
vehicle_before="$(sql_scalar "select registration from public.vehicles
                               where tenant_id = '$DRILL_TENANT_ID'")"
invoice_before="$(sql_scalar "select number from public.invoices
                               where tenant_id = '$DRILL_TENANT_ID'")"
agreement_before="$(sql_scalar "select count(*) from public.agreements
                                where tenant_id = '$DRILL_TENANT_ID'")"

if [[ -z "$vehicle_before" || -z "$invoice_before" ]]; then
  fail "the fixture did not build the rows the drill needs to look for"
fi
ok "the drill has rows to lose: a vehicle ($vehicle_before) and an invoice ($invoice_before)"

# ── the kill ────────────────────────────────────────────────────────────────
echo
echo "== the database is killed =="

db_kill_hard

# It has to be GONE, not merely slow. A database that answered a query
# after SIGKILL would mean the drill killed the wrong thing, and every
# assertion below would be about a database that never went down.
if db_answers; then
  bad "the database answered a query after being killed — the drill did not take it down"
else
  ok "the database is gone"
fi

# ── the recovery ────────────────────────────────────────────────────────────
echo
echo "== it comes back =="

recovered=0
db_start
started_at="$(date +%s)"
for _ in $(seq 1 60); do
  if db_answers; then
    recovered=1
    break
  fi
  sleep 1
done
elapsed=$(( $(date +%s) - started_at ))

if [[ "$recovered" -eq 1 ]]; then
  ok "the database came back in ${elapsed}s"
else
  fail "the database did not come back within 60s"
fi

if [[ "$elapsed" -le 60 ]]; then
  ok "the recovery was inside the 60s budget (${elapsed}s)"
else
  bad "the recovery took ${elapsed}s, over the 60s budget"
fi

# ── the data came back ──────────────────────────────────────────────────────
echo
echo "== the data came back =="

vehicle_after="$(sql_scalar "select registration from public.vehicles
                              where tenant_id = '$DRILL_TENANT_ID'")"
if [[ "$vehicle_after" == "$vehicle_before" ]]; then
  ok "the vehicle that was committed before the kill is still there ($vehicle_after)"
else
  bad "the vehicle before the kill was '$vehicle_before' and after it is '$vehicle_after'"
fi

invoice_after="$(sql_scalar "select number from public.invoices
                              where tenant_id = '$DRILL_TENANT_ID'")"
if [[ "$invoice_after" == "$invoice_before" ]]; then
  ok "the invoice that was committed before the kill is still there ($invoice_after)"
else
  bad "the invoice before the kill was '$invoice_before' and after it is '$invoice_after'"
fi

agreement_after="$(sql_scalar "select count(*) from public.agreements
                               where tenant_id = '$DRILL_TENANT_ID'")"
if [[ "$agreement_after" == "$agreement_before" ]]; then
  ok "the agreement count is unchanged ($agreement_after)"
else
  bad "the agreement count was $agreement_before before the kill and $agreement_after after it"
fi

# ── it is not left in recovery ──────────────────────────────────────────────
#
# A database that is up but still replaying its WAL answers reads and
# refuses writes. "The service came back" and "the service can be used"
# are different claims, and only the second one is worth anything.
in_recovery="$(sql_scalar "select pg_is_in_recovery()")"
if [[ "$in_recovery" == "f" ]]; then
  ok "the database is not in recovery — it finished replaying and takes writes again"
else
  bad "the database is still in recovery (pg_is_in_recovery = '$in_recovery')"
fi

# ── the policies still hold ─────────────────────────────────────────────────
#
# The RLS proof is replayed against the recovered database. It runs in one
# transaction and ends in ROLLBACK, so it leaves nothing behind, and it
# RAISES an exception if any policy has stopped enforcing — which is what
# makes its exit code worth reading.
echo
echo "== the row-level policies still hold =="

proof="$(rls_proof_path)" \
  || fail "the RLS proof could not be found — it is staged at /opt/brownhill/sql/portable-rls-proof.sql by fetch-runtime.sh"

proof_output=""
if proof_output="$(sql_file "$proof" 2>&1)"; then
  passes="$(printf '%s\n' "$proof_output" | grep -c 'PASS' || true)"
  ok "the RLS proof passed after the recovery ($passes checks)"
else
  bad "the RLS proof failed after the recovery — a policy has stopped enforcing"
  printf '%s\n' "$proof_output" | sed 's/^/    /'
fi

# ── the application is serving again ────────────────────────────────────────
echo
echo "== the application is serving again =="

if wait_for_app; then
  ok "the application answers again"
else
  bad "the application did not come back after the database did"
fi

# ── the result ──────────────────────────────────────────────────────────────
echo
drill_result

echo
echo "Drill 01 passed. The database was killed, came back inside a minute with its data intact, finished its recovery, and the policies still hold."
echo OK
