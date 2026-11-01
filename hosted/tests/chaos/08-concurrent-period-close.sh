#!/usr/bin/env bash
# hosted/tests/chaos/08-concurrent-period-close.sh
#
# Spec §5: two operators try to close the same period at the same time. The
# loser gets a 409 naming the winner's `closed_by_user_id` and `closed_at`.
#
# WHAT THIS USED TO BE
# -------------------
#
#     set -euo pipefail
#     echo OK
#
# Six lines that asserted nothing, in a file whose whole name promises a
# race. It would have passed on a build where the close took the last write,
# where both operators were told they had closed the month, and where the
# loser was never told who had won.
#
# WHAT THIS DRILL PROVES
# ----------------------
#
# Two real operators, two real sessions, two confirmed closes fired at the
# same instant against the same month:
#
#   1. EXACTLY ONE of them closes the month. The other is refused with 409.
#   2. The refusal says the period was ALREADY closed — not "something went
#      wrong" — and it names the period.
#   3. The refusal names WHO won, and WHEN. That is the difference between a
#      conflict an operator can act on and a generic failure they have to
#      guess about.
#   4. The month is closed once, and the audit trail records one close, by
#      one person.
#
# Point (3) is the point. Two accountants pressing the same button at the
# same moment is not an edge case — it is a Tuesday. The one who loses must
# be told who won, or they will assume the month is still open and file a
# VAT return into it.
#
# IT TOUCHES NOTHING OF THE CUSTOMER'S
# ------------------------------------
# The drill builds its own tenant, with its own uuid, and deletes it on the
# way out — including when the drill fails half way through.
set -uo pipefail

DRILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/drill-lib.sh
source "$DRILL_DIR/lib/drill-lib.sh"

DRILL_BANK_AMOUNT="${DRILL_BANK_AMOUNT:-12345}"

cleanup() {
  drill_cleanup
}
trap cleanup EXIT

echo "Chaos 08: two operators close the same period at the same moment."

drill_setup
fixture_create "$DRILL_PERIOD"
fixture_add_open_bank_line "$DRILL_PERIOD" "$DRILL_BANK_AMOUNT"

# Two operators, so the refusal can name one of them.
operator_b="$(fixture_add_operator Second)"
ok "the drill's tenant has a second operator"

session_a="$(mint_token_for "$DRILL_USER_ID")"
session_b="$(mint_token_for "$operator_b")"

# ── the confirmation both of them will send ───────────────────────────────
#
# The acknowledgement is built from the preflight, exactly as the dialog
# builds it. The open bank line is there so the confirmation has something
# real to acknowledge — a close with nothing outstanding would not exercise
# the path where the confirmation and the close are ordered against each
# other.

echo
echo "== asking what closing $DRILL_PERIOD would do =="

# Operator A asks. This goes out as operator A, not as the drill's default
# session — and the drill has no default session, because it mints one per
# operator and there are two of them here.
#
# `drill_app_as` answers with the status on stdout and keeps the body in its
# own file, so two requests can be in flight at once without overwriting each
# other's answers. The default `drill_app` would have put the status in
# DRILL_HTTP_STATUS instead, and the drill has two operators.
preflight_status="$(drill_app_as a "$session_a" POST "/api/v1/accounting/periods/close" \
  -H "content-type: application/json" \
  -d "{\"period\":\"$DRILL_PERIOD\"}")"
preflight="$(drill_as_body a)"

if [[ "$preflight_status" != "428" ]]; then
  fail "the preflight answered $preflight_status, not 428: $preflight"
fi

acknowledge="$(preflight_acknowledgements "$preflight")"
note "both operators will acknowledge: $acknowledge"

# ── the race ──────────────────────────────────────────────────────────────
#
# Both requests go out at the same time. The application takes the period's
# advisory lock, so the two are ordered rather than interleaved: one closes
# the month, the other finds it closed.

echo
echo "== both operators confirm at the same instant =="

close_body="{\"period\":\"$DRILL_PERIOD\",\"confirm\":true,\"acknowledge\":$acknowledge}"

drill_app_as a "$session_a" POST "/api/v1/accounting/periods/close" \
  -H "content-type: application/json" \
  -d "$close_body" >"$DRILL_TMP/status-a" 2>/dev/null &
pid_a=$!

drill_app_as b "$session_b" POST "/api/v1/accounting/periods/close" \
  -H "content-type: application/json" \
  -d "$close_body" >"$DRILL_TMP/status-b" 2>/dev/null &
pid_b=$!

wait "$pid_a" "$pid_b"

status_a="$(tr -d '[:space:]' <"$DRILL_TMP/status-a")"
status_b="$(tr -d '[:space:]' <"$DRILL_TMP/status-b")"
body_a="$(drill_as_body a)"
body_b="$(drill_as_body b)"

note "operator A was answered $status_a; operator B was answered $status_b"

# ── exactly one of them closed the month ──────────────────────────────────

echo
echo "== who closed it =="

winners=0
losers=0
winner_id=""
loser_status=""
loser_body=""

if [[ "$status_a" == "200" ]]; then
  winners=$((winners + 1)); winner_id="$DRILL_USER_ID"; loser_status="$status_b"; loser_body="$body_b"
fi
if [[ "$status_b" == "200" ]]; then
  winners=$((winners + 1)); winner_id="$operator_b"; loser_status="$status_a"; loser_body="$body_a"
fi

if [[ "$winners" -eq 1 ]]; then
  ok "exactly one of the two closed the month"
else
  fail "$winners of the two closes succeeded — the month was closed more than once"
fi

if [[ "$loser_status" == "409" ]]; then
  ok "the other one was refused with 409"
else
  bad "the other one was answered $loser_status, not 409: $loser_body"
fi

# ── the refusal says who won ──────────────────────────────────────────────

echo
echo "== what the loser was told =="

if [[ "$loser_body" == *'"code":"period_already_closed"'* ]]; then
  ok "the refusal says the period was already closed"
else
  bad "the refusal does not name the conflict: $loser_body"
fi

if [[ "$loser_body" == *"\"period\":\"$DRILL_PERIOD\""* ]]; then
  ok "the refusal names which period"
else
  bad "the refusal does not name the period: $loser_body"
fi

if [[ "$loser_body" == *"\"closedByUserId\":\"$winner_id\""* ]]; then
  ok "the refusal names who closed it"
else
  bad "the refusal does not name the winner ($winner_id): $loser_body"
fi

if [[ "$loser_body" == *'"closedAt":"'* && "$loser_body" != *'"closedAt":null'* ]]; then
  ok "the refusal says when it was closed"
else
  bad "the refusal carries no closing time: $loser_body"
fi

# ── one close, one record ─────────────────────────────────────────────────

echo
echo "== what the month looks like afterwards =="

state="$(period_state "$DRILL_PERIOD")"
if [[ "$state" == "closed" ]]; then
  ok "the period is closed"
else
  bad "the period is '$state'"
fi

closer="$(period_closer "$DRILL_PERIOD")"
if [[ "$closer" == "$winner_id" ]]; then
  ok "the period names the operator who won"
else
  bad "the period names '$closer', not the operator who won ($winner_id)"
fi

audited="$(sql_scalar "select count(*) from accounting.audit_log
                         where tenant_id = '$DRILL_TENANT_ID'
                           and action = 'period_closed'")"
if [[ "${audited:-0}" -eq 1 ]]; then
  ok "there is exactly one 'period_closed' record"
else
  bad "there are ${audited:-0} 'period_closed' records — the close was written twice"
fi

# ── the result ─────────────────────────────────────────────────────────────

echo
drill_result

echo
echo "Drill 08 passed. One of two operators closing the same month at the same instant closed it; the other was told who won and when."
echo OK
