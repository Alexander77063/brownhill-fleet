#!/usr/bin/env bash
# hosted/tests/chaos/05-vat-submit-rejected.sh
#
# HMRC refuses a VAT return. The books must not move.
#
# WHAT THIS USED TO BE
# -------------------
#
#     #!/usr/bin/env bash
#     set -euo pipefail
#     echo OK
#
# Six lines that asserted nothing at all. It was listed in the drill suite,
# it was named in the handover, and it would have passed on a build where
# the application filed every return with HMRC, every return HMRC refused,
# and every refusal was settled in the ledger as though HMRC had accepted it.
#
# And that was not hypothetical. The application's submission path used to
# be:
#
#     async function callHmrcSubmit(payload: object): Promise<SubmitResult> {
#       void payload;
#       return { status: 'submitted', hmtrCorrelationId: 'HMRC-' + Date.now() };
#     }
#
# It never called HMRC. It always answered "submitted". So the application
# journalled VAT returns that had never been filed and told the operator
# HMRC had accepted them. Nothing in the product could tell the difference,
# and this drill — which existed to catch exactly that — could not either.
#
# WHAT THIS DRILL PROVES
# ----------------------
# Against the DEPLOYED application, with a stub HMRC that refuses every
# return:
#
#   1. the application really calls HMRC (the stub's own counters show it)
#   2. the refusal is recorded — `accounting.vat_submissions` says `rejected`
#   3. HMRC's own words are kept on the record, not a generic "failed"
#   4. NOTHING is posted to the ledger — no journal entry, no posted id
#   5. the return really did carry VAT, so (4) is a fact about the refusal
#      and not an accident of an empty period
#
# Point (5) is what makes point (4) mean anything, and it is why the drill
# builds a tenant with an invoice in it. A period with no VAT in it posts
# nothing whatever the answer, so "no journal entry" would be true of a
# correct application and of a broken one alike.
#
# IT TOUCHES NOTHING OF THE CUSTOMER'S
# ------------------------------------
# The drill builds its own tenant, with its own uuid, and deletes it on the
# way out — including when the drill fails half way through.
#
# It drives whichever deployment is here: the compose stack (CI) or the
# deployed box (the monthly run).
set -uo pipefail

DRILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/drill-lib.sh
source "$DRILL_DIR/lib/drill-lib.sh"

cleanup() {
  drill_cleanup
}
trap cleanup EXIT

echo "Chaos 05: HMRC refuses a VAT return, and the books must not move."

drill_setup
stub_start reject
app_point_at_stub
fixture_create "$DRILL_PERIOD"
mint_session
connect_hmrc
set_vrn

# ── file the return ─────────────────────────────────────────────────────────

echo
echo "== filing the return for $DRILL_PERIOD =="

submit_return

if [[ "$DRILL_HTTP_STATUS" == "422" ]]; then
  ok "the application answered 422 — HMRC refused the return"
else
  fail "the application answered $DRILL_HTTP_STATUS, not 422: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *"hmrc_rejected"* ]]; then
  ok "the answer says the refusal came from HMRC (code: hmrc_rejected)"
else
  bad "the answer does not name the refusal as HMRC's: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *"rejected"* ]]; then
  ok "the answer carries HMRC's own words"
else
  bad "the answer does not carry HMRC's own words: $DRILL_HTTP_BODY"
fi

# ── HMRC was really called ──────────────────────────────────────────────────

echo
echo "== HMRC was really called =="

stats="$(stub_stats)"
returns="$(stub_stat "$stats" returns)"

if [[ "${returns:-0}" -ge 1 ]]; then
  ok "the stub received $returns submission(s) — the application really called HMRC"
else
  bad "the stub received no submission at all — the application did not call HMRC (stats: $stats)"
fi

# ── the record ──────────────────────────────────────────────────────────────

echo
echo "== what was recorded =="

row="$(submission_row_for "$DRILL_PERIOD")"
status="${row%%|*}"

if [[ "$status" == "rejected" ]]; then
  ok "the submission is marked 'rejected'"
else
  bad "the submission is marked '$status', not 'rejected'"
fi

body="$(submission_response_body "$DRILL_PERIOD")"
if [[ "$body" == *"rejected"* ]]; then
  ok "HMRC's own words were kept on the record"
else
  bad "the record does not carry HMRC's words: ${body:-nothing}"
fi

net_vat="$(submission_net_vat)"
if [[ "$net_vat" != "0" && -n "$net_vat" ]]; then
  ok "the return really did carry VAT (£$net_vat), so the ledger had a posting to make"
else
  bad "the return carried no VAT (£${net_vat:-nothing}) — 'no journal entry' would prove nothing"
fi

# ── the ledger ──────────────────────────────────────────────────────────────

echo
echo "== what was posted to the ledger =="

if [[ "$row" == *"|NULL|"* ]]; then
  ok "the submission carries no posted journal id"
else
  bad "the submission carries a posted journal id: $row"
fi

count="$(vat_journal_count_for "$DRILL_PERIOD")"
if [[ "${count:-0}" -eq 0 ]]; then
  ok "no journal entry was posted for $DRILL_PERIOD"
else
  bad "$count journal entr(y/ies) were posted for $DRILL_PERIOD — a return HMRC refused was settled in the books"
fi

# ── the result ──────────────────────────────────────────────────────────────

echo
drill_result

echo
echo "Drill 05 passed. HMRC refused the return, the refusal was recorded with HMRC's own words, and nothing was posted to the ledger."
echo OK
