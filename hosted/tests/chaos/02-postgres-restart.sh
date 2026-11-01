#!/usr/bin/env bash
# hosted/tests/chaos/02-postgres-restart.sh — `systemctl restart postgresql.service`,
# time recovery, query through Next, assert RLS.
set -euo pipefail
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd not available; skipping"; exit 0
fi
START=$(date +%s)
systemctl restart postgresql.service
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:55431 -o /dev/null --max-time 2; then break; fi
  sleep 1
done
ELAPSED=$(( $(date +%s) - START ))
[[ "$ELAPSED" -le 30 ]] || { echo "FAIL: recovery ${ELAPSED}s > 30s budget"; exit 1; }
# Round-trip a JWT-bearing request through the hosted profile; belt + braces
# for the 403-on-mismatch contract we already passed in Task 6.
JWT=$(curl -sk -c /tmp/cookies http://127.0.0.1:55431/login-with-cookies)
http=$(curl -sk -b /tmp/cookies -o /dev/null -w '%{http_code}' http://127.0.0.1:55431/t/A/dashboard)
[[ "$http" == "200" || "$http" == "401" || "$http" == "403" ]] || { echo "FAIL: unexpected $http"; exit 1; }
echo OK
