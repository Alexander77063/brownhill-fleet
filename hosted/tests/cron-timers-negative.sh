#!/usr/bin/env bash
# hosted/tests/cron-timers-negative.sh — prove the cron gate can fail.
#
# WHY THIS TEST EXISTS
# --------------------
# A gate that cannot fail is not a gate. The cron gate (hosted/tests/
# cron-timers.sh) is a static check over the repository with one local HTTP
# round trip, and it passes today. That is worth exactly nothing on its own:
# the same is true of a gate that was written to be green.
#
# So this test breaks the thing on purpose, in a copy of the tree, and
# requires the gate to NOTICE. Five defects are injected, one at a time:
#
#   1. a timer is deleted          — the box stops running a job
#   2. the secret is not provisioned — every call would answer 401
#   3. a schedule is changed       — the box and the SaaS disagree
#   4. the bearer is not presented — the app would refuse the call
#   5. the installer stops starting the timers — a timer that is installed
#                                    but never started is the same as no timer
#
# Each is injected into a FRESH copy, so one defect cannot mask another.
#
# It also runs the gate against an UNMODIFIED copy first, and requires it to
# pass there. Without that step, a gate that failed for any reason at all
# would satisfy every check below — including the ones that were supposed to
# prove it detects a specific defect.

set -euo pipefail

REPO="${BROWNHILL_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

GATE=hosted/tests/cron-timers.sh

# A faithful copy of the tree the gate reads.
#
# Only the files the gate touches are copied, because that is what makes the
# copy cheap; and the copy is checked to be faithful by running the gate
# against it unmodified.
make_copy() {
  local dest="$1"
  mkdir -p "$dest/hosted/bootstrap" "$dest/hosted/scripts" "$dest/hosted/systemd" "$dest/hosted/tests"
  cp vercel.json "$dest/vercel.json"
  cp hosted/bootstrap/install.sh "$dest/hosted/bootstrap/install.sh"
  cp hosted/scripts/brownhill-cron.mjs "$dest/hosted/scripts/brownhill-cron.mjs"
  cp "$GATE" "$dest/hosted/tests/cron-timers.sh"
  cp hosted/systemd/brownhill-next.service "$dest/hosted/systemd/"
  cp hosted/systemd/brownhill-cron@.service "$dest/hosted/systemd/"
  cp hosted/systemd/brownhill-cron-*.timer "$dest/hosted/systemd/"
}

# Run the gate against a copy and say whether it passed.
gate_passes() {
  local root="$1"
  BROWNHILL_REPO_ROOT="$root" bash "$root/hosted/tests/cron-timers.sh" >/dev/null 2>&1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== 0: the gate passes against an unmodified copy =="

make_copy "$WORK/clean"
if gate_passes "$WORK/clean"; then
  ok "the gate passes against a faithful copy of the tree"
else
  bad "the gate failed against an UNMODIFIED copy — every check below would be meaningless"
  echo
  echo "Result: $PASS passed, $FAIL failed"
  exit 1
fi

# ── 1: a timer is deleted ──────────────────────────────────────────────────

echo
echo "== 1: a deleted timer is noticed =="

make_copy "$WORK/no-timer"
rm "$WORK/no-timer/hosted/systemd/brownhill-cron-generate-rent.timer"
if gate_passes "$WORK/no-timer"; then
  bad "the gate passed with the rent timer deleted — the box would stop raising invoices and the gate would not say so"
else
  ok "the gate fails when the rent timer is deleted"
fi

# ── 2: the secret is not provisioned ────────────────────────────────────────

echo
echo "== 2: an unprovisioned secret is noticed =="

make_copy "$WORK/no-secret"
sed -i '/write_secret \/etc\/brownhill\/secrets\/cron\.env/d' "$WORK/no-secret/hosted/bootstrap/install.sh"
if gate_passes "$WORK/no-secret"; then
  bad "the gate passed with cron.env unprovisioned — every cron call would answer 401 and the gate would not say so"
else
  ok "the gate fails when the secret is not provisioned"
fi

# ── 3: a schedule is changed ────────────────────────────────────────────────

echo
echo "== 3: a changed schedule is noticed =="

make_copy "$WORK/other-schedule"
sed -i 's/^OnCalendar=Mon \*-\*-\* 06:00:00$/OnCalendar=Mon *-*-* 07:00:00/' \
  "$WORK/other-schedule/hosted/systemd/brownhill-cron-generate-rent.timer"
if gate_passes "$WORK/other-schedule"; then
  bad "the gate passed with the rent schedule moved an hour — the box and the SaaS would bill on different days and the gate would not say so"
else
  ok "the gate fails when a schedule no longer matches the contract"
fi

# ── 4: the bearer is not presented ──────────────────────────────────────────

echo
echo "== 4: a missing bearer is noticed =="

make_copy "$WORK/no-bearer"
sed -i 's/Bearer ${secret}/Bearer nothing/' "$WORK/no-bearer/hosted/scripts/brownhill-cron.mjs"
if gate_passes "$WORK/no-bearer"; then
  bad "the gate passed with the bearer token removed — the app would refuse every call and the gate would not say so"
else
  ok "the gate fails when the caller stops presenting the bearer"
fi

# ── 5: the timers are never started ─────────────────────────────────────────

echo
echo "== 5: an unstarted timer is noticed =="

make_copy "$WORK/not-started"
sed -i 's/^systemctl enable --now brownhill-cron-generate-rent\.timer$/systemctl enable brownhill-cron-generate-rent.timer/' \
  "$WORK/not-started/hosted/bootstrap/install.sh"
if gate_passes "$WORK/not-started"; then
  bad "the gate passed with the rent timer installed but never started — the box would look provisioned and bill nobody"
else
  ok "the gate fails when a timer is installed but not started"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
