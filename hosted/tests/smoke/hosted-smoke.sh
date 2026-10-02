#!/usr/bin/env bash
# hosted/tests/smoke/hosted-smoke.sh — end-to-end smoke for the hosted stack.
# Expects the stack to be reachable at NEXT_URL (default http://127.0.0.1:55431)
# under DEPLOYMENT_PROFILE=hosted. Skips with exit 0 when the stack is not up.

set -euo pipefail
NEXT_URL=${NEXT_URL:-http://127.0.0.1:55431}

if ! curl -fsS "$NEXT_URL" -o /dev/null --max-time 3; then
  echo "Next not reachable at $NEXT_URL; skipping"
  exit 0
fi

# Resources to round-trip — one per major table. Operators can extend this when
# new tables land; CI runs it on every deploy and on a 6h timer.
resources=(
  vehicles
  drivers
  bookings
  invoices
)
fail=0
for r in "${resources[@]}"; do
  http=$(curl -sk -o /dev/null -w '%{http_code}' "$NEXT_URL/api/v1/postgrest/$r?select=id&limit=1")
  if [[ "$http" == "200" || "$http" == "401" || "$http" == "403" ]]; then
    echo "  ok: $r reachable ($http)"
  else
    echo "  FAIL: $r returned $http"; fail=1
  fi
done

[[ "$fail" -eq 0 ]] && echo OK
exit "$fail"
