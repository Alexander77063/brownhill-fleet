#!/usr/bin/env bash
# hosted/tests/chaos/02-postgres-restart.sh
#
# The database is restarted underneath the running application. The
# application must come back with it.
#
# WHAT THIS USED TO BE
# -------------------
#
#     JWT=$(curl -sk -c /tmp/cookies http://127.0.0.1:55431/login-with-cookies)
#     http=$(curl -sk -b /tmp/cookies -o /dev/null -w '%{http_code}' http://127.0.0.1:55431/t/A/dashboard)
#     [[ "$http" == "200" || "$http" == "401" || "$http" == "403" ]] || { echo "FAIL: unexpected $http"; exit 1; }
#
# Three separate things were wrong with that, and the worst of them is the
# first:
#
#   1. NEITHER ROUTE EXISTS. There is no /login-with-cookies and no
#      /t/A/dashboard in this codebase — the application is a set of
#      portals at /ops, /admin, /accounts, /driver, /investor and /owner.
#      So the drill fetched two 404s and called the result a pass, because
#      the assertion allowed 200, 401 OR 403 and a 404 was none of them —
#      no: the assertion REJECTED a 404, so the drill FAILED on the
#      customer's own box, for a reason that has nothing to do with the
#      database restart it exists to test.
#   2. Port 55431 is the compose stack's development port. The deployed
#      box serves the application on 443 behind nginx. The drill was
#      curling a port nothing listens on, on the one machine where it
#      matters.
#   3. It restarted the database and then asked the APPLICATION whether
#      it was alive. It never asked the DATABASE. A drill about postgres
#      recovery that does not look at postgres proves nothing about it.
#
# WHAT THIS DRILL PROVES
# ----------------------
# Against the deployment that is here:
#
#   1. the data plane answers BEFORE the restart — the control, without
#      which "it answers after the restart" would prove nothing;
#   2. the database is back inside thirty seconds;
#   3. the application is serving again;
#   4. THE DATA PLANE ANSWERS AGAIN, with the same session token. This is
#      the one that matters: the application reads its rows through
#      PostgREST, so a page that renders over an empty database is not a
#      recovered application. The request is made the way the application
#      makes it — with the bearer token, because PostgREST authorises
#      from the bearer and not from the cookie;
#   5. the rows are intact;
#   6. the row-level policies still hold.
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

echo "Chaos 02: the database is restarted, and the application comes back with it."

drill_setup
fixture_create "$DRILL_PERIOD"
mint_session

vehicle_before="$(sql_scalar "select registration from public.vehicles
                               where tenant_id = '$DRILL_TENANT_ID'")"

# ── the control ─────────────────────────────────────────────────────────────
#
# The data plane, before anything is broken. The request is the one the
# application itself makes: PostgREST authorises from the BEARER token,
# not from the cookie, so a request carrying only a cookie arrives as an
# anonymous caller and is refused.
#
# It asks for PROFILES, not for the fleet, and that is deliberate. The
# drill's own user is a vehicle owner, and an owner may only read the
# vehicles it is the registered owner of — so a fleet query would come
# back empty and the assertion would be testing the wrong thing. Every
# authenticated user may read its OWN profile
#
#     profiles_self_select: (id = current_app_user()) OR is_ops()
#
# so this asks for a row the drill is certain of being entitled to, and
# the answer has to contain that row's id. It is the whole path in one
# request: the bearer is verified, the GUC is set, the policy is
# applied, and the row comes back.
data_plane() {
  drill_http_as dplane GET "$(app_url "/rest/v1/profiles?select=id&limit=50")" \
    -H "Authorization: Bearer $DRILL_SESSION"
}

before_status="$(data_plane)"
if [[ "$before_status" == "200" ]]; then
  ok "the data plane answers before the restart (200)"
else
  fail "the data plane answered $before_status before the restart, expected 200: $(drill_as_body dplane)"
fi

if [[ "$(drill_as_body dplane)" == *"$DRILL_USER_ID"* ]]; then
  ok "the data plane is returning this drill's own row"
else
  bad "the data plane answered 200 but did not return this drill's own row: $(drill_as_body dplane)"
fi

# ── the restart ─────────────────────────────────────────────────────────────
echo
echo "== the database is restarted =="

restarted_at="$(date +%s)"
db_restart

recovered=0
for _ in $(seq 1 30); do
  if db_answers; then
    recovered=1
    break
  fi
  sleep 1
done
elapsed=$(( $(date +%s) - restarted_at ))

if [[ "$recovered" -eq 1 ]]; then
  ok "the database came back in ${elapsed}s"
else
  fail "the database did not come back within 30s"
fi

if [[ "$elapsed" -le 30 ]]; then
  ok "the recovery was inside the 30s budget (${elapsed}s)"
else
  bad "the recovery took ${elapsed}s, over the 30s budget"
fi

# ── the application ─────────────────────────────────────────────────────────
echo
echo "== the application comes back with it =="

if wait_for_app; then
  ok "the application is serving again"
else
  bad "the application did not come back after the database did"
fi

# The data plane is given a moment to reconnect: PostgREST holds its own
# connections to postgres, and the first request after a restart can land
# before it has re-established them.
after_status=""
for _ in $(seq 1 30); do
  after_status="$(data_plane)"
  [[ "$after_status" == "200" ]] && break
  sleep 1
done

if [[ "$after_status" == "200" ]]; then
  ok "the data plane answers again with the same session (200)"
else
  bad "the data plane answered $after_status after the restart, expected 200: $(drill_as_body dplane)"
fi

if [[ "$(drill_as_body dplane)" == *"$DRILL_USER_ID"* ]]; then
  ok "and it is returning this drill's own row"
else
  bad "the data plane answered 200 but did not return this drill's own row: $(drill_as_body dplane)"
fi

# ── the data is intact ──────────────────────────────────────────────────────
vehicle_after="$(sql_scalar "select registration from public.vehicles
                              where tenant_id = '$DRILL_TENANT_ID'")"
if [[ "$vehicle_after" == "$vehicle_before" ]]; then
  ok "the rows are intact across the restart ($vehicle_after)"
else
  bad "the vehicle before the restart was '$vehicle_before' and after it is '$vehicle_after'"
fi

# ── the policies still hold ─────────────────────────────────────────────────
echo
echo "== the row-level policies still hold =="

proof="$(rls_proof_path)" \
  || fail "the RLS proof could not be found — it is staged at /opt/brownhill/sql/portable-rls-proof.sql by fetch-runtime.sh"

proof_output=""
if proof_output="$(sql_file "$proof" 2>&1)"; then
  passes="$(printf '%s\n' "$proof_output" | grep -c 'PASS' || true)"
  ok "the RLS proof passed after the restart ($passes checks)"
else
  bad "the RLS proof failed after the restart — a policy has stopped enforcing"
  printf '%s\n' "$proof_output" | sed 's/^/    /'
fi

# ── the result ──────────────────────────────────────────────────────────────
echo
drill_result

echo
echo "Drill 02 passed. The database was restarted, it came back inside thirty seconds, the application is serving, and the data plane is answering again with the rows it had before."
echo OK
