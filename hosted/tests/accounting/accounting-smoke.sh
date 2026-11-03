#!/usr/bin/env bash
# hosted/tests/accounting/accounting-smoke.sh
#
# Gate 6 of the acceptance suite: the accounting module, end to end, on the
# deployment that is being accepted.
#
# WHAT THIS USED TO BE
# --------------------
#
#     #!/usr/bin/env bash
#     set -euo pipefail
#     if ! curl -fsS http://127.0.0.1:55431 -o /dev/null --max-time 3; then
#       echo "Next not reachable at 127.0.0.1:55431; skipping"; exit 0
#     fi
#     ADMIN_TOKEN=$(curl ... -d '{"email":"owner@example.test","password":"correct horse battery staple"}' ...)
#     INV=$(curl ... /api/v1/billing/invoices)
#     J=$(curl  ... /api/v1/accounting/journal?source_type=invoice&source_id=$INV_ID)
#     PAY=$(curl ... /api/v1/billing/payments)
#     PNL=$(curl ... /api/v1/accounting/reports/pnl?from=2026-09-01&to=2026-09-30)
#     echo OK
#
# A gate that could not run, and that asserted nothing about the product.
#
# It had four faults, and each of them alone was enough to make the gate
# worthless:
#
#   1. IT SKIPPED WITH EXIT 0 when the stack was not up. A gate that cannot
#      run has FAILED. The deployment it was supposed to clear was reported
#      as cleared. This is the same sin as the hosted-smoke's old skip, and
#      it was fixed there; it was still here.
#
#   2. IT CALLED ROUTES THAT DO NOT EXIST. There is no /api/v1/billing/
#      invoices, no /api/v1/accounting/journal, no /api/v1/billing/payments,
#      and /api/v1/accounting/reports/pnl is a route with a QUERY STRING,
#      not a path. Every one of those calls answered 404, and the script
#      read a 404 body as if it were data.
#
#   3. IT SIGNED IN WITH A HARDCODED PASSWORD, and the password was the one
#      the repository had already published and the handover had already
#      removed. A gate that needs a credential nobody has cannot run on a
#      fresh box, and a gate with a credential in it is a gate that leaks.
#
#   4. IT ASSERTED ALMOST NOTHING. The one assertion that could have failed
#      — "the P&L net is not zero" — read `.netResultPence // .net // 0`
#      out of a 404 body, which is 0, and then complained. It did not check
#      that the invoice was raised, that the ledger was posted, that the
#      money was received, or that the books balanced.
#
# WHAT THIS PROVES NOW
# ---------------------
# Against the real deployment, with the application's own timer, its own
# routes and its own database:
#
#   1. the rent cron raises the week's invoice and POSTS IT TO THE LEDGER
#      — three lines: Dr Trade Debtors, Cr Revenue, Cr VAT Output;
#   2. the posting BALANCES — debits equal credits, in the books;
#   3. a receipt, matched through the reconciliation queue, becomes a
#      payment, an allocation, an AR-clear posting, and a PAID invoice;
#   4. the profit and loss READS those books and answers 200 with JSON —
#      with the money as strings, because a BigInt cannot be JSON;
#   5. the invoice can be VOIDED, and the reversal posts against the
#      invoice's own month;
#   6. the void leaves an audit row naming the operator.
#
# Point 4 is the guard that would have caught the reporting API answering
# 500 "Do not know how to serialize a BigInt" on every request. Point 1 is
# the guard that catches the cron being refused before its own gate runs.
#
# NOTHING OF THE CUSTOMER'S IS TOUCHED
# -------------------------------------
# The smoke builds its own tenant, with its own uuid, and deletes it on the
# way out — including when it fails half way through. It signs in with a
# session minted by the application's own signer, not with a password.
set -uo pipefail

SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../chaos/lib/drill-lib.sh
source "$SMOKE_DIR/../chaos/lib/drill-lib.sh"

# ── the period ─────────────────────────────────────────────────────────────
#
# The current UTC month, so the rent the cron bills belongs to a month that is
# OPEN — which is what the box's own calendar does. Overridable, because a
# drill that cannot be pointed at a chosen month cannot be replayed.
SMOKE_PERIOD="${ACCOUNTING_SMOKE_PERIOD:-$(date -u +%Y-%m)}"
export DRILL_PERIOD="$SMOKE_PERIOD"

echo "Accounting smoke: the accounting module, end to end, in $SMOKE_PERIOD."

# ── the deployment ──────────────────────────────────────────────────────────
#
# `drill_setup` FAILS when there is no deployment to drive. That is the whole
# point of the rewrite: the old script skipped with exit 0, so a box with no
# application was a box that passed.
drill_setup
wait_for_app || fail "the application is not answering at $DRILL_APP_URL"

# The cron secret, looked for in the same three places the drills look:
# the environment, the box's own secrets file, and the environment of the
# RUNNING application. If it is nowhere, the smoke FAILS — "the box has no
# cron secret" is exactly the fault this gate exists to catch.
resolve_cron_secret() {
  if [[ -n "${CRON_SECRET:-}" ]]; then
    printf '%s' "$CRON_SECRET"
    return
  fi
  local found
  if [[ -r /etc/brownhill/secrets/cron.env ]]; then
    found="$(sed -n 's/^CRON_SECRET=//p' /etc/brownhill/secrets/cron.env | head -1)"
    if [[ -n "$found" ]]; then printf '%s' "$found"; return; fi
  fi
  if [[ "$DRILL_APP_CONTROL" == "compose" && -n "$DRILL_NEXT_CID" ]]; then
    found="$(docker inspect "$DRILL_NEXT_CID" \
      --format '{{range .Config.Env}}{{println .}}{{end}}' \
      | sed -n 's/^CRON_SECRET=//p' | head -1)"
    if [[ -n "$found" ]]; then printf '%s' "$found"; return; fi
  fi
  printf ''
}
SMOKE_CRON_SECRET="$(resolve_cron_secret)"
[[ -n "$SMOKE_CRON_SECRET" ]] \
  || fail "there is no cron secret — set CRON_SECRET, or run this where /etc/brownhill/secrets/cron.env holds it"

# ── the fixture ─────────────────────────────────────────────────────────────
#
# Its own tenant, its own operator, its own vehicle, driver and agreement,
# and an open period for the month under test.
#
# The fixture creates a DRAFT agreement; the rent cron bills ACTIVE ones, so
# the smoke activates it. That is the only change it makes.
fixture_create "$SMOKE_PERIOD"

sql "update public.agreements set status = 'active'
      where tenant_id = '$DRILL_TENANT_ID'" >/dev/null \
  || fail "the smoke's agreement could not be activated"

SMOKE_AGREEMENT_ID="$(sql_scalar "select id from public.agreements
                                    where tenant_id = '$DRILL_TENANT_ID'")"
[[ -n "$SMOKE_AGREEMENT_ID" ]] || fail "the smoke's agreement could not be found"

mint_session

# The cleanup is the smoke's own: it deletes the fixture and nothing else.
# The shared `drill_cleanup` also stops the HMRC stub, and this smoke never
# points the application at it — stopping a service the next test needs, to
# undo something this test never did, is not a cleanup.
cleanup() {
  fixture_destroy || {
    echo "FAIL: the accounting smoke left data behind. It does not count as a pass." >&2
    exit 1
  }
  rm -rf "$DRILL_TMP"
}
trap cleanup EXIT

# ── 1. the box raises the rent invoice by itself ────────────────────────────
echo
echo "== the box raises the rent invoice and posts it to the ledger =="

drill_http GET "$(app_url "/api/cron/generate-rent")" \
  -H "Authorization: Bearer $SMOKE_CRON_SECRET"

# The route answers 500 when a week could not be billed. Another tenant's
# week failing is not this smoke's failure; what IS its failure is its own
# agreement not being billed.
if [[ "$DRILL_HTTP_STATUS" == "200" || "$DRILL_HTTP_STATUS" == "500" ]]; then
  if [[ "$DRILL_HTTP_BODY" == *"\"agreementId\":\"$SMOKE_AGREEMENT_ID\""* ]]; then
    fail "the rent cron could not bill the smoke's own agreement: $DRILL_HTTP_BODY"
  fi
  ok "the rent cron ran, and the smoke's own week was billed"
else
  fail "the rent cron answered $DRILL_HTTP_STATUS with the right token: $DRILL_HTTP_BODY"
fi

# The cron's invoices are numbered INV-<the agreement's first eight
# characters>-W<n>. The fixture's own invoice is numbered CHAOS-INV-…, so
# this finds the cron's work and not the fixture's.
SMOKE_INVOICE_ID="$(sql_scalar "select id from public.invoices
                                  where tenant_id = '$DRILL_TENANT_ID'
                                    and number like 'INV-%-W%'
                                  order by issued_on
                                  limit 1")"
[[ -n "$SMOKE_INVOICE_ID" ]] || fail "the rent cron raised no invoice for the smoke's agreement"

SMOKE_INVOICE_NUMBER="$(sql_scalar "select number from public.invoices where id = '$SMOKE_INVOICE_ID'")"
SMOKE_INVOICE_GROSS="$(sql_scalar "select gross_pence from public.invoices where id = '$SMOKE_INVOICE_ID'")"
SMOKE_INVOICE_NET="$(sql_scalar "select net_pence from public.invoices where id = '$SMOKE_INVOICE_ID'")"
SMOKE_INVOICE_VAT="$(sql_scalar "select vat_pence from public.invoices where id = '$SMOKE_INVOICE_ID'")"
note "the invoice is $SMOKE_INVOICE_NUMBER, $SMOKE_INVOICE_GROSS gross, $SMOKE_INVOICE_NET net, $SMOKE_INVOICE_VAT VAT"

if [[ "${SMOKE_INVOICE_GROSS:-0}" -gt 0 ]]; then
  ok "the invoice was raised, with money in it"
else
  fail "the invoice was raised with no gross: '$SMOKE_INVOICE_GROSS'"
fi

# The posting. Three lines: Dr Trade Debtors (gross), Cr Revenue (net),
# Cr VAT Output (VAT). The source is the invoice.
SMOKE_POSTING_ID="$(sql_scalar "select id from accounting.journal_entries
                                  where tenant_id = '$DRILL_TENANT_ID'
                                    and source_type = 'invoice'
                                    and source_id = '$SMOKE_INVOICE_ID'")"
if [[ -z "$SMOKE_POSTING_ID" ]]; then
  fail "the invoice was raised but NOTHING was posted to the ledger"
fi
ok "the invoice is posted to the ledger"

SMOKE_POSTING_LINES="$(sql_scalar "select count(*) from accounting.journal_lines
                                    where journal_id = '$SMOKE_POSTING_ID'")"
if [[ "$SMOKE_POSTING_LINES" == "3" ]]; then
  ok "the posting has three lines — debtors, revenue, VAT"
else
  fail "the posting has $SMOKE_POSTING_LINES line(s), expected 3"
fi

SMOKE_DEBITS="$(sql_scalar "select coalesce(sum(debit_pence),0) from accounting.journal_lines
                              where journal_id = '$SMOKE_POSTING_ID'")"
SMOKE_CREDITS="$(sql_scalar "select coalesce(sum(credit_pence),0) from accounting.journal_lines
                               where journal_id = '$SMOKE_POSTING_ID'")"
if [[ "$SMOKE_DEBITS" == "$SMOKE_CREDITS" && "${SMOKE_DEBITS:-0}" -gt 0 ]]; then
  ok "the posting balances — $SMOKE_DEBITS in, $SMOKE_CREDITS out"
else
  fail "the posting does not balance: $SMOKE_DEBITS in, $SMOKE_CREDITS out"
fi

# ── 2. money arrives ────────────────────────────────────────────────────────
echo
echo "== a receipt is matched to the invoice =="

fixture_add_open_bank_line "$SMOKE_PERIOD" "$SMOKE_INVOICE_GROSS"

drill_app POST "/api/v1/accounting/reconcile" \
  --data-urlencode "bankTxId=$DRILL_BANK_TX_ID" \
  --data-urlencode "action=match" \
  --data-urlencode "invoiceId=$SMOKE_INVOICE_ID" \
  --data-urlencode "returnTo=/accounts/accounting/reconcile"

if [[ "$DRILL_HTTP_STATUS" == "303" ]]; then
  ok "the receipt was matched to the invoice"
else
  fail "the application answered $DRILL_HTTP_STATUS to the match: $DRILL_HTTP_BODY"
fi

SMOKE_PAYMENT_ID="$(sql_scalar "select id from public.payments
                                 where tenant_id = '$DRILL_TENANT_ID'
                                   and status = 'confirmed'
                                   and agreement_id = '$SMOKE_AGREEMENT_ID'
                                 limit 1")"
if [[ -n "$SMOKE_PAYMENT_ID" ]]; then
  ok "the money became a confirmed payment"
else
  fail "the receipt was matched but no payment was recorded"
fi

SMOKE_ALLOCATED="$(sql_scalar "select coalesce(sum(amount_pence),0) from public.payment_allocations
                                  where invoice_id = '$SMOKE_INVOICE_ID'")"
if [[ "${SMOKE_ALLOCATED:-0}" == "$SMOKE_INVOICE_GROSS" ]]; then
  ok "the payment is allocated to the invoice, in full"
else
  fail "the payment allocated $SMOKE_ALLOCATED against a gross of $SMOKE_INVOICE_GROSS"
fi

SMOKE_STATUS="$(sql_scalar "select status from public.invoices where id = '$SMOKE_INVOICE_ID'")"
if [[ "$SMOKE_STATUS" == "paid" ]]; then
  ok "the invoice is paid"
else
  fail "the invoice is '$SMOKE_STATUS', not paid"
fi

# The AR-clear posting: Dr Bank, Cr Trade Debtors. Two lines, and it is what
# settles the receivable.
#
# It is found through the bank line's own `posted_journal_id`, which is the
# link the reconcile route wrote. The posting's own source type is `payment`
# — `bank_receipt` is the source type the BANK IMPORT route uses when it
# matches on its own, and there the source id is the bank line. Here the
# operator did the matching, so the payment is what was posted.
SMOKE_AR_POSTING="$(sql_scalar "select posted_journal_id
                                  from accounting.bank_transactions
                                 where id = '$DRILL_BANK_TX_ID'
                                   and tenant_id = '$DRILL_TENANT_ID'")"
if [[ -z "$SMOKE_AR_POSTING" || "$SMOKE_AR_POSTING" == "null" ]]; then
  fail "the receipt was matched but nothing was posted for the bank line"
fi
ok "the bank line points at the posting it produced"

# And the posting says what it did: £120.00 into the bank, £120.00 out of
# trade debtors. The line is read as account-code:debit:credit.
SMOKE_AR_LINES="$(sql_scalar "select coalesce(string_agg(coa.code || ':' || l.debit_pence || ':' || l.credit_pence, ',' order by coa.code), '')
                                  from accounting.journal_lines l
                                  join accounting.chart_of_accounts coa on coa.id = l.account_id
                                 where l.journal_id = '$SMOKE_AR_POSTING'")"
SMOKE_AR_EXPECTED="1100:0:$SMOKE_INVOICE_GROSS,1200:$SMOKE_INVOICE_GROSS:0"
if [[ "$SMOKE_AR_LINES" == "$SMOKE_AR_EXPECTED" ]]; then
  ok "the receipt cleared the receivable: Dr Bank, Cr Trade Debtors"
else
  fail "the AR-clear posting is '$SMOKE_AR_LINES', expected '$SMOKE_AR_EXPECTED'"
fi

# ── 3. the books read back ──────────────────────────────────────────────────
#
# The reporting API. It answers 200 and the money is a STRING — a BigInt
# cannot be JSON, and before the wire boundary was fixed every one of these
# four routes answered 500 "Do not know how to serialize a BigInt".
echo
echo "== the books read back =="

SMOKE_FROM="$SMOKE_PERIOD-01"
SMOKE_TO="$(date -u -d "+2 days" +%Y-%m-%d 2>/dev/null || date -u -v+2d +%Y-%m-%d)"

drill_app GET "/api/v1/accounting/reports/pnl?from=$SMOKE_FROM&to=$SMOKE_TO"

if [[ "$DRILL_HTTP_STATUS" != "200" ]]; then
  fail "the profit and loss answered $DRILL_HTTP_STATUS, expected 200: $DRILL_HTTP_BODY"
fi

SMOKE_PNL_VERDICT="$(printf '%s' "$DRILL_HTTP_BODY" | "$DRILL_NODE" -e '
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { raw += c; });
  process.stdin.on("end", () => {
    let b;
    try { b = JSON.parse(raw); }
    catch { console.log("not-json"); return; }
    const net = b.netResultPence;
    if (typeof net !== "string") { console.log("net-not-a-string:" + typeof net); return; }
    if (net === "0") { console.log("net-zero"); return; }
    const codes = (Array.isArray(b.rows) ? b.rows : []).map((r) => r.accountCode);
    if (!codes.includes("4000")) { console.log("no-revenue-row:" + codes.join(",")); return; }
    console.log("ok:" + net);
  });
')"

if [[ "$SMOKE_PNL_VERDICT" == ok:* ]]; then
  ok "the profit and loss reads the books, with the money as a string (net ${SMOKE_PNL_VERDICT#ok:})"
else
  fail "the profit and loss is wrong: $SMOKE_PNL_VERDICT — $DRILL_HTTP_BODY"
fi

# ── 4. the invoice can be cancelled ─────────────────────────────────────────
echo
echo "== the invoice is voided, and the reversal posts =="

SMOKE_ENTRIES_BEFORE="$(journal_count_for "$SMOKE_PERIOD")"

drill_app POST "/api/v1/accounting/invoices/$SMOKE_INVOICE_ID/void" \
  -H "content-type: application/json" \
  -d '{"reason":"the vehicle was off the road that week"}'

if [[ "$DRILL_HTTP_STATUS" == "200" ]]; then
  ok "the application accepted the void"
else
  fail "the application answered $DRILL_HTTP_STATUS to the void: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *'"outcome":"voided"'* ]]; then
  ok "the answer says the invoice was voided"
else
  fail "the answer does not say the invoice was voided: $DRILL_HTTP_BODY"
fi

# The invoice was paid, so the money received becomes a refund OWED — a
# liability, not a negative receivable.
if [[ "$DRILL_HTTP_BODY" == *"\"refundPence\":\"$SMOKE_INVOICE_GROSS\""* ]]; then
  ok "the answer says the operator owes $SMOKE_INVOICE_GROSS back"
else
  fail "the answer does not carry the refund figure: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *"\"period\":\"$SMOKE_PERIOD\""* ]]; then
  ok "the reversal is in the invoice's own month ($SMOKE_PERIOD)"
else
  fail "the reversal does not name $SMOKE_PERIOD: $DRILL_HTTP_BODY"
fi

SMOKE_VOID_POSTING="$(sql_scalar "select je.id
                                  from accounting.journal_entries je
                                 where je.tenant_id = '$DRILL_TENANT_ID'
                                   and je.source_type = 'invoice_void'
                                   and je.source_id = '$SMOKE_INVOICE_ID'")"
if [[ -n "$SMOKE_VOID_POSTING" ]]; then
  ok "the reversal was posted"
else
  fail "the invoice was marked void and left in the ledger — no reversal"
fi

SMOKE_ENTRIES_AFTER="$(journal_count_for "$SMOKE_PERIOD")"
if [[ "${SMOKE_ENTRIES_AFTER:-0}" -eq $(( ${SMOKE_ENTRIES_BEFORE:-0} + 1 )) ]]; then
  ok "the void added exactly one posting to $SMOKE_PERIOD"
else
  bad "$SMOKE_PERIOD holds $SMOKE_ENTRIES_AFTER entries, was $SMOKE_ENTRIES_BEFORE — the void added more than its own reversal"
fi

SMOKE_STATUS="$(sql_scalar "select status from public.invoices where id = '$SMOKE_INVOICE_ID'")"
if [[ "$SMOKE_STATUS" == "void" ]]; then
  ok "the invoice is marked void"
else
  bad "the invoice is '$SMOKE_STATUS', not void"
fi

SMOKE_AUDIT="$(sql_scalar "select count(*) from accounting.audit_log
                             where tenant_id = '$DRILL_TENANT_ID'
                               and action = 'invoice_voided'
                               and entity_id = '$SMOKE_INVOICE_ID'")"
if [[ "${SMOKE_AUDIT:-0}" -gt 0 ]]; then
  ok "the void left an audit row"
else
  bad "the void left no 'invoice_voided' audit row"
fi

# ── the result ──────────────────────────────────────────────────────────────
echo
echo "The accounting module bills rent on its own, posts it to the ledger, balances it, takes the money through the reconciliation queue, reads the books back over the API, and cancels an invoice with a reversal that lands in the invoice's own month — all on this deployment, with this deployment's own timer."

drill_result
