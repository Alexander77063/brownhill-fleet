#!/usr/bin/env bash
# hosted/tests/deployment-gate-negative.sh — the negative case for the
# deployment gate's own test.
#
# `src/lib/deployment/gate.ts` decides which URL prefixes a deployment profile
# does not serve. Its test — `tests/unit/deployment-gate.test.ts` — is what
# holds that decision to the profiles. A gate that cannot fail is not a gate:
# if the wiring went back to being dead, the test would go on reporting that
# the cross-tenant console and the SaaS's own signup form are closed on
# Brownhill's box, and everybody would believe it.
#
# It is worth being exact about what went wrong here, because it is the shape
# the failure takes: `isPathDisabled` had NO call site anywhere in the
# repository. The table was complete, correct-looking, and never consulted.
# Nothing in the build, the deployment or the test suite noticed, because a
# table nobody calls is indistinguishable from a table nobody needs.
#
# So this runs the gate's test against a gate that is broken in each of the
# two ways it can be broken, and requires the test to fail on the right
# family of checks each time.
#
#   never-blocks  — the gate answers "this build serves it" for everything.
#                   This is what the unwired gate looked like from outside:
#                   every path served, including /platform and
#                   /request-access, on a box that must serve neither.
#   always-blocks — the gate answers "this build does not serve it" for
#                   everything. This is the over-blocking fault, and it is not
#                   hypothetical: the table as it was written listed
#                   `/ops/billing`, which is the page carrying Brownhill's
#                   arrears table, the driver's payment link and the receipt
#                   form. A gate that blocked it would have taken the rent
#                   collection with it.
#
# The fault is injected through the test file's own mock — the probe switch
# `DEPLOYMENT_GATE_PROBE` — rather than by editing tracked files. A negative
# gate that modified the tree in place could leave it broken if it were
# interrupted, and could damage the very thing it is meant to be checking.
#
# It needs bash, node and a checkout with its dependencies installed. It needs
# no docker, no database, no secrets and no stack, and it takes seconds.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST="tests/unit/deployment-gate.test.ts"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$REPO" || { echo "FAIL: cannot enter $REPO"; exit 1; }

if [[ ! -f "$TEST" ]]; then
  echo "FAIL: $TEST is missing — the deployment gate has no test to hold it"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "FAIL: node_modules is missing — run 'pnpm install' first"
  exit 1
fi

# Run the gate's test, with a probe set if one was asked for.
#
#   $1  the probe's value ("" for none)
#   $2  the output file
#
# The exit code is the test's own: 0 when the suite passed.
run_test() {
  local probe="$1" out="$2"
  if [[ -n "$probe" ]]; then
    DEPLOYMENT_GATE_PROBE="$probe" pnpm exec vitest run "$TEST" >"$out" 2>&1
  else
    pnpm exec vitest run "$TEST" >"$out" 2>&1
  fi
}

# Did the run fail on a test with this name?
#
# Only the reporter's FAIL headers are searched, so a test that PASSED does
# not count. That matters: the two probes below are told to fail on
# different families of checks, and each has to be sure the OTHER family
# still passed.
#
# The headers are wrapped in ANSI colour codes, so they are stripped first —
# otherwise "FAIL" is never at the start of the line and nothing matches.
failed_on() {
  sed "s/$(printf '\033')\[[0-9;]*m//g" "$1" \
    | grep -E '^[[:space:]]*FAIL ' \
    | grep -qF "$2"
}

# ── the baseline ────────────────────────────────────────────────────────────
#
# The test has to pass on the tree as it stands. If it did not, a probe that
# "failed" would prove nothing — the failure would be the baseline's.

echo "== the baseline: the gate's test passes on the tree as it stands =="

base_rc=0
run_test "" "$TMP/baseline.out" || base_rc=$?
if [[ "$base_rc" -eq 0 ]]; then
  ok "the test passes on the tree as it stands"
else
  bad "the test FAILS on the clean tree — the probes below would prove nothing"
  sed 's/^/      /' "$TMP/baseline.out"
  echo
  echo "Result: $PASS passed, $FAIL failed"
  exit 1
fi

# ── probe 1: the gate never blocks ──────────────────────────────────────────
#
# The fault the gate exists for. Every path is served: /platform (the
# cross-tenant super-admin console), /request-access (a public lead form that
# says "Elite Fleet Management" on a box that is neither multi-tenant nor
# white-label), /api/signup-request, /api/billing.
#
# The test has to fail on a "does not serve" check. It must NOT fail on a
# "serves" check — this probe is about under-blocking, and a failure on the
# rent-collection check would mean the probe was measuring something else.

echo
echo "== probe 1: the gate never blocks =="

p1_rc=0
run_test "never-blocks" "$TMP/never-blocks.out" || p1_rc=$?

if [[ "$p1_rc" -eq 0 ]]; then
  bad "the test PASSED with the gate never blocking — the 'does not serve' checks cannot fail"
  sed 's/^/      /' "$TMP/never-blocks.out"
else
  ok "the test fails when the gate never blocks"
fi

if failed_on "$TMP/never-blocks.out" "does not serve /platform"; then
  ok "the failure is on a check that the console is closed"
else
  bad "the failure is not attributed to a 'does not serve' check"
  sed 's/^/      /' "$TMP/never-blocks.out"
fi

if failed_on "$TMP/never-blocks.out" "serves /ops/dashboard"; then
  bad "the probe also failed a check that the operator's own console is served — it is measuring something else"
else
  ok "the checks that the operator's own surfaces are served still pass"
fi

# ── probe 2: the gate blocks everything ─────────────────────────────────────
#
# The other direction, and the one that bites hardest. A gate that blocks
# everything looks safe and is not: it takes the operator's own console, the
# arrears table, the driver's payment link and the receipt form with it.
#
# The table as it was written listed `/ops/billing`, so this is the fault
# that was one line away from shipping. The test has to fail on a "serves"
# check, and must NOT fail on a "does not serve" check.

echo
echo "== probe 2: the gate blocks everything =="

p2_rc=0
run_test "always-blocks" "$TMP/always-blocks.out" || p2_rc=$?

if [[ "$p2_rc" -eq 0 ]]; then
  bad "the test PASSED with the gate blocking everything — the 'serves' checks cannot fail"
  sed 's/^/      /' "$TMP/always-blocks.out"
else
  ok "the test fails when the gate blocks everything"
fi

if failed_on "$TMP/always-blocks.out" "serves /ops/dashboard"; then
  ok "the failure is on a check that the operator's own console is served"
else
  bad "the failure is not attributed to a 'serves' check"
  sed 's/^/      /' "$TMP/always-blocks.out"
fi

if failed_on "$TMP/always-blocks.out" "serves /ops/billing"; then
  ok "the failure is on a check that the rent collection is served"
else
  bad "the failure is not attributed to the rent-collection check"
  sed 's/^/      /' "$TMP/always-blocks.out"
fi

if failed_on "$TMP/always-blocks.out" "does not serve /platform"; then
  bad "the probe also failed a check that the console is closed — it is measuring something else"
else
  ok "the checks that the console is closed still pass"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
