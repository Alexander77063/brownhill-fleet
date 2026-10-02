#!/usr/bin/env bash
# hosted/tests/chaos/06-period-close-with-open-bank.sh
# Spec §5: period close with open bank transactions shows a warning + requires
# double-confirm. Per-tenant scope: pass TENANT_ID env var to target a specific
# tenant; otherwise operates on the first tenant the script can find.
set -euo pipefail
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd not available; skipping"; exit 0
fi

# Resolve the target tenant (env override or first available)
if [[ -z "${TENANT_ID:-}" ]]; then
  TENANT_ID=$(sudo -u postgres /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -tAc \
    "select id::text from public.tenants order by created_at limit 1" 2>/dev/null || echo "")
fi
if [[ -z "$TENANT_ID" ]]; then
  echo "no TENANT_ID and no tenants in the DB; skipping"; exit 0
fi
echo "Chaos 06: tenant_id=$TENANT_ID"

# Find a bank account for THIS tenant (the closest equivalent to "the bank's
# bank account id" in the per-tenant world)
BANK_ACCOUNT_ID=$(sudo -u postgres /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -tAc \
  "select id::text from accounting.bank_accounts where tenant_id = '${TENANT_ID}'::uuid limit 1")
BANK_IMPORT_ID=$(sudo -u postgres /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -tAc \
  "select id::text from accounting.bank_imports where tenant_id = '${TENANT_ID}'::uuid limit 1")
if [[ -z "$BANK_ACCOUNT_ID" ]] || [[ -z "$BANK_IMPORT_ID" ]]; then
  echo "no bank account or import for tenant; skipping"; exit 0
fi

# Insert one open bank transaction for THIS tenant so the queue has work.
sudo -u postgres /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -c \
  "insert into accounting.bank_transactions(bank_import_id, bank_account_id, tenant_id, posted_at, amount_pence, description, status)
   values ('${BANK_IMPORT_ID}'::uuid, '${BANK_ACCOUNT_ID}'::uuid, '${TENANT_ID}'::uuid,
           now(), 12345, 'TEST OPEN TX', 'unmatched')"

# Hit the period-close UI without confirm; expect 200 with the warning.
http=$(curl -sk -o /tmp/cp1.html -w '%{http_code}' -X POST \
  -d '' "https://127.0.0.1/admin/accounting/periods/close?tenant=${TENANT_ID}")
[[ "$http" == "200" ]] || { echo "FAIL: close-page should return 200 with open tx warning"; exit 1; }
grep -q 'open bank transactions' /tmp/cp1.html || \
  { echo "FAIL: warning did not render"; exit 1; }

# Confirm THIS TENANT's period is still open in the DB.
state=$(sudo -u postgres /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -tAc \
  "select (closed_at is null)::text from accounting.periods where tenant_id = '${TENANT_ID}'::uuid order by year desc, month desc limit 1")
[[ "$state" == "t" ]] || { echo "FAIL: period closed without double-confirm"; exit 1; }

# Hit the period-close UI WITH confirm=true; expect 200 + the DB transition.
http=$(curl -sk -o /dev/null -w '%{http_code}' -X POST \
  -d "confirm=true&tenant=${TENANT_ID}" "https://127.0.0.1/admin/accounting/periods/close")
[[ "$http" == "200" ]] || { echo "FAIL: close with double-confirm should be 200"; exit 1; }

state=$(sudo -u postgres /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -tAc \
  "select (closed_at is not null)::text from accounting.periods where tenant_id = '${TENANT_ID}'::uuid order by year desc, month desc limit 1")
[[ "$state" == "t" ]] || { echo "FAIL: period should be closed after double-confirm"; exit 1; }

# Attempt to post a journal entry to the closed period — expect rejection (409).
http=$(curl -sk -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' \
  -d '{"invoiceId":"closed-period-test","net":100,"vat":20,"gross":120,"vatCodeId":"T1","chartOfAccounts":{"ar":"1100-id","revenue":"4000-id","vatOutput":"2200-id"}}' \
  "https://127.0.0.1/api/v1/accounting/${TENANT_ID}/journal/test-post")
[[ "$http" == "409" ]] || { echo "FAIL: posting to closed period should be 409; got $http"; exit 1; }

echo OK
