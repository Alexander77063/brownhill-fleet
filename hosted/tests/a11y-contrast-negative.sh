#!/usr/bin/env bash
# hosted/tests/a11y-contrast-negative.sh — the negative case for the contrast
# gate.
#
# hosted/tests/a11y-contrast-negative.sh's counterpart is
# tests/unit/a11y-contrast.test.ts, run by `pnpm test:a11y`. That test reads
# the colour tokens out of src/app/globals.css and asserts that each one
# clears its WCAG threshold against the page background and the card surface.
#
# A gate that cannot fail is not a gate. The test has its own guards against
# the usual way a check goes hollow — a stylesheet it cannot read fails
# loudly, a token that has been renamed fails loudly, an override for a token
# that does not exist fails loudly. Those guards protect against the CHECK
# having gone blind. They cannot protect against the ARITHMETIC having gone
# wrong: a contrastRatio() that returned 21 for every pair would sail through
# every assertion in the file, every time, and the gate would report a
# perfect score on a palette that had collapsed.
#
# So this runs the real test against three deliberately broken stylesheets and
# requires it to fail on each, and on the right thing:
#
#   probe 1 — the light theme's muted text set back to the value that failed
#              AA once (4.07:1 on the page background) → the text ratio
#              assertion must fail and must name `muted`
#   probe 2 — the light theme's block deleted outright       → the test must
#              fail because it could not read the theme
#   probe 3 — the light theme's gold-text override misspelled → the test must
#              fail on the override that overrides nothing
#
# The stylesheets are copies in a scratch directory; the real one is never
# touched. The baseline is checked first, so "the test failed" means the
# probe caused it and not something that was already broken.
#
# It needs node, pnpm and a checkout. No docker, no database, no build, no
# stack — it takes seconds.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST="tests/unit/a11y-contrast.test.ts"
CSS="src/app/globals.css"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$REPO" || exit 1

if ! command -v pnpm >/dev/null 2>&1; then
  echo "  FAIL: pnpm is not on PATH, so the gate could not be run"
  exit 1
fi
if [[ ! -f "$CSS" ]]; then
  echo "  FAIL: $CSS does not exist, so the gate has nothing to check"
  exit 1
fi

# Run the contrast test against a stylesheet, and capture its output.
# Returns the exit code; the output lands in $TMP/run.out.
run_against() {
  local css="$1" out="$2" rc=0
  A11Y_CSS_PATH="$css" pnpm exec vitest run "$TEST" >"$out" 2>&1 || rc=$?
  return "$rc"
}

echo "== the baseline: the test passes on the stylesheet as it stands =="

base_rc=0
run_against "$REPO/$CSS" "$TMP/baseline.out" || base_rc=$?
if [[ "$base_rc" -eq 0 ]]; then
  ok "the contrast test passes on the real stylesheet"
else
  bad "the contrast test FAILS on the clean tree — the probes below would prove nothing"
  sed 's/^/      /' "$TMP/baseline.out"
fi

# --- probe 1: a text token that fails AA ------------------------------------
echo
echo "== probe 1: the light theme's muted text must be caught =="

probe1="$TMP/probe1.css"
# The value the light theme used to carry: 4.07:1 on the page background.
sed 's/--color-muted: #5f6a7c;/--color-muted: #6b7688;/' "$CSS" >"$probe1"
if cmp -s "$CSS" "$probe1"; then
  bad "the probe did not change the stylesheet — the rule it exercises is gone"
else
  rc=0
  run_against "$probe1" "$TMP/probe1.out" || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    bad "the test PASSED with a failing token present — the text ratio check cannot fail"
    sed 's/^/      /' "$TMP/probe1.out"
  else
    ok "the test fails when a text token drops below 4.5:1"
    if grep -q -- '--color-muted' "$TMP/probe1.out"; then
      ok "the failure names the token that broke"
    else
      bad "the failure does not name --color-muted"
      sed 's/^/      /' "$TMP/probe1.out"
    fi
    if grep -q '4\.07' "$TMP/probe1.out"; then
      ok "the failure reports the measured ratio"
    else
      bad "the failure does not report the measured ratio (expected 4.07)"
      sed 's/^/      /' "$TMP/probe1.out"
    fi
  fi
fi

# --- probe 2: the light theme is missing entirely ----------------------------
echo
echo "== probe 2: a missing light theme must be caught =="

probe2="$TMP/probe2.css"
# The light block is flat and ends at a line containing only `}`.
sed "/^\[data-theme='light'\] {$/,/^}$/d" "$CSS" >"$probe2"
if cmp -s "$CSS" "$probe2"; then
  bad "the probe did not remove the light theme — the rule it exercises is gone"
else
  rc=0
  run_against "$probe2" "$TMP/probe2.out" || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    bad "the test PASSED with the light theme missing — it would have checked the dark theme twice"
    sed 's/^/      /' "$TMP/probe2.out"
  else
    ok "the test fails when the light theme cannot be read"
  fi
fi

# --- probe 3: an override for a token that does not exist --------------------
echo
echo "== probe 3: a misspelled override must be caught =="

probe3="$TMP/probe3.css"
# Only the light block's override carries the light value, so the base block
# keeps its own.
sed 's/--color-gold-text: #7d6410;/--color-gold-txt: #7d6410;/' "$CSS" >"$probe3"
if cmp -s "$CSS" "$probe3"; then
  bad "the probe did not change the stylesheet — the rule it exercises is gone"
else
  rc=0
  run_against "$probe3" "$TMP/probe3.out" || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    bad "the test PASSED with a misspelled override — a typo would have been silent"
    sed 's/^/      /' "$TMP/probe3.out"
  else
    ok "the test fails when an override names a token that does not exist"
    if grep -q 'gold-txt' "$TMP/probe3.out"; then
      ok "the failure names the misspelled token"
    else
      bad "the failure does not name the misspelled token"
      sed 's/^/      /' "$TMP/probe3.out"
    fi
  fi
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
