#!/usr/bin/env bash
set -euo pipefail
# hosted/tests/hosted-bootstrap-endpoint.sh
# End-to-end: boots the full stack via hosted/dev/docker-compose.yml (Task 10),
# signs a well-formed bootstrap request with the BOOTSTRAP_TOKEN, exercises the
# 401 (bad sig) / 200 (good sig) / 410 (replay) contract.

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not present; skipping hosted/tests/hosted-bootstrap-endpoint.sh"
  exit 0
fi

docker compose -f hosted/dev/docker-compose.yml up -d
sleep 5

BOOTSTRAP_TOKEN=$(grep ^BOOTSTRAP_TOKEN hosted/dev/.secrets/bootstrap.env | cut -d= -f2)
NOW=$(date +%s)
BODY='{"displayName":"Test Owner","fullName":"Test Owner","businessName":"Brownhill Test","email":"owner@example.test","password":"correct horse battery staple"}'
SIG=$(printf 'POST/api/v1/bootstrap'"$NOW""$BODY" | openssl dgst -sha256 -hmac "$BOOTSTRAP_TOKEN" | awk '{print $2}')

# Bad sig → 401
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "x-bootstrap-t: $NOW" -H "x-bootstrap-sig: deadbeef" -H 'content-type: application/json' \
  --data "$BODY" http://127.0.0.1:55431/api/v1/bootstrap)
[ "$code" = "401" ] || { echo "FAIL: bad sig returned $code"; exit 1; }

# Good sig → 200
RESP=$(curl -s -X POST -H "x-bootstrap-t: $NOW" -H "x-bootstrap-sig: $SIG" -H 'content-type: application/json' --data "$BODY" http://127.0.0.1:55431/api/v1/bootstrap)
echo "$RESP" | grep -q '"ok":true' || { echo "FAIL: no ok in $RESP"; exit 1; }

# Replay → 410
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "x-bootstrap-t: $NOW" -H "x-bootstrap-sig: $SIG" -H 'content-type: application/json' \
  --data "$BODY" http://127.0.0.1:55431/api/v1/bootstrap)
[ "$code" = "410" ] || { echo "FAIL: replay returned $code"; exit 1; }

docker compose -f hosted/dev/docker-compose.yml down
echo OK
