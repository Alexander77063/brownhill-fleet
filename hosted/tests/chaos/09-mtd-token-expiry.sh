#!/usr/bin/env bash
# hosted/tests/chaos/09-mtd-token-expiry.sh
#
# HMRC's access token expires. The return must still be filed — and when it
# cannot be, the operator must be told to reconnect, and the books must not
# move.
#
# WHAT THIS USED TO BE
# -------------------
#
#     # Trigger the submit (real HMRC call mocked by tests; this drill just
#     # exercises the route + DB layer end-to-end). In v1 the route is a stub
#     # — the chaos drill passes when the route returns 200/303 with the
#     # response payload intact.
#     ...
#     # Don't insist on a specific code — the SaaS team's bridge call may
#     # succeed or fail depending on test fixtures; what matters is no panic
#     # in the journal.
#     echo OK
#
# It asserted nothing, and it said so: "don't insist on a specific code",
# "what matters is no panic". A drill that cannot fail is not a drill — and
# this one could not fail even if the application filed every return with
# HMRC, refused every refusal, and settled every refusal in the ledger.
#
# WHY IT SAID "IN V1 THE ROUTE IS A STUB"
# --------------------------------------
# Because it was true, and nobody fixed it. The application's submission path
# was:
#
#     async function callHmrcSubmit(payload: object): Promise<SubmitResult> {
#       void payload;
#       return { status: 'submitted', hmtrCorrelationId: 'HMRC-' + Date.now() };
#     }
#
# It never called HMRC, and it always answered "submitted". There was no
# refresh_token grant anywhere in the product, so an expired token had
# exactly one possible outcome — the operator had to connect again by hand —
# and the reason they were given was that HMRC had rejected the return.
#
# WHAT THIS DRILL PROVES
# ----------------------
# Two halves, and they are halves of one promise.
#
# Part one — the token expires and CAN be renewed. The application refreshes
# it and files the return, and the ledger is settled. This is also the
# CONTROL for drill 05: it shows that this fixture really does carry VAT and
# really does post a journal entry when HMRC accepts, so drill 05's "no
# journal entry" is a fact about the refusal rather than an accident of an
# empty period.
#
# Part two — the token expires and CANNOT be renewed. The application must
# say "reconnect to HMRC", must not claim the return was filed, and must
# post NOTHING. This is the half the old drill was reaching for and could
# not reach.
#
# It drives whichever deployment is here: the compose stack (CI) or the
# deployed box (the monthly run).
set -uo pipefail

DRILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/drill-lib.sh
source "$DRILL_DIR/lib/drill-lib.sh"

DRILL_PERIOD_2="${DRILL_PERIOD_2:-2026-04}"

cleanup() {
  drill_cleanup
}
trap cleanup EXIT

echo "Chaos 09: HMRC's token expires."

drill_setup
stub_start expire
app_point_at_stub
fixture_create "$DRILL_PERIOD" "$DRILL_PERIOD_2"
mint_session
connect_hmrc
set_vrn

# ── part one: the token expires, and it can be renewed ──────────────────────

echo
echo "== part one: the token expires and is renewed, and the return is filed =="

submit_return

if [[ "$DRILL_HTTP_STATUS" == "200" ]]; then
  ok "the application answered 200 — the return was filed"
else
  fail "the application answered $DRILL_HTTP_STATUS, not 200: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *'"status":"submitted"'* ]]; then
  ok "the answer says the return was submitted"
else
  bad "the answer does not say the return was submitted: $DRILL_HTTP_BODY"
fi

stats="$(stub_stats)"
refreshes="$(stub_stat "$stats" refreshTokenGrants)"
returns="$(stub_stat "$stats" returns)"

if [[ "${refreshes:-0}" -ge 1 ]]; then
  ok "the application used the refresh_token grant ($refreshes) — the expired token was renewed, not given up on"
else
  bad "the application never used the refresh_token grant (stats: $stats)"
fi

if [[ "${returns:-0}" -ge 2 ]]; then
  ok "the stub saw $returns submissions — the first was refused for the expired token and the second was accepted"
else
  bad "the stub saw only ${returns:-0} submission(s) — the application did not retry with a renewed token (stats: $stats)"
fi

row="$(submission_row_for "$DRILL_PERIOD")"
status="${row%%|*}"

if [[ "$status" == "submitted" ]]; then
  ok "the submission is marked 'submitted'"
else
  bad "the submission is marked '$status', not 'submitted'"
fi

# THE CONTROL. If this fails, drill 05's "no journal entry" proves nothing,
# because this fixture would not have posted one whatever HMRC said.
count="$(vat_journal_count_for "$DRILL_PERIOD")"
if [[ "${count:-0}" -ge 1 ]]; then
  ok "a journal entry WAS posted for $DRILL_PERIOD — so this fixture really does settle a return HMRC accepts"
else
  bad "no journal entry was posted for $DRILL_PERIOD even though HMRC accepted the return — drill 05's negative assertion would prove nothing"
fi

if [[ "$row" != *"|NULL|"* ]]; then
  ok "the submission carries the id of the journal entry it settled"
else
  bad "the submission carries no posted journal id: $row"
fi

# ── part two: the token expires, and it cannot be renewed ───────────────────

echo
echo "== part two: the token expires and the refresh is refused =="

# The stub now refuses every token AND refuses the refresh grant — which is
# what happens when a refresh token has expired, been revoked, or belongs to
# an application HMRC has taken away.
stub_start expire-hard

submit_return_2() {
  drill_app POST "/api/v1/accounting/mtd/submit?period=$DRILL_PERIOD_2"
}

submit_return_2

if [[ "$DRILL_HTTP_STATUS" == "428" ]]; then
  ok "the application answered 428 — the tenant cannot file as things stand"
else
  fail "the application answered $DRILL_HTTP_STATUS, not 428: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *"not_connected"* ]]; then
  ok "the answer says the tenant has to connect again (code: not_connected)"
else
  bad "the answer does not ask for a reconnection: $DRILL_HTTP_BODY"
fi

if [[ "$DRILL_HTTP_BODY" == *"Reconnect"* || "$DRILL_HTTP_BODY" == *"reconnect"* ]]; then
  ok "the answer tells the operator to reconnect to HMRC"
else
  bad "the answer does not tell the operator to reconnect: $DRILL_HTTP_BODY"
fi

stats2="$(stub_stats)"
refreshes2="$(stub_stat "$stats2" refreshTokenGrants)"
if [[ "${refreshes2:-0}" -ge 1 ]]; then
  ok "the application tried to renew the token ($refreshes2 attempt(s)) before giving up"
else
  bad "the application never tried to renew the token (stats: $stats2)"
fi

row2="$(submission_row_for "$DRILL_PERIOD_2")"
status2="${row2%%|*}"

if [[ "$status2" == "rejected" ]]; then
  ok "the submission is marked 'rejected' — not 'submitted'"
else
  bad "the submission is marked '$status2', not 'rejected'"
fi

if [[ "$row2" == *"|NULL|"* ]]; then
  ok "the submission carries no posted journal id"
else
  bad "the submission carries a posted journal id: $row2"
fi

count2="$(vat_journal_count_for "$DRILL_PERIOD_2")"
if [[ "${count2:-0}" -eq 0 ]]; then
  ok "no journal entry was posted for $DRILL_PERIOD_2"
else
  bad "$count2 journal entr(y/ies) were posted for $DRILL_PERIOD_2 — a return that was never filed was settled in the books"
fi

# ── the result ──────────────────────────────────────────────────────────────

echo
drill_result

echo
echo "Drill 09 passed. An expired token was renewed and the return filed; a token that could not be renewed produced a reconnection request and no posting at all."
echo OK
