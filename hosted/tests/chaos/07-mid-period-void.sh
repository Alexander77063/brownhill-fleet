#!/usr/bin/env bash
# hosted/tests/chaos/07-mid-period-void.sh
#
# Spec §5: an invoice voided mid-period. The reversal posts cleanly even when
# other postings exist in the same period.
#
# WHAT THIS USED TO BE
# -------------------
#
#     #!/usr/bin/env bash
#     # hosted/tests/chaos/07-mid-period-void.sh
#     # Spec §5: invoice voided mid-period. Asserts the reversal entry posts cleanly
#     # even when other postings exist in the same period.
#     set -euo pipefail
#     echo OK
#
# It asserted nothing and reported a pass. It was in the handover's monthly
# list as though the scenario were covered, and it covered nothing at all.
#
# WHAT IT DOES NOW
# ----------------
# The whole story the operator lives, end to end, on the real deployment:
#
#   1. The box raises the rent invoice BY ITSELF. /api/cron/generate-rent is
#      the only thing in the product that raises an invoice, and the only
#      thing that posts it to the ledger — so the drill proves the route is
#      reachable with the token and refuses without it, because a cron that
#      cannot be called raises nothing at all.
#
#   2. The invoice it raises belongs to the month the rent is FOR. The drill
#      creates an agreement that started in the PREVIOUS month, so the
#      invoice lands there — a month that is not the month the drill runs in.
#      That is the point: the correction has to land beside the document.
#
#   3. The operator finds the invoice is wrong and cancels it, over HTTP,
#      with a reason.
#
#   4. The reversal lands in THE INVOICE'S OWN MONTH — the previous month —
#      not the month the operator happened to click in, and not this month.
#      This is the property the whole feature exists for: last month's
#      revenue, its VAT and its receivables have to be right without anybody
#      remembering to reopen last month.
#
#   5. It posts CLEANLY alongside the postings already in that month. The
#      drill puts a second, unrelated posting in the same month first, and
#      that posting is untouched afterwards.
#
#   6. The reversal is the mirror: Dr Revenue, Dr VAT Output, Cr Trade
#      Debtors. And where the money has already been received, Cr Refunds
#      Payable — a liability, not a negative receivable.
#
#   7. A second void is refused with a conflict, and nothing is written.
#
# NOTHING HERE TOUCHES THE CUSTOMER'S
# -----------------------------------
# The drill builds its own tenant, with its own uuid, and deletes it on the
# way out — including when the drill fails half way through.
#
# THE RENT CRON IS GLOBAL, AND THAT IS FINE HERE
# ----------------------------------------------
# It bills every active agreement in the database, because that is what it is
# for. So running it during a drill may raise the box's own invoices a few
# days before their Monday batch. It does not CHANGE them: the invoice's
# number, its dates and its amount are derived from the agreement's start
# date and the week it bills, not from the moment the cron happened to run.
# The same invoice, with the same dates, a few days earlier in the calendar.
#
# The drill asserts on its OWN tenant only, and it treats another tenant's
# week failing to bill as what it is — somebody else's problem — rather than
# as this drill's failure.
set -uo pipefail

DRILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/drill-lib.sh
source "$DRILL_DIR/lib/drill-lib.sh"

cleanup() {
  drill_cleanup
}
trap cleanup EXIT

echo "Chaos 07: invoices voided mid-period, with other postings in the same month."

drill_setup

# ── the month the invoices belong to ────────────────────────────────────────
#
# The month BEFORE the one this drill runs in. The drill needs invoices that
# are NOT in the current month, because "the reversal lands in the invoice's
# own month" is only a property worth asserting when there is another month
# it could land in.
#
# UTC, because the product's own month is UTC: `todayISO()` and
# `periodOfDate()` both read UTC, so a drill that reasoned in local time would
# pick the wrong month for eight hours a day.
now_year="$(date -u +%Y)"
now_month="$(date -u +%m)"
prev_month=$(( 10#$now_month - 1 ))
prev_year="$now_year"
if [[ "$prev_month" -eq 0 ]]; then
  prev_month=12
  prev_year=$(( now_year - 1 ))
fi
VOID_PERIOD="$(printf '%04d-%02d' "$prev_year" "$prev_month")"
THIS_PERIOD="$(printf '%04d-%02d' "$now_year" "$now_month")"
note "the invoices will belong to $VOID_PERIOD; today is in $THIS_PERIOD"

# ── the token ───────────────────────────────────────────────────────────────
#
# The cron routes are behind a bearer token, and the token is the only thing
# standing in front of the job that raises invoices.
#
# It is looked for in three places, in order: the environment (CI sets it),
# the box's own secrets file, and the environment of the RUNNING application
# container. The last one is the same trick the drill library uses for the
# signing secret: reading it from the application that is running means the
# drill and the application cannot disagree — and a token signed with the
# wrong secret looks exactly like an application that refuses every request.
#
# If it is missing everywhere, the drill FAILS. It does not skip: "the box has
# no cron secret" is precisely the fault this drill exists to catch, and a
# drill that skips when the fault is present reports the fault as a pass.
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

DRILL_CRON_SECRET="$(resolve_cron_secret)"
if [[ -z "$DRILL_CRON_SECRET" ]]; then
  fail "there is no cron secret — set CRON_SECRET, or run this where /etc/brownhill/secrets/cron.env holds it"
fi

# ── the fixture ─────────────────────────────────────────────────────────────
#
# Its own tenant, its own operator, its own vehicle, its own driver, and an
# agreement that STARTED IN THE PREVIOUS MONTH.
#
# The rent cron bills ACTIVE agreements only, and the fixture creates a draft
# one — so the drill activates it. That is the only change it makes: the
# fixture's own figures (£120.00 gross, £100.00 net, £20.00 VAT a week) are
# what the drill asserts against later.
fixture_create "$VOID_PERIOD"

# The CURRENT month's period as well.
#
# The cron back-fills every week since the agreement started, and a week that
# has begun but not ended can fall in the current month. A week whose month
# has no period row cannot be posted — and the cron records that as a FAILURE
# against the drill's own agreement, which would make the drill report "the
# box could not bill the drill's week" when the truth is that the drill never
# opened the month.
#
# This is not a workaround. It is what the product does: a month is open
# while it is running. The drill opens the two months it needs, the same way
# the box's own calendar does.
if ! sql "insert into accounting.periods (tenant_id, year, month)
           values ('$DRILL_TENANT_ID', $now_year, $now_month)" >/dev/null; then
  fail "the current month's period could not be opened"
fi

if ! sql "update public.agreements
             set status = 'active'
           where tenant_id = '$DRILL_TENANT_ID'" >/dev/null; then
  fail "the drill's agreement could not be activated"
fi
ok "the drill's agreement is active, and started on $VOID_PERIOD-01"

DRILL_AGREEMENT_ID="$(sql_scalar "select id from public.agreements
                                    where tenant_id = '$DRILL_TENANT_ID'")"
[[ -n "$DRILL_AGREEMENT_ID" ]] || fail "the drill's agreement could not be found"

# The invoice the cron raises for the FIRST week of the agreement. The number
# is deterministic — INV-<the agreement's first eight characters>-W1 — and the
# week's period_start is the agreement's start_date, so this invoice is dated
# to the first of the previous month however the cron is run and whenever the
# drill is run.
DRILL_W1_NUMBER="INV-${DRILL_AGREEMENT_ID:0:8}-W1"
DRILL_W2_NUMBER="INV-${DRILL_AGREEMENT_ID:0:8}-W2"

mint_session

# ── 1. the cron refuses a call it should refuse ────────────────────────────
#
# The route is the only thing that raises an invoice. If it answered 200 to
# anybody, then anybody could raise invoices; if it answers 401 to the wrong
# token, the box's own timer is the only caller.

echo
echo "== the cron refuses a call it should refuse =="

drill_http GET "$(app_url "/api/cron/generate-rent")"

if [[ "$DRILL_HTTP_STATUS" == "401" ]]; then
  ok "the rent cron refuses a call with no token (401)"
else
  bad "the rent cron answered $DRILL_HTTP_STATUS to a call with no token, expected 401: $DRILL_HTTP_BODY"
fi

drill_http GET "$(app_url "/api/cron/generate-rent")" \
  -H "Authorization: Bearer not-the-real-secret"

if [[ "$DRILL_HTTP_STATUS" == "401" ]]; then
  ok "the rent cron refuses a call with the wrong token (401)"
else
  bad "the rent cron answered $DRILL_HTTP_STATUS to a call with the wrong token, expected 401: $DRILL_HTTP_BODY"
fi

# ── 2. the cron raises the invoice ──────────────────────────────────────────
#
# The drill's agreement started on the first of the previous month, so week
# one — and every week after it that has begun — belongs to that month or to
# this one. The drill wants the FIRST one, and it wants it posted.

echo
echo "== the box raises the rent invoice by itself =="

drill_http GET "$(app_url "/api/cron/generate-rent")" \
  -H "Authorization: Bearer $DRILL_CRON_SECRET"

cron_body="$DRILL_HTTP_BODY"

# The route answers 500 when a week could not be billed, and another tenant's
# week failing is not this drill's failure — it says so rather than pretending
# the box is healthy. What IS this drill's failure is the drill's own
# agreement not being billed.
if [[ "$DRILL_HTTP_STATUS" == "200" || "$DRILL_HTTP_STATUS" == "500" ]]; then
  if [[ "$cron_body" == *"\"agreementId\":\"$DRILL_AGREEMENT_ID\""* ]]; then
    bad "the rent cron could not bill the drill's own agreement: $cron_body"
  else
    ok "the rent cron ran, and the drill's own week was billed"
  fi
else
  fail "the rent cron answered $DRILL_HTTP_STATUS with the right token: $cron_body"
fi

DRILL_INVOICE_ID="$(sql_scalar "select id from public.invoices
                                   where tenant_id = '$DRILL_TENANT_ID'
                                     and number = '$DRILL_W1_NUMBER'")"
[[ -n "$DRILL_INVOICE_ID" ]] || fail "the rent cron raised no invoice for the drill's first week ($DRILL_W1_NUMBER)"

DRILL_INVOICE_ISSUED="$(sql_scalar "select issued_on from public.invoices where id = '$DRILL_INVOICE_ID'")"
DRILL_INVOICE_STATUS="$(sql_scalar "select status from public.invoices where id = '$DRILL_INVOICE_ID'")"
note "the invoice is $DRILL_W1_NUMBER, issued $DRILL_INVOICE_ISSUED, status $DRILL_INVOICE_STATUS"

if [[ "$DRILL_INVOICE_ISSUED" == "$VOID_PERIOD-01" ]]; then
  ok "the invoice is dated to the week it bills ($DRILL_INVOICE_ISSUED), not to the day the cron ran"
else
  bad "the invoice is dated $DRILL_INVOICE_ISSUED, not $VOID_PERIOD-01 — the invoice's date is the day the cron happened to run"
fi

# ── 3. the invoice is posted to the ledger ──────────────────────────────────
#
# Without this there is nothing to reverse, and the void would be a mark on
# a document rather than a correction to the books.
DRILL_POSTING_ID="$(sql_scalar "select je.id
                                 from accounting.journal_entries je
                                where je.tenant_id = '$DRILL_TENANT_ID'
                                  and je.source_type = 'invoice'
                                  and je.source_id = '$DRILL_INVOICE_ID'")"

if [[ -n "$DRILL_POSTING_ID" ]]; then
  ok "the rent cron posted the invoice to the ledger"
else
  fail "the rent cron raised the invoice but posted nothing to the ledger — the operator's books do not contain the rent they are billing"
fi

DRILL_POSTING_PERIOD="$(sql_scalar "select p.year || '-' || lpad(p.month::text, 2, '0')
                                      from accounting.journal_entries je
                                      join accounting.periods p on p.id = je.period_id
                                     where je.id = '$DRILL_POSTING_ID'")"
if [[ "$DRILL_POSTING_PERIOD" == "$VOID_PERIOD" ]]; then
  ok "the posting is in $VOID_PERIOD — the month the rent is for"
else
  bad "the posting is in '$DRILL_POSTING_PERIOD', not $VOID_PERIOD"
fi

# The invoice's own figures, read back rather than assumed.
DRILL_INVOICE_GROSS="$(sql_scalar "select gross_pence from public.invoices where id = '$DRILL_INVOICE_ID'")"
DRILL_INVOICE_NET="$(sql_scalar "select net_pence from public.invoices where id = '$DRILL_INVOICE_ID'")"
DRILL_INVOICE_VAT="$(sql_scalar "select vat_pence from public.invoices where id = '$DRILL_INVOICE_ID'")"
note "the invoice is $DRILL_INVOICE_GROSS gross, $DRILL_INVOICE_NET net, $DRILL_INVOICE_VAT VAT"

# ── 4. another posting, in the same month ───────────────────────────────────
#
# This is the "mid-period" half of the scenario. The reversal has to post
# cleanly into a month that already has postings in it — not into an empty
# one. The drill posts a second, unrelated entry into the same month and
# checks afterwards that it is untouched.
#
# It is a fee: Dr Bank (1200) 5000, Cr Revenue (4000) 5000. Nothing to do
# with the invoice, and the drill knows the figures it posted.
if ! sql >/dev/null 2>"$DRILL_TMP/other.err" <<SQL
begin;

insert into accounting.journal_entries
  (posted_at, period_id, description, source_type, source_id, posted_by_user_id, tenant_id)
select now(), p.id, 'CHAOS DRILL — an unrelated posting', 'manual_adjustment',
       gen_random_uuid(), '$DRILL_USER_ID', '$DRILL_TENANT_ID'
  from accounting.periods p
 where p.tenant_id = '$DRILL_TENANT_ID' and p.year = $prev_year and p.month = $prev_month;

insert into accounting.journal_lines
  (journal_id, account_id, debit_pence, credit_pence, tenant_id)
select je.id, coa.id, 5000, 0, '$DRILL_TENANT_ID'
  from accounting.journal_entries je, accounting.chart_of_accounts coa
 where je.tenant_id = '$DRILL_TENANT_ID'
   and je.description = 'CHAOS DRILL — an unrelated posting'
   and coa.code = '1200' and coa.tenant_id is null;

insert into accounting.journal_lines
  (journal_id, account_id, debit_pence, credit_pence, tenant_id)
select je.id, coa.id, 0, 5000, '$DRILL_TENANT_ID'
  from accounting.journal_entries je, accounting.chart_of_accounts coa
 where je.tenant_id = '$DRILL_TENANT_ID'
   and je.description = 'CHAOS DRILL — an unrelated posting'
   and coa.code = '4000' and coa.tenant_id is null;

commit;
SQL
then
  sed 's/^/    /' "$DRILL_TMP/other.err" >&2
  fail "the second posting could not be made"
fi

DRILL_OTHER_POSTING_ID="$(sql_scalar "select id from accounting.journal_entries
                                       where tenant_id = '$DRILL_TENANT_ID'
                                         and description = 'CHAOS DRILL — an unrelated posting'")"
if [[ -n "$DRILL_OTHER_POSTING_ID" ]]; then
  ok "a second, unrelated posting is in $VOID_PERIOD"
else
  fail "the second posting could not be found"
fi

DRILL_ENTRIES_BEFORE_VOID="$(journal_count_for "$VOID_PERIOD")"

# ── 5. the operator cancels the invoice ─────────────────────────────────────

echo
echo "== the operator cancels the invoice =="

drill_app POST "/api/v1/accounting/invoices/$DRILL_INVOICE_ID/void" \
  -H "content-type: application/json" \
  -d '{"reason":"raised against the wrong vehicle"}'

if [[ "$DRILL_HTTP_STATUS" == "200" ]]; then
  ok "the application accepted the void"
else
  fail "the application answered $DRILL_HTTP_STATUS to the void: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *'"outcome":"voided"'* ]]; then
  ok "the answer says the invoice was voided"
else
  bad "the answer does not say the invoice was voided: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *"\"period\":\"$VOID_PERIOD\""* ]]; then
  ok "the answer names $VOID_PERIOD — the invoice's own month, not this one"
else
  bad "the answer does not name $VOID_PERIOD: $DRILL_HTTP_BODY"
fi

DRILL_VOID_POSTING_ID="$(sql_scalar "select je.id
                                      from accounting.journal_entries je
                                     where je.tenant_id = '$DRILL_TENANT_ID'
                                       and je.source_type = 'invoice_void'
                                       and je.source_id = '$DRILL_INVOICE_ID'")"

if [[ -z "$DRILL_VOID_POSTING_ID" ]]; then
  fail "no reversal was posted — the invoice was marked void and left in the ledger"
fi
ok "the reversal was posted"

DRILL_VOID_PERIOD="$(sql_scalar "select p.year || '-' || lpad(p.month::text, 2, '0')
                                   from accounting.journal_entries je
                                   join accounting.periods p on p.id = je.period_id
                                  where je.id = '$DRILL_VOID_POSTING_ID'")"

if [[ "$DRILL_VOID_PERIOD" == "$VOID_PERIOD" ]]; then
  ok "the reversal is in $VOID_PERIOD — the invoice's own month, not the month the operator clicked in"
else
  bad "the reversal is in '$DRILL_VOID_PERIOD', not $VOID_PERIOD — the correction is not beside the document"
fi

if [[ "$DRILL_VOID_PERIOD" != "$THIS_PERIOD" ]]; then
  ok "the reversal is not in this month's books"
else
  bad "the reversal landed in the current month, which is the bug this feature exists to avoid"
fi

# ── 6. the reversal is the mirror ───────────────────────────────────────────
#
# Dr Revenue (4000) the net, Dr VAT Output (2200) the VAT, Cr Trade Debtors
# (1100) the gross. Anything else leaves the accounts wrong.
#
# The lines are read as ONE string, so an extra line or a missing one shows
# up as a difference rather than as three separate assertions that can each
# be satisfied by the wrong posting.
read_journal_lines() {
  sql_scalar "select coalesce(string_agg(coa.code || ':' || l.debit_pence || ':' || l.credit_pence, ',' order by coa.code), '')
                from accounting.journal_lines l
                join accounting.chart_of_accounts coa on coa.id = l.account_id
               where l.journal_id = '$1'"
}

DRILL_REVERSAL_LINES="$(read_journal_lines "$DRILL_VOID_POSTING_ID")"
EXPECTED_LINES="1100:0:$DRILL_INVOICE_GROSS,2200:$DRILL_INVOICE_VAT:0,4000:$DRILL_INVOICE_NET:0"

if [[ "$DRILL_REVERSAL_LINES" == "$EXPECTED_LINES" ]]; then
  ok "the reversal is the mirror: Cr Trade Debtors $DRILL_INVOICE_GROSS, Dr VAT Output $DRILL_INVOICE_VAT, Dr Revenue $DRILL_INVOICE_NET"
else
  bad "the reversal's lines are '$DRILL_REVERSAL_LINES', not '$EXPECTED_LINES'"
fi

# ── 7. the other posting is untouched ───────────────────────────────────────
#
# The reversal went into a month that already had postings in it, and it did
# not disturb them.
DRILL_OTHER_LINES="$(sql_scalar "select count(*) from accounting.journal_lines
                                   where journal_id = '$DRILL_OTHER_POSTING_ID'")"
DRILL_OTHER_AMOUNT="$(sql_scalar "select coalesce(sum(debit_pence), 0) from accounting.journal_lines
                                     where journal_id = '$DRILL_OTHER_POSTING_ID'")"

if [[ "${DRILL_OTHER_LINES:-0}" == "2" && "${DRILL_OTHER_AMOUNT:-0}" == "5000" ]]; then
  ok "the posting that was already in the month is untouched (2 lines, 5000 debited)"
else
  bad "the other posting now has ${DRILL_OTHER_LINES:-0} lines and ${DRILL_OTHER_AMOUNT:-0} debited — the reversal disturbed it"
fi

DRILL_ENTRIES_AFTER_VOID="$(journal_count_for "$VOID_PERIOD")"
if [[ "${DRILL_ENTRIES_AFTER_VOID:-0}" -eq $(( ${DRILL_ENTRIES_BEFORE_VOID:-0} + 1 )) ]]; then
  ok "the reversal added exactly one entry to $VOID_PERIOD"
else
  bad "$VOID_PERIOD holds ${DRILL_ENTRIES_AFTER_VOID:-0} entries, was ${DRILL_ENTRIES_BEFORE_VOID:-0} — the void added more than its own reversal"
fi

# ── 8. the invoice is void, and the audit row names the operator ────────────

DRILL_STATUS_AFTER="$(sql_scalar "select status from public.invoices where id = '$DRILL_INVOICE_ID'")"
if [[ "$DRILL_STATUS_AFTER" == "void" ]]; then
  ok "the invoice is marked void"
else
  bad "the invoice is '$DRILL_STATUS_AFTER', not void"
fi

DRILL_AUDIT="$(sql_scalar "select count(*) from accounting.audit_log
                             where tenant_id = '$DRILL_TENANT_ID'
                               and action = 'invoice_voided'
                               and entity_id = '$DRILL_INVOICE_ID'
                               and user_id = '$DRILL_USER_ID'")"
if [[ "${DRILL_AUDIT:-0}" -ge 1 ]]; then
  ok "the void left an audit row naming the operator"
else
  bad "the void left no 'invoice_voided' audit row for the operator"
fi

# The reason is TEXT, and it has spaces in it — so it is read with `sql_text`,
# not `sql_scalar`. `sql_scalar` strips every space, which turns "raised
# against the wrong vehicle" into "raisedagainstthewrongvehicle" and makes
# the comparison below fail against a product that stored it perfectly well.
DRILL_REASON="$(sql_text "select after->>'reason' from accounting.audit_log
                            where tenant_id = '$DRILL_TENANT_ID'
                              and action = 'invoice_voided'
                              and entity_id = '$DRILL_INVOICE_ID'")"
if [[ "$DRILL_REASON" == "raised against the wrong vehicle" ]]; then
  ok "the audit row carries the operator's reason"
else
  bad "the audit row's reason is '$DRILL_REASON'"
fi

# ── 9. a second void is refused ─────────────────────────────────────────────
#
# The button is not idempotent: a second void would be a second reversal.
# It is refused with a conflict, and nothing is written.
DRILL_LINES_BEFORE="$(sql_scalar "select count(*) from accounting.journal_lines l
                                      join accounting.journal_entries je on je.id = l.journal_id
                                     where je.tenant_id = '$DRILL_TENANT_ID'")"

drill_app POST "/api/v1/accounting/invoices/$DRILL_INVOICE_ID/void" \
  -H "content-type: application/json" \
  -d '{"reason":"and again"}'

if [[ "$DRILL_HTTP_STATUS" == "409" ]]; then
  ok "the second void was refused with 409 — a conflict, not a second reversal"
else
  bad "the second void was answered $DRILL_HTTP_STATUS, not 409: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *'invoice_already_void'* ]]; then
  ok "the refusal says the invoice is already void"
else
  bad "the refusal does not say why: $DRILL_HTTP_BODY"
fi

DRILL_LINES_AFTER="$(sql_scalar "select count(*) from accounting.journal_lines l
                                     join accounting.journal_entries je on je.id = l.journal_id
                                    where je.tenant_id = '$DRILL_TENANT_ID'")"
if [[ "${DRILL_LINES_AFTER:-0}" -eq "${DRILL_LINES_BEFORE:-0}" ]]; then
  ok "nothing was written by the refused void"
else
  bad "the ledger gained $(( ${DRILL_LINES_AFTER:-0} - ${DRILL_LINES_BEFORE:-0} )) line(s) — a refused void wrote something"
fi

# ── 10. an invoice the money has already been received for ──────────────────
#
# The second half of the scenario, and the one an operator meets most often:
# the customer has paid, and now the invoice has to be cancelled anyway.
#
# The money that has been received is not a negative receivable — the payment
# already credited Trade Debtors, so crediting it again would leave the
# account at minus the gross. What is true is that the operator owes the
# customer their money back, and that is a liability: 2120 Refunds Payable.
#
# The drill takes the SECOND week of the same agreement — also in the
# previous month — and matches a receipt to it through the reconciliation
# queue, which is how money reaches an invoice in this product.
#
# The receipt is dated the fifteenth of the previous month, so the payment's
# own posting lands in the previous month too, and the invoice's status
# becomes 'paid' before it is voided.

echo
echo "== an invoice the customer has already paid for =="

DRILL_W2_ID="$(sql_scalar "select id from public.invoices
                              where tenant_id = '$DRILL_TENANT_ID'
                                and number = '$DRILL_W2_NUMBER'")"
if [[ -z "$DRILL_W2_ID" ]]; then
  fail "the rent cron raised no invoice for the drill's second week ($DRILL_W2_NUMBER)"
fi

DRILL_W2_ISSUED="$(sql_scalar "select issued_on from public.invoices where id = '$DRILL_W2_ID'")"
if [[ "$DRILL_W2_ISSUED" == "$VOID_PERIOD-08" ]]; then
  ok "the second week's invoice is dated $DRILL_W2_ISSUED — in the previous month as well"
else
  bad "the second week's invoice is dated $DRILL_W2_ISSUED, not $VOID_PERIOD-08"
fi

fixture_add_open_bank_line "$VOID_PERIOD" "$DRILL_INVOICE_GROSS"

drill_app POST "/api/v1/accounting/reconcile" \
  --data-urlencode "bankTxId=$DRILL_BANK_TX_ID" \
  --data-urlencode "action=match" \
  --data-urlencode "invoiceId=$DRILL_W2_ID" \
  --data-urlencode "returnTo=/accounts/accounting/reconcile"

if [[ "$DRILL_HTTP_STATUS" == "303" ]]; then
  ok "the receipt was matched to the invoice"
else
  fail "the application answered $DRILL_HTTP_STATUS to the match: $DRILL_HTTP_BODY"
fi

DRILL_W2_STATUS="$(sql_scalar "select status from public.invoices where id = '$DRILL_W2_ID'")"
if [[ "$DRILL_W2_STATUS" == "paid" ]]; then
  ok "the invoice is paid"
else
  bad "the invoice is '$DRILL_W2_STATUS', not paid"
fi

drill_app POST "/api/v1/accounting/invoices/$DRILL_W2_ID/void" \
  -H "content-type: application/json" \
  -d '{"reason":"the vehicle was off the road that week"}'

if [[ "$DRILL_HTTP_STATUS" == "200" ]]; then
  ok "the application accepted the void of the paid invoice"
else
  fail "the application answered $DRILL_HTTP_STATUS to the void of the paid invoice: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *"\"refundPence\":\"$DRILL_INVOICE_GROSS\""* ]]; then
  ok "the answer says the operator owes $DRILL_INVOICE_GROSS back"
else
  bad "the answer does not carry the refund figure: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *"\"period\":\"$VOID_PERIOD\""* ]]; then
  ok "the paid invoice's reversal is in $VOID_PERIOD as well"
else
  bad "the paid invoice's reversal does not name $VOID_PERIOD: $DRILL_HTTP_BODY"
fi

DRILL_VOID2_POSTING_ID="$(sql_scalar "select je.id
                                       from accounting.journal_entries je
                                      where je.tenant_id = '$DRILL_TENANT_ID'
                                        and je.source_type = 'invoice_void'
                                        and je.source_id = '$DRILL_W2_ID'")"
if [[ -z "$DRILL_VOID2_POSTING_ID" ]]; then
  fail "no reversal was posted for the paid invoice"
fi

DRILL_VOID2_PERIOD="$(sql_scalar "select p.year || '-' || lpad(p.month::text, 2, '0')
                                    from accounting.journal_entries je
                                    join accounting.periods p on p.id = je.period_id
                                   where je.id = '$DRILL_VOID2_POSTING_ID'")"
if [[ "$DRILL_VOID2_PERIOD" == "$VOID_PERIOD" ]]; then
  ok "the paid invoice's reversal is in $VOID_PERIOD — the invoice's own month"
else
  bad "the paid invoice's reversal is in '$DRILL_VOID2_PERIOD', not $VOID_PERIOD"
fi

DRILL_VOID2_LINES="$(read_journal_lines "$DRILL_VOID2_POSTING_ID")"
EXPECTED_LINES2="2120:0:$DRILL_INVOICE_GROSS,2200:$DRILL_INVOICE_VAT:0,4000:$DRILL_INVOICE_NET:0"

if [[ "$DRILL_VOID2_LINES" == "$EXPECTED_LINES2" ]]; then
  ok "the money received became a refund owed: Cr Refunds Payable $DRILL_INVOICE_GROSS, and no negative receivable"
else
  bad "the paid invoice's reversal is '$DRILL_VOID2_LINES', not '$EXPECTED_LINES2'"
fi

# ── the result ──────────────────────────────────────────────────────────────

echo
drill_result

echo
echo "Drill 07 passed. The box raised the rent invoice by itself, the invoice was dated to the week it bills and posted to the ledger, the operator cancelled it over HTTP, the reversal landed in the invoice's own month alongside the postings already there, it was the mirror of the original, money already received became a refund owed, and a second void was refused without writing anything."
echo OK
