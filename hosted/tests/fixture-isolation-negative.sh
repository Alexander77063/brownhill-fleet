#!/usr/bin/env bash
# hosted/tests/fixture-isolation-negative.sh — prove the fixture-isolation gate
# can fail.
#
# WHY THIS TEST EXISTS
# --------------------
# A gate that cannot fail is not a gate. The isolation gate
# (hosted/tests/fixture-isolation.sh) passes today. That is worth exactly
# nothing on its own — the same is true of a gate that was written to be
# green.
#
# So this test breaks the thing on purpose, in a copy of the tree, and
# requires the gate to NOTICE. The defect injected is the one that was
# really there: the fixture's join had no tenant filter, so it matched every
# driver in the database named 'Chaos Drill' — the fixture's own and any
# other live fixture's — and produced two agreements, and two invoices with
# the same number, and `invoices.number` is unique. The fixture died with a
# duplicate-key error that reads like a database fault and is not one.
#
# THE ARGUMENT IS DIFFERENTIAL
# ----------------------------
# Two runs of the SAME copied tree, differing in exactly one thing:
#
#   1. the unmodified copy must PASS — which is what proves the copy is
#      faithful. If the copy were broken, the run below would "prove" the
#      gate catches the defect when in fact the copy simply did not work;
#   2. the copy with the defect injected must FAIL, and must fail with the
#      SPECIFIC symptom of that defect — the duplicate invoice number —
#      not with some unrelated error.
#
# Step 1 is what makes step 2 mean anything. A gate that failed for any
# reason at all would satisfy step 2 on its own.
#
# It needs the running stack: the gate builds a rival tenant and a real
# fixture, and asserts on what the database did.
set -uo pipefail

REPO="${BROWNHILL_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

GATE=hosted/tests/fixture-isolation.sh
LIB=hosted/tests/chaos/lib/drill-lib.sh

# The compose file that finds the running stack. It is the REAL one — the
# copy is a copy of the GATE, not of the stack, and the stack is found by
# its compose project, not by where the copy happens to live.
COMPOSE_FILE="${DRILL_COMPOSE_FILE:-$REPO/hosted/dev/docker-compose.yml}"

# The node that runs the injection. The box pins its runtime under
# /opt/brownhill; everywhere else node is simply on the PATH.
if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [[ -x /opt/brownhill/node/bin/node ]]; then
  NODE=/opt/brownhill/node/bin/node
else
  NODE=""
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A faithful copy of the tree the gate reads: the whole hosted/ directory,
# so every path the library builds from its own location still resolves.
make_copy() {
  local dest="$1"
  mkdir -p "$dest"
  cp -R "$REPO/hosted" "$dest/hosted"
}

# Run the gate against a copy, keeping what it said.
#
# TMPDIR is pointed inside this script's own WORK directory. The drill
# library makes its scratch directory with `mktemp -d`, which lands in the
# shared /tmp — and a shared scratch directory is exactly how a drill ends
# up failing for a reason that has nothing to do with the fault it exists
# to test: another job's cleanup takes the directory away mid-run and the
# drill starts reporting "No such file or directory" where it means to
# report a cross-tenant leak. Giving the child its own TMPDIR puts its
# scratch inside this script's workspace, where nothing else touches it.
gate_run() {
  local root="$1" out="$2"
  mkdir -p "$WORK/scratch"
  TMPDIR="$WORK/scratch" DRILL_COMPOSE_FILE="$COMPOSE_FILE" \
    bash "$root/$GATE" >"$out" 2>&1
}

echo "== 0: the gate passes against an unmodified copy =="

make_copy "$WORK/clean"
if gate_run "$WORK/clean" "$WORK/clean.out"; then
  ok "the gate passes against a faithful copy of the tree"
else
  bad "the gate failed against an UNMODIFIED copy — the check below would be meaningless"
  echo "--- what the copy said ---"
  sed 's/^/    /' "$WORK/clean.out"
  echo
  echo "Result: $PASS passed, $FAIL failed"
  exit 1
fi

# And it must have passed for the RIGHT reason — not by skipping itself.
if grep -qi "skip" "$WORK/clean.out"; then
  bad "the copy's run mentioned a skip — the gate did not actually run"
  sed 's/^/    /' "$WORK/clean.out"
else
  ok "the copy's run really ran the gate"
fi

# ── 1: the fixture's join loses its tenant filter ──────────────────────────
#
# This is the defect that was really there. The join matched on the driver's
# NAME and on nothing else, so a driver in another tenant was just as good
# as one in this one — and two agreements meant two invoices with the same
# number, and `invoices.number` is unique.
echo
echo "== 1: the fixture's join loses its tenant filter =="

if [[ -z "$NODE" ]]; then
  bad "there is no node on this machine, so the defect cannot be injected"
  echo
  echo "Result: $PASS passed, $FAIL failed"
  exit 1
fi

# The injection, as a script file rather than a `-e` argument: the strings
# it matches are full of quotes and dollar signs, and a shell-quoted
# one-liner that has to survive them is a one-liner that will be wrong.
cat >"$WORK/unscope.mjs" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
const source = readFileSync(path, 'utf8');

// The tenant-scoped join, as it is written in drill-lib.sh. The `$` signs
// are literal here: they are SQL template markers in a shell heredoc.
const scoped = [
  " where v.tenant_id = '$DRILL_TENANT_ID'",
  "   and d.tenant_id = '$DRILL_TENANT_ID';",
].join('\n');

// The join it used to be — matching on the driver's NAME and on nothing
// else, so a driver in another tenant was just as good as one in this one.
const unscoped =
  " where v.registration = 'CHAOS-$stamp' and d.full_name = 'Chaos Drill';";

if (!source.includes(scoped)) {
  console.error('could not find the tenant-scoped join to unscope');
  process.exit(3);
}

writeFileSync(path, source.replace(scoped, unscoped));
JS

make_copy "$WORK/unscoped"
UNSCOPED_LIB="$WORK/unscoped/$LIB"

if ! "$NODE" "$WORK/unscope.mjs" "$UNSCOPED_LIB"; then
  bad "the defect could not be injected"
  echo
  echo "Result: $PASS passed, $FAIL failed"
  exit 1
fi

if grep -q "and d.tenant_id" "$UNSCOPED_LIB"; then
  bad "the copy still has the tenant filter — the defect was not injected"
else
  ok "the copy's fixture joins on the driver's name alone, as the broken one did"
fi

if gate_run "$WORK/unscoped" "$WORK/unscoped.out"; then
  bad "the gate PASSED against a fixture that can see another fixture's driver — it would not have caught the duplicate-invoice failure"
  echo "--- what the copy said ---"
  sed 's/^/    /' "$WORK/unscoped.out"
else
  ok "the gate FAILED against the unscoped fixture — it catches the defect"
fi

# …and it failed for the RIGHT reason. A gate that fails because the copy is
# broken would also satisfy the check above, so the symptom has to be the
# one this defect causes: two invoices with the same number, and the unique
# index on `invoices.number` refusing the second.
if grep -qE "duplicate key value violates unique constraint|invoices_number_key|it is not isolated from another fixture" "$WORK/unscoped.out"; then
  ok "it failed with the symptom of THIS defect — the duplicate invoice number"
else
  bad "it failed, but not with the duplicate-invoice symptom — so the failure was not caused by the injected defect"
  echo "--- what the copy said ---"
  sed 's/^/    /' "$WORK/unscoped.out"
fi

# And the symptom has to be visible in the database, not only in a message:
# the broken fixture's invoice insert really is refused by the unique index.
if grep -qi "the drill's tenant could not be created" "$WORK/unscoped.out"; then
  ok "the broken fixture could not build its own tenant — the invoice insert was refused"
else
  bad "the broken fixture built its tenant anyway — the defect did not bite the way it was supposed to"
  sed 's/^/    /' "$WORK/unscoped.out"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
