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

# The operator status surface. Unauthenticated, it answers 403 — it exists,
# it is closed to the public.
check "/admin/status" 403 "the operator status surface"

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

if [[ "$fail" -eq 0 ]]; then
  echo OK
  exit 0
fi
exit 1
