#!/usr/bin/env bash
# hosted/tests/accounting/accounting-smoke.sh
# End-to-end: the docker-compose stack is up (PR #79's hosted-tests matrix
# brings it up). This script exercises the full accounting flow:
#   1) Issue an invoice through the API
#   2) Confirm a 3-line journal entry was auto-posted
#   3) Confirm the payment for that invoice
#   4) Confirm a 2-line AR-clear journal entry
#   5) Run a P&L report and assert the net is non-zero
# Skips with exit 0 if the stack isn't reachable.
set -euo pipefail
if ! curl -fsS http://127.0.0.1:55431 -o /dev/null --max-time 3; then
  echo "Next not reachable at 127.0.0.1:55431; skipping"; exit 0
fi

ADMIN_TOKEN=$(curl -sk -c /tmp/cookies -b /tmp/cookies \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.test","password":"correct horse battery staple"}' \
  http://127.0.0.1:55431/api/v1/auth/local/signin | jq -r .token)
[[ -n "$ADMIN_TOKEN" && "$ADMIN_TOKEN" != "null" ]] || { echo "FAIL: cannot sign in"; exit 1; }

# 1) Issue an invoice
INV=$(curl -sk -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"customerId":"c1","items":[{"description":"Day rate","net":100000,"vatCode":"T1"}]}' \
  http://127.0.0.1:55431/api/v1/billing/invoices)
INV_ID=$(echo "$INV" | jq -r .id)
[[ -n "$INV_ID" && "$INV_ID" != "null" ]] || { echo "FAIL: invoice creation failed"; exit 1; }

# 2) Journal entry posted
J=$(curl -sk -H "authorization: Bearer $ADMIN_TOKEN" \
  "http://127.0.0.1:55431/api/v1/accounting/journal?source_type=invoice&source_id=$INV_ID")
COUNT=$(echo "$J" | jq '.lines | length')
[[ "$COUNT" == "3" ]] || { echo "FAIL: expected 3 journal lines, got $COUNT"; exit 1; }

# 3) Payment
PAY=$(curl -sk -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"invoiceId\":\"$INV_ID\",\"amountPence\":120000,\"source\":\"manual\"}" \
  http://127.0.0.1:55431/api/v1/billing/payments)
PAY_ID=$(echo "$PAY" | jq -r .id)

# 4) AR-clear journal entry
J2=$(curl -sk -H "authorization: Bearer $ADMIN_TOKEN" \
  "http://127.0.0.1:55431/api/v1/accounting/journal?source_type=payment&source_id=$PAY_ID")
COUNT2=$(echo "$J2" | jq '.lines | length')
[[ "$COUNT2" == "2" ]] || { echo "FAIL: expected 2 AR-clear lines, got $COUNT2"; exit 1; }

# 5) P&L report
PNL=$(curl -sk -H "authorization: Bearer $ADMIN_TOKEN" \
  "http://127.0.0.1:55431/api/v1/accounting/reports/pnl?from=2026-09-01&to=2026-09-30")
NET=$(echo "$PNL" | jq '.netResultPence // .net // 0')
[[ "$NET" != "0" && "$NET" != "null" ]] || { echo "FAIL: P&L net should not be zero"; exit 1; }

echo OK
