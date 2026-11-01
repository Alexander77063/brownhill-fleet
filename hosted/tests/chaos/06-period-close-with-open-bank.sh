#!/usr/bin/env bash
# hosted/tests/chaos/06-period-close-with-open-bank.sh
#
# Spec §5: a period close with open bank transactions shows a warning and
# requires a double-confirm.
#
# WHAT THIS USED TO BE
# -------------------
#
# Four committed merge conflicts, and two routes that do not exist.
#
# The file was committed with the conflict markers still in it:
#
#     <<<<<<< HEAD
#     ...
#     =======
#     ...
#     >>>>>>> f349217 (hosted: accounting period lifecycle + close-lock enforcement)
#
# It did not even parse:
#
#     $ bash -n hosted/tests/chaos/06-period-close-with-open-bank.sh
#     hosted/tests/chaos/06-period-close-with-open-bank.sh: line 4: syntax error near unexpected token `<<<'
#
# So the drill had not run in months, and nobody noticed — because nothing
# ran it. The CI workflow does not invoke the chaos suite, and the handover
# lists this one among the monthly drills with a `sudo` in front of it.
#
# Underneath the markers it drove two routes that do not exist:
#
#     POST /admin/accounting/periods/close        — there is no such route
#     POST /api/v1/accounting/journal/test-post   — there is no such route
#
# And it skipped itself everywhere but the deployed box:
#
#     if ! command -v systemctl >/dev/null 2>&1; then
#       echo "systemd not available; skipping"; exit 0
#     fi
#
# A drill that exits 0 without having tested anything is exactly what this
# whole programme is about removing. This one drives whichever deployment is
# here — the compose stack (CI) or the deployed box (the monthly run) — and
# it fails when it cannot run.
#
# WHAT THE REAL CLOSE LOOKS LIKE
# ------------------------------
#
#     POST /api/v1/accounting/periods/close
#       { period: '2026-03' }                         → 428, with the counts
#       { period, confirm: true, acknowledge: [...] }  → 200, and it is closed
#
# The `acknowledge` list carries the FIGURES the operator was shown, not just
# the warning's code. An acknowledgement of "3 open bank transactions" is not
# an acknowledgement of "4 open bank transactions", and the difference is a
# bank line landing while the dialog is open.
#
# WHAT THIS DRILL PROVES
# ----------------------
#
#   1. The close is not one click. Without a confirmation the application
#      answers 428 and the period stays OPEN.
#   2. The warning is real: it names the open bank transaction, with the
#      count and the figure, and the figure is the one the drill inserted.
#   3. The confirmation is not a formality. An acknowledgement carrying the
#      WRONG figures is refused, the outstanding warnings are named, and the
#      period stays open — so the operator cannot close a month over
#      something they did not see.
#   4. With the figures the operator was shown, the close goes through, and
#      the record names who closed it.
#   5. A closed month STAYS closed: the bank line that was waiting is still
#      uncategorised, a posting into it is refused with 409, and nothing is
#      written to the ledger.
#
# Point (5) is the point of the whole thing. The close locks the month, and a
# posting into a locked month is a conflict the operator can act on — not a
# half-written journal entry.
#
# IT TOUCHES NOTHING OF THE CUSTOMER'S
# ------------------------------------
# The drill builds its own tenant, with its own uuid, and deletes it on the
# way out — including when the drill fails half way through.
set -uo pipefail

DRILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/drill-lib.sh
source "$DRILL_DIR/lib/drill-lib.sh"

# The bank line the drill leaves uncategorised. The figure is the drill's
# own, and the preflight has to report exactly this back.
DRILL_BANK_AMOUNT="${DRILL_BANK_AMOUNT:-12345}"

cleanup() {
  drill_cleanup
}
trap cleanup EXIT

echo "Chaos 06: a period close with an open bank transaction."

drill_setup
fixture_create "$DRILL_PERIOD"
fixture_add_open_bank_line "$DRILL_PERIOD" "$DRILL_BANK_AMOUNT"
mint_session

# ── 1. the close without a confirmation ───────────────────────────────────
#
# Nothing is written by this request. It is the question the confirm dialog
# is built from, and the answer is the counts.

echo
echo "== asking what closing $DRILL_PERIOD would do =="

drill_app POST "/api/v1/accounting/periods/close" \
  -H "content-type: application/json" \
  -d "{\"period\":\"$DRILL_PERIOD\"}"

if [[ "$DRILL_HTTP_STATUS" == "428" ]]; then
  ok "the application answered 428 — the close needs a confirmation"
else
  fail "the application answered $DRILL_HTTP_STATUS, not 428: $DRILL_HTTP_BODY"
fi

preflight="$DRILL_HTTP_BODY"

if [[ "$preflight" == *'"code":"confirmation_required"'* ]]; then
  ok "the answer says the confirmation is what is missing"
else
  bad "the answer does not ask for a confirmation: $preflight"
fi

# ── 2. the warning is real ────────────────────────────────────────────────
#
# The old drill looked for the string "open bank transactions" in an HTML
# page that has not existed for months. This looks for the warning the
# application actually builds, with its figures.

echo
echo "== what the warning says =="

figures="$(preflight_warning_figures "$preflight" open_bank_items)"
count="${figures%% *}"
amount="${figures##* }"

if [[ "$count" == "1" ]]; then
  ok "the warning names one open bank transaction — the one the drill inserted"
else
  bad "the warning says there are '${count:-nothing}' open bank transactions, not 1: $preflight"
fi

if [[ "$amount" == "$DRILL_BANK_AMOUNT" ]]; then
  ok "the warning carries the transaction's own figure ($amount pence)"
else
  bad "the warning says ${amount:-nothing} pence, not $DRILL_BANK_AMOUNT: $preflight"
fi

# The month must still be open. This is the "double-confirm" half: nothing
# was closed by asking.
state="$(period_state "$DRILL_PERIOD")"
if [[ "$state" == "open" ]]; then
  ok "the period is still open — asking did not close it"
else
  bad "the period is '$state' after a request that carried no confirmation"
fi

# ── 3. a confirmation with the WRONG figures is refused ───────────────────
#
# The acknowledgement below names the right warning with a figure nobody was
# shown. The close must refuse, and must say which warnings are outstanding.
# If the close accepted it, the drill would be proving nothing about the
# operator having been told.

echo
echo "== confirming with figures the operator was never shown =="

drill_app POST "/api/v1/accounting/periods/close" \
  -H "content-type: application/json" \
  -d "{\"period\":\"$DRILL_PERIOD\",\"confirm\":true,\"acknowledge\":[{\"code\":\"open_bank_items\",\"count\":99,\"amountPence\":1}]}"

if [[ "$DRILL_HTTP_STATUS" == "428" ]]; then
  ok "the application refused the close — the figures were not the ones on screen"
else
  bad "the application answered $DRILL_HTTP_STATUS to a close acknowledged with the wrong figures: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *"open_bank_items"* ]]; then
  ok "the refusal names the warning that was not properly acknowledged"
else
  bad "the refusal does not name the outstanding warning: $DRILL_HTTP_BODY"
fi

state="$(period_state "$DRILL_PERIOD")"
if [[ "$state" == "open" ]]; then
  ok "the period is still open"
else
  bad "the period is '$state' — a close acknowledged with the wrong figures went through"
fi

# ── 4. the real confirmation closes it ────────────────────────────────────
#
# The acknowledgement is built from the preflight the operator was shown —
# the same thing the dialog does.

echo
echo "== confirming with the figures the operator was shown =="

acknowledge="$(preflight_acknowledgements "$preflight")"
note "acknowledging: $acknowledge"

drill_app POST "/api/v1/accounting/periods/close" \
  -H "content-type: application/json" \
  -d "{\"period\":\"$DRILL_PERIOD\",\"confirm\":true,\"acknowledge\":$acknowledge}"

if [[ "$DRILL_HTTP_STATUS" == "200" ]]; then
  ok "the application accepted the confirmation"
else
  fail "the application answered $DRILL_HTTP_STATUS to a proper confirmation: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *'"closed":true'* ]]; then
  ok "the answer says the period is closed"
else
  bad "the answer does not say the period is closed: $DRILL_HTTP_BODY"
fi

state="$(period_state "$DRILL_PERIOD")"
if [[ "$state" == "closed" ]]; then
  ok "the period is closed in the database"
else
  bad "the period is '$state' — the confirmation did not close it"
fi

closer="$(period_closer "$DRILL_PERIOD")"
if [[ "$closer" == "$DRILL_USER_ID" ]]; then
  ok "the period records who closed it"
else
  bad "the period names '$closer' as its closer, not the operator who confirmed it"
fi

audited="$(sql_scalar "select count(*) from accounting.audit_log
                         where tenant_id = '$DRILL_TENANT_ID'
                           and action = 'period_closed'
                           and user_id = '$DRILL_USER_ID'")"
if [[ "${audited:-0}" -ge 1 ]]; then
  ok "the close left an audit row naming the operator"
else
  bad "the close left no 'period_closed' audit row for the operator"
fi

# ── 5. a closed month stays closed ────────────────────────────────────────
#
# The bank line that made the close warn is still there, still uncategorised,
# and dated inside the closed month. Posting it now must be refused — with a
# conflict that names the period, and without writing anything.

echo
echo "== posting into the closed month =="

before="$(journal_count_for "$DRILL_PERIOD")"

drill_app POST "/api/v1/accounting/reconcile" \
  --data-urlencode "bankTxId=$DRILL_BANK_TX_ID" \
  --data-urlencode "action=vat" \
  --data-urlencode "returnTo=/accounts/accounting/reconcile"

if [[ "$DRILL_HTTP_STATUS" == "409" ]]; then
  ok "the posting was refused with 409 — a conflict, not a failure"
else
  bad "the posting was answered $DRILL_HTTP_STATUS, not 409: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *'"code":"period_closed"'* ]]; then
  ok "the refusal says the period is closed"
else
  bad "the refusal does not name the closed period: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *"\"period\":\"$DRILL_PERIOD\""* ]]; then
  ok "the refusal names which period is closed"
else
  bad "the refusal does not name the period: $DRILL_HTTP_BODY"
fi

after="$(journal_count_for "$DRILL_PERIOD")"
if [[ "${after:-0}" -eq "${before:-0}" ]]; then
  ok "nothing was written to the ledger — the refusal came before the posting"
else
  bad "the ledger gained ${after:-0} entries (was ${before:-0}) — a refused posting wrote something"
fi

status="$(bank_tx_status)"
if [[ "$status" == "unmatched" ]]; then
  ok "the bank line is still waiting to be categorised"
else
  bad "the bank line is '$status' — a refused posting categorised it anyway"
fi

# ── the result ─────────────────────────────────────────────────────────────

echo
drill_result

echo
echo "Drill 06 passed. The close warned, refused a close nobody had confirmed, closed only on a confirmation carrying the figures that were shown, and the closed month refused a posting without writing anything."
echo OK
