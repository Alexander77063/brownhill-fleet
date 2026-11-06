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

# ── 6: the summary agrees with the lines above it ───────────────────────────
#
# The gate prints a line for every check and then a summary. The summary is
# what a reader — and a CI log — looks at, so when it disagrees with the
# lines above it, the summary is the thing that is wrong.
#
# The skip count is the one that matters most here. A `skip()` that prints
# and forgets leaves the summary reading "N passed, 0 failed" whether the
# check ran or was dropped, and a reader cannot tell the two apart. That is
# not a hypothetical: the OnCalendar expressions were never parsed on the
# machines that did not have systemd-analyze, and the summary said nothing
# was wrong.

# The faults in a gate's output, one per line. Nothing at all when the
# summary agrees with the lines above it.
arithmetic_faults() {
  local out="$1"
  local ok_lines fail_lines skip_lines
  ok_lines="$(grep -c '^  ok:' "$out" || true)"
  fail_lines="$(grep -c '^  FAIL:' "$out" || true)"
  skip_lines="$(grep -c '^  skip:' "$out" || true)"

  local result
  result="$(grep -E '^Result: ' "$out" | tail -1 || true)"
  if [[ -z "$result" ]]; then
    echo "there is no result line"
    return 1
  fi

  local passed reported_failed reported_skip
  passed="$(sed -nE 's/^Result: ([0-9]+) passed.*/\1/p' <<<"$result")"
  reported_failed="$(sed -nE 's/^Result: [0-9]+ passed, ([0-9]+) failed.*/\1/p' <<<"$result")"
  reported_skip="$(sed -nE 's/^Result: [0-9]+ passed, [0-9]+ failed, ([0-9]+) skipped.*/\1/p' <<<"$result")"

  local faults=0
  if [[ -z "$reported_skip" ]]; then
    echo "the result line does not report the skipped checks: \"$result\""
    faults=$((faults + 1))
  fi
  if [[ "$passed" != "$ok_lines" ]]; then
    echo "the result line says ${passed:-no number} passed, and $ok_lines ok: lines were printed"
    faults=$((faults + 1))
  fi
  if [[ "$reported_failed" != "$fail_lines" ]]; then
    echo "the result line says ${reported_failed:-no number} failed, and $fail_lines FAIL: lines were printed"
    faults=$((faults + 1))
  fi
  if [[ "$reported_skip" != "$skip_lines" ]]; then
    echo "the result line says ${reported_skip:-no number} skipped, and $skip_lines skip: lines were printed"
    faults=$((faults + 1))
  fi
  [[ "$faults" -eq 0 ]]
}

# Put a skip() that prints and forgets in place of the real one.
#
# A later definition of a shell function replaces the earlier one, so this
# does not have to match the original line exactly — it only has to come
# after it.
redefine_skip() {
  awk '
    { print }
    /^skip\(\) \{/ {
      print ""
      print "# The negative control replaced skip() with one that prints and forgets."
      print "skip() { echo \"  skip: $1\"; }"
    }
  ' "$1" > "$1.new" && mv "$1.new" "$1"
}

# Make the gate skip once, so the count has something to disagree about on
# a machine where nothing would otherwise be skipped.
inject_skip() {
  awk '
    { print }
    /^skip\(\) \{/ {
      print ""
      print "# The negative control injected a skip."
      print "skip \"the negative control injected a skip\""
    }
  ' "$1" > "$1.new" && mv "$1.new" "$1"
}

# Take the skipped count out of the summary.
drop_skip_from_summary() {
  awk '
    /^echo "Result: / { print "echo \"Result: $PASS passed, $FAIL failed\""; next }
    { print }
  ' "$1" > "$1.new" && mv "$1.new" "$1"
}

echo
echo "== 6: the summary agrees with the lines above it =="

make_copy "$WORK/counts"
BROWNHILL_REPO_ROOT="$WORK/counts" bash "$WORK/counts/hosted/tests/cron-timers.sh" \
  >"$WORK/counts.out" 2>&1 || true

faults="$(arithmetic_faults "$WORK/counts.out" || true)"
if [[ -z "$faults" ]]; then
  ok "the summary agrees with the ok, FAIL and skip lines above it"
else
  bad "the summary disagrees with the lines above it:"
  printf '%s\n' "$faults" | sed 's/^/      /'
fi

# ── 6a: a skip() that prints and forgets ───────────────────────────────────
#
# The fault the count was introduced for. The gate skips a check, prints
# "skip: …", and the summary says it did not skip anything. The summary is
# what a reader trusts.

echo
echo "== 6a: a skip() that prints and forgets is noticed =="

make_copy "$WORK/forgetful"
inject_skip "$WORK/forgetful/hosted/tests/cron-timers.sh"
redefine_skip "$WORK/forgetful/hosted/tests/cron-timers.sh"
BROWNHILL_REPO_ROOT="$WORK/forgetful" bash "$WORK/forgetful/hosted/tests/cron-timers.sh" \
  >"$WORK/forgetful.out" 2>&1 || true

faults="$(arithmetic_faults "$WORK/forgetful.out" || true)"
if [[ -z "$faults" ]]; then
  bad "the summary agreed with a gate that skipped a check without counting it — the check cannot fail"
  sed 's/^/      /' "$WORK/forgetful.out" | tail -5
elif grep -q 'skipped' <<<"$faults"; then
  ok "the summary is caught disagreeing about the skipped checks"
else
  bad "the summary disagreed, but not about the skipped checks:"
  printf '%s\n' "$faults" | sed 's/^/      /'
fi

# ── 6b: a summary that stops reporting the skips ───────────────────────────

echo
echo "== 6b: a summary that stops reporting the skips is noticed =="

make_copy "$WORK/mute"
inject_skip "$WORK/mute/hosted/tests/cron-timers.sh"
drop_skip_from_summary "$WORK/mute/hosted/tests/cron-timers.sh"
BROWNHILL_REPO_ROOT="$WORK/mute" bash "$WORK/mute/hosted/tests/cron-timers.sh" \
  >"$WORK/mute.out" 2>&1 || true

faults="$(arithmetic_faults "$WORK/mute.out" || true)"
if [[ -z "$faults" ]]; then
  bad "the summary agreed with a gate that does not report its skips at all — the check cannot fail"
  sed 's/^/      /' "$WORK/mute.out" | tail -5
elif grep -q 'does not report the skipped checks' <<<"$faults"; then
  ok "the summary is caught not reporting the skipped checks"
else
  bad "the summary disagreed, but not about the missing skip count:"
  printf '%s\n' "$faults" | sed 's/^/      /'
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
