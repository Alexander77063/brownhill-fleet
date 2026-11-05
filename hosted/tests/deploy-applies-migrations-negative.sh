#!/usr/bin/env bash
# hosted/tests/deploy-applies-migrations-negative.sh — prove the deploy gate
# can fail.
#
# WHY THIS TEST EXISTS
# --------------------
# A gate that cannot fail is not a gate. The deploy gate
# (hosted/tests/deploy-applies-migrations.sh) passes today. That is worth
# exactly nothing on its own: the same is true of a gate that was written to
# be green.
#
# So this test breaks the rule on purpose, in a copy of the tree, and
# requires the gate to NOTICE.
#
# THE DEFECT
# ----------
# The deploy stops applying the migrations — which is what the deploy did
# before it was fixed, and what it did on the live box through every
# deployment since the migrations were introduced:
#
#     cd /opt/brownhill/repo && git pull origin main && ./hosted/scripts/deploy-app.sh
#
# built the application, installed it and restarted the service, and left
# the schema where it was. The code went out; the migrations did not. The
# first person to find out was the first person to use the feature the new
# migration belonged to, and the answer they got was
#
#     ERROR: relation "password_reset_requests" does not exist
#
# The fault is injected by replacing the one line that runs the migrations
# with a no-op. That reproduces the pre-fix behaviour exactly: the step is
# still there, it still succeeds, and it applies nothing.
#
# It is not a rewrite of the deploy, and it is not a re-implementation of
# the gate. The real deploy script runs, against a real postgres, and the
# real gate has to notice.
#
# THE BASELINE
# ------------
# The gate is run against an UNMODIFIED copy first, and has to pass there.
# Without that step, a gate that failed for any reason at all would satisfy
# every check below — including the ones that are supposed to prove it
# detects this particular defect.
#
# And the broken run has to fail FOR THE RIGHT REASON: the gate's own
# output has to show that the deploy itself worked and that what was missing
# was the migration. A gate that failed because the deploy broke would be
# measuring something else.
#
# It needs bash, node and docker. It needs no box, no secrets and no stack.

set -uo pipefail

export MSYS_NO_PATHCONV=1

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not present; skipping deploy-applies-migrations-negative"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not present; skipping deploy-applies-migrations-negative"
  exit 0
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The one description of the tree a deploy reads.
# shellcheck source=hosted/tests/lib/deploy-tree.sh
source "$REPO/hosted/tests/lib/deploy-tree.sh"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

GATE="hosted/tests/deploy-applies-migrations.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/brownhill-deploy-negative.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Run the gate against a tree and say whether it passed.
gate_passes() {
  local tree="$1"
  DEPLOY_GATE_TREE="$tree" bash "$REPO/$GATE" >/dev/null 2>&1
}

# Run the gate against a tree and keep what it said.
gate_output() {
  local tree="$1" out="$2"
  DEPLOY_GATE_TREE="$tree" bash "$REPO/$GATE" >"$out" 2>&1
}

# ── 0: the gate passes against an unmodified copy ───────────────────────────

echo "== 0: the gate passes against an unmodified copy =="

make_deploy_tree "$WORK/clean" "$REPO"
if gate_passes "$WORK/clean"; then
  ok "the gate passes against a faithful copy of the tree"
else
  bad "the gate failed against an UNMODIFIED copy — every check below would be meaningless"
  DEPLOY_GATE_TREE="$WORK/clean" bash "$REPO/$GATE" 2>&1 | tail -30 | sed 's/^/      /'
  echo
  echo "Result: $PASS passed, $FAIL failed"
  exit 1
fi

# ── 1: the deploy stops applying the migrations ─────────────────────────────

echo
echo "== 1: a deploy that does not apply the migrations is noticed =="

make_deploy_tree "$WORK/no-migrations" "$REPO"

# The one line that runs the migrations becomes a no-op. Everything else
# about the deploy is untouched: it still builds, still installs and still
# restarts the service, exactly as it did before the fix.
DEPLOY_SCRIPT="$WORK/no-migrations/hosted/scripts/deploy-app.sh"
sed 's|bash "\$REPO/hosted/bootstrap/brownhill-bootstrap.sh"|true|' \
  "$DEPLOY_SCRIPT" > "$DEPLOY_SCRIPT.tmp" && mv "$DEPLOY_SCRIPT.tmp" "$DEPLOY_SCRIPT"

if grep -q 'brownhill-bootstrap.sh"; then' "$DEPLOY_SCRIPT"; then
  bad "the fault was not injected — the deploy still runs the migrations"
else
  ok "the migration step was taken out of the deploy"
fi

rc=0
gate_output "$WORK/no-migrations" "$WORK/broken.out" || rc=$?

if [ "$rc" -ne 0 ]; then
  ok "the gate fails when the deploy does not apply the migrations"
else
  bad "the gate PASSED with a deploy that applies no migrations — the check that the schema moves cannot fail"
  tail -30 "$WORK/broken.out" | sed 's/^/      /'
fi

# The failure has to be about the migration, not about the deploy breaking.
# If the deploy itself had failed, the gate would have caught the wrong
# thing entirely.
if grep -q 'ok: the deploy exited 0' "$WORK/broken.out"; then
  ok "the deploy itself still worked — what was missing was the migration"
else
  bad "the deploy did not succeed in the broken run — the gate is measuring something else"
  tail -30 "$WORK/broken.out" | sed 's/^/      /'
fi

if grep -q 'did not apply the pending migrations' "$WORK/broken.out"; then
  ok "the failure is on the check that the schema moved"
else
  bad "the failure is not attributed to the check that the schema moved"
  tail -30 "$WORK/broken.out" | sed 's/^/      /'
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
