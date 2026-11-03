#!/usr/bin/env bash
# hosted/tests/smoke/hosted-smoke.sh — end-to-end smoke for the hosted stack.
#
# Expects the stack to be reachable at NEXT_URL (default http://127.0.0.1:55431)
# under DEPLOYMENT_PROFILE=hosted.
#
# Two things this used to do wrong, both of which made a broken deployment look
# like a healthy one:
#
#   * it SKIPPED (exit 0) when the stack was not up, so the job had nothing to
#     say and said nothing. A smoke test that cannot run has failed. It now
#     fails — unless ALLOW_SKIP=1, for a run where the stack genuinely is not
#     part of the job;
#   * it probed `/api/v1/postgrest/<table>`, which is not a route in this app.
#     The data plane is `/rest/v1/<table>`, rewritten to PostgREST by
#     next.config.ts. The old path answered 404, and 404 was not in the list
#     of "acceptable" answers, so every run failed — or, on a stack where the
#     rewrite was broken, the failure said nothing about the rewrite.

set -euo pipefail
NEXT_URL=${NEXT_URL:-http://127.0.0.1:55431}
ALLOW_SKIP=${ALLOW_SKIP:-0}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! curl -fsS "$NEXT_URL" -o /dev/null --max-time 5; then
  if [[ "$ALLOW_SKIP" == "1" ]]; then
    echo "Next not reachable at $NEXT_URL; skipping (ALLOW_SKIP=1)"
    exit 0
  fi
  echo "FAIL: Next is not reachable at $NEXT_URL" >&2
  exit 1
fi

fail=0

# check <path> <expected-status> <label>
check() {
  local path=$1 expect=$2 label=$3
  local http
  http=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 "$NEXT_URL$path")
  if [[ "$http" == "$expect" ]]; then
    echo "  ok: $label ($path → $http)"
  else
    echo "  FAIL: $label ($path → $http, expected $expect)"
    fail=1
  fi
}

# check_post <path> <expected-status> <label>
check_post() {
  local path=$1 expect=$2 label=$3
  local http
  http=$(curl -sk -X POST -o /dev/null -w '%{http_code}' --max-time 15 "$NEXT_URL$path")
  if [[ "$http" == "$expect" ]]; then
    echo "  ok: $label (POST $path → $http)"
  else
    echo "  FAIL: $label (POST $path → $http, expected $expect)"
    fail=1
  fi
}

# ── the application ──────────────────────────────────────────────────────────
# The root is not a landing page on the hosted profile. A build the customer
# already owns has nothing to sell at its front door, so an unauthenticated
# visitor is redirected to the sign-in page. 307 to /login is the contract;
# a 500 or a 404 here means the front door is broken.
root_status=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 "$NEXT_URL/")
root_target=$(curl -sk -o /dev/null -w '%{redirect_url}' --max-time 15 "$NEXT_URL/")
if [[ "$root_status" == "307" && "$root_target" == *"/login" ]]; then
  echo "  ok: the front door sends a visitor to sign in ($root_status → $root_target)"
else
  echo "  FAIL: the front door answered $root_status → '$root_target', expected 307 to /login"
  fail=1
fi

check "/login" 200 "the sign-in page"

# The first-run endpoint exists on a customer-operated box and demands a
# token. A 404 here means the profile gate is wrong — the endpoint is closed
# on a deployment where the customer needs it. It is POST-only: a GET answers
# 405, which says nothing about whether the endpoint works.
check_post "/api/v1/bootstrap" 401 "the first-run bootstrap endpoint"

# The operator status surface. There are two of them, and they close the box
# to the public in two different ways:
#
#   * the PAGE sits behind the admin layout, which requires the 'ops' role.
#     A visitor with no session is sent to sign in — 307 to /login, the same
#     contract as every other protected page in the app. Nothing is served.
#   * the API refuses outright — 403.
#
# The assertion used to expect a 403 from the page. The page has never
# returned one: the admin layout has required the 'ops' role since the
# initial import, and requireRole sends a visitor with no session to /login.
# The test was written expecting a contract the page never had — and it had
# never run in CI to say so, because the hosted-smoke job has never been
# green. A test that asserts a contract the code does not have is not
# coverage; it is a job that cannot pass.
admin_status=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 "$NEXT_URL/admin/status")
admin_target=$(curl -sk -o /dev/null -w '%{redirect_url}' --max-time 15 "$NEXT_URL/admin/status")
if [[ "$admin_status" == "307" && "$admin_target" == *"/login" ]]; then
  echo "  ok: the operator status page sends a visitor to sign in ($admin_status → $admin_target)"
else
  echo "  FAIL: the operator status page answered $admin_status → '$admin_target', expected 307 to /login"
  fail=1
fi

check "/api/admin/status" 403 "the operator status API"

# ── the data plane ──────────────────────────────────────────────────────────
# `/rest/v1` is rewritten to PostgREST. A broken rewrite — the wrong baked
# POSTGREST_URL, a PostgREST that is not answering — shows up here as a 5xx,
# and this is the assertion that catches it.
resources=(
  vehicles
  drivers
  bookings
  invoices
  agreements
)
for r in "${resources[@]}"; do
  http=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 "$NEXT_URL/rest/v1/$r?select=id&limit=1")
  case "$http" in
    200|401|403)
      echo "  ok: $r reachable through the rewrite ($http)"
      ;;
    404)
      echo "  FAIL: $r returned 404 — the /rest/v1 rewrite is not reaching PostgREST"
      fail=1
      ;;
    *)
      echo "  FAIL: $r returned $http"
      fail=1
      ;;
  esac
done

# ── the scheduled jobs ───────────────────────────────────────────────────────
#
# The box has to be able to run its own scheduled jobs, and for that the cron
# routes have to answer 401 to anybody without the token and 200 with it.
#
# This used to assert NOTHING about them, and the box had no secret and no
# timer — so every call would have answered 401 and the box would have billed
# nobody. That is not a background nicety: /api/cron/generate-rent is what
# raises the weekly rent invoice, and /api/cron/complete-agreements is what
# stops a finished agreement being billed for another week.
#
# The token comes from the environment. In CI it is the job's own variable;
# on the box it is the secrets file the installer wrote.
cron_secret="${CRON_SECRET:-}"
if [[ -z "$cron_secret" && -r /etc/brownhill/secrets/cron.env ]]; then
  cron_secret="$(sed -n 's/^CRON_SECRET=//p' /etc/brownhill/secrets/cron.env | head -1)"
fi

# The node to read the response with. The box pins its runtime under
# /opt/brownhill; everywhere else node is simply on the PATH.
if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [[ -x /opt/brownhill/node/bin/node ]]; then
  NODE=/opt/brownhill/node/bin/node
else
  NODE=""
fi

if [[ -z "$cron_secret" ]]; then
  echo "  FAIL: no cron secret — set CRON_SECRET, or run this on the box where /etc/brownhill/secrets/cron.env holds it"
  fail=1
else
  # a) Without a token the route must refuse.
  http=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 "$NEXT_URL/api/cron/generate-rent")
  if [[ "$http" == "401" ]]; then
    echo "  ok: the rent cron refuses a call with no token (401)"
  else
    echo "  FAIL: the rent cron answered $http to a call with no token, expected 401"
    fail=1
  fi

  # b) With the WRONG token it must refuse too — the token is the only gate.
  http=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "Authorization: Bearer not-the-real-secret" "$NEXT_URL/api/cron/generate-rent")
  if [[ "$http" == "401" ]]; then
    echo "  ok: the rent cron refuses a call with the wrong token (401)"
  else
    echo "  FAIL: the rent cron answered $http to a call with the wrong token, expected 401"
    fail=1
  fi

  # c) With the right token it must RUN — and run the whole way, not stop at
  #    the gate. The route answers 500 when a week could not be billed, so a
  #    200 here means every week it looked at was billed.
  #
  #    ONE request, not two: the status and the body are read from the same
  #    response, so the job is not run twice and the answer and the report
  #    cannot come from different runs.
  cron_response="$(curl -sk --max-time 240 -w '\n%{http_code}' \
    -H "Authorization: Bearer $cron_secret" "$NEXT_URL/api/cron/generate-rent")"
  cron_http="${cron_response##*$'\n'}"
  cron_body="${cron_response%$'\n'*}"

  if [[ "$cron_http" == "200" ]]; then
    echo "  ok: the rent cron ran with the right token (200)"
  else
    echo "  FAIL: the rent cron answered $cron_http with the right token, expected 200"
    echo "        $cron_body"
    fail=1
  fi

  # d) And it must report what it did, in the shape the operator's logs and
  #    the box's monitoring read.
  if [[ -z "$NODE" ]]; then
    echo "  skip: node is not on this machine, so the cron's report could not be read"
  else
    report="$("$NODE" -e '
      const body = JSON.parse(process.argv[1]);
      const wanted = ["ok","ran_on","rent_schedule_created","invoices_created","journal_entries_posted"];
      const missing = wanted.filter((k) => !(k in body));
      if (missing.length) { console.log("missing:" + missing.join(",")); process.exit(1); }
      if (body.ok !== true) { console.log("not-ok"); process.exit(1); }
      if (!Array.isArray(body.failures) || body.failures.length) {
        console.log("failures:" + JSON.stringify(body.failures));
        process.exit(1);
      }
      console.log("ok invoices=" + body.invoices_created + " journals=" + body.journal_entries_posted);
    ' "$cron_body" 2>&1 || true)"
    if [[ "$report" == ok\ invoices=* ]]; then
      echo "  ok: the rent cron reported its work ($report)"
    else
      echo "  FAIL: the rent cron did not report a clean run — $report"
      fail=1
    fi
  fi
fi

# ── the sign-in round trip ───────────────────────────────────────────────────
#
# Everything above asks the deployment whether it ANSWERS. Nothing above asks
# whether a PERSON can get in.
#
# The gap is specific. A deployment whose sign-in route is broken answers
# every unauthenticated assertion perfectly: the front door redirects to
# /login, /login renders, the data plane refuses politely, the cron refuses
# politely. Every one of those is a PASS. And the box looks fine, and the
# operator arrives on Monday morning, types their password, and gets "Those
# details do not match" — with a correct password, on a box that passes
# every other check.
#
# So the round trip walks the whole path: an account with a real password, a
# sign-in that answers 200 and hands back a session, a wrong password that is
# refused without saying which half was wrong, the session opening a page a
# visitor without one cannot open, the session reaching the data plane, and
# the correct password still working after a wrong attempt.
#
# It is a separate script because it needs the database — it builds its own
# tenant, signs in for real, and deletes what it made.
if bash "$SCRIPT_DIR/authenticated-round-trip.sh"; then
  echo "  ok: an operator signed in with a password and was let through the front door"
else
  echo "  FAIL: the sign-in round trip failed — see the output above"
  fail=1
fi

if [[ "$fail" -eq 0 ]]; then
  echo OK
  exit 0
fi
exit 1
