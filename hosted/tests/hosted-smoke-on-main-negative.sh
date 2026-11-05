#!/usr/bin/env bash
# hosted/tests/hosted-smoke-on-main-negative.sh — the negative case for the
# branch-coverage gate.
#
# hosted/tests/hosted-smoke-on-main.sh decides whether every workflow in this
# repository runs on the branch the deployment is cut from. A gate that cannot
# fail is not a gate: if the trigger went quiet — the push block removed, the
# branch renamed, the paths filter put back — and the gate quietly stopped
# looking, it would report a healthy pipeline on every commit, forever, and
# everybody would believe it.
#
# That is not a hypothetical failure. It is what happened here. The
# `hosted-smoke` workflow was triggered by a pull request and nothing else, so
# the database-backed suites ran on branches and never on main, and nothing
# anywhere said so. The earlier version of the same fault was worse: the
# pull-request filter named the schema and nothing under `src/`, so the job
# did not come up for the ledger's own code changes either, and the
# database-backed tests ran nowhere in CI for weeks.
#
# So this runs the gate against trees that DO have the fault, and requires it
# to fail on the right check each time.
#
# The trees are copies, not edits of the repository. A negative gate that
# modified tracked files in place could leave the tree broken if it were
# interrupted, and could damage the very thing it is meant to be checking.
#
# It needs bash and a checkout. It needs no docker, no database, no secrets
# and no stack, and it takes seconds.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="hosted/tests/hosted-smoke-on-main.sh"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The files the gate reads. A copy of the tree with these in it is enough to
# run the gate, and nothing else.
#
#   hosted/tests/hosted-smoke-on-main.sh   the gate itself
#   .github/workflows/*.yml                 the workflows it reads
make_tree() {
  local root="$1"
  mkdir -p "$root/hosted/tests" "$root/.github/workflows"

  cp "$REPO/$GATE" "$root/hosted/tests/"
  cp "$REPO/.github/workflows/"*.yml "$root/.github/workflows/"
}

# The check the gate was in when it failed. The gate prints "== N: …" before
# each group of checks, and the failure appears under the header it belongs
# to.
failing_section() {
  awk '
    /^== [0-9]+:/ { split($0, a, " "); section = a[2]; sub(/:$/, "", section); next }
    /^  FAIL:/ { if (section != "") { print section; exit } }
  ' "$1"
}

# Run the gate in a freshly built tree, with the tree already perturbed.
#
#   $1  the tree
#   $2  the probe's name
#   $3  the check the failure is expected to land in
run_probe() {
  local root="$1" name="$2" expected="$3"
  local out="$TMP/$name.out"
  local rc=0

  echo
  echo "== probe $name: the gate must fail in check $expected =="

  bash "$root/$GATE" >"$out" 2>&1 || rc=$?

  if [[ "$rc" -eq 0 ]]; then
    bad "the gate PASSED with the fault present — check $expected cannot fail"
    sed 's/^/      /' "$out"
    return
  fi
  ok "the gate fails when the fault is present"

  local section
  section="$(failing_section "$out")"
  if [[ "$section" == "$expected" ]]; then
    ok "the failure is attributed to check $expected"
  else
    bad "the failure is attributed to check ${section:-none}, not check $expected"
    sed 's/^/      /' "$out"
  fi
}

# ── the baseline ────────────────────────────────────────────────────────────

echo "== the baseline: the gate passes on the tree as it stands =="

baseline_rc=0
bash "$REPO/$GATE" >"$TMP/baseline.out" 2>&1 || baseline_rc=$?
if [[ "$baseline_rc" -eq 0 ]]; then
  ok "the gate passes on the tree as it stands"
else
  bad "the gate FAILS on the clean tree — the probes below would prove nothing"
  sed 's/^/      /' "$TMP/baseline.out"
fi

# And that a copy of the tree behaves the same way, so a failure in a probe
# is the probe's doing and not the copy's.
COPY="$TMP/clean-copy"
make_tree "$COPY"
copy_rc=0
bash "$COPY/$GATE" >"$TMP/copy.out" 2>&1 || copy_rc=$?
if [[ "$copy_rc" -eq 0 ]]; then
  ok "the gate passes on an unperturbed copy of the tree"
else
  bad "the gate FAILS on an unperturbed copy — the copy is not faithful"
  sed 's/^/      /' "$TMP/copy.out"
fi

# ── probe 1: the push trigger is gone ──────────────────────────────────────
#
# This is the fault the gate was written for: the workflow is triggered by a
# pull request and by nothing else, so main — the branch the deployment is
# cut from — is covered by nothing.

echo
echo "== probe 1: the hosted smoke stops being triggered by a push =="

P1="$TMP/probe-no-push"
make_tree "$P1"
awk '
  /^  push:$/ { skip = 1; next }
  skip {
    if ($0 ~ /^[[:space:]]*$/) next
    if ($0 ~ /^[[:space:]]*#/) next
    match($0, /^ */)
    if (RLENGTH > 2) next
    skip = 0
  }
  { print }
' "$P1/.github/workflows/hosted-smoke.yml" > "$P1/.github/workflows/hosted-smoke.yml.new"
mv "$P1/.github/workflows/hosted-smoke.yml.new" "$P1/.github/workflows/hosted-smoke.yml"
if grep -q '^  push:$' "$P1/.github/workflows/hosted-smoke.yml"; then
  bad "the probe did not take — the push trigger is still there"
else
  run_probe "$P1" no-push 1
fi

# ── probe 2: the push trigger names another branch ─────────────────────────
#
# The trigger is there and it is the right shape, but it is the wrong branch.
# The job runs on a branch nobody deploys from.

echo
echo "== probe 2: the push trigger names a branch that is not main =="

P2="$TMP/probe-other-branch"
make_tree "$P2"
sed -i 's|^    branches: \[main\]$|    branches: [develop]|' "$P2/.github/workflows/hosted-smoke.yml"
if grep -q '^    branches: \[develop\]$' "$P2/.github/workflows/hosted-smoke.yml"; then
  run_probe "$P2" other-branch 2
else
  bad "the probe did not take — the push trigger still names main"
fi

# ── probe 3: the push trigger is narrowed by a paths filter ─────────────────
#
# The trigger is there, it names main, and it is narrowed — which is the
# earlier fault in this repository, one level up. The job would run on some
# pushes and not on others, and which ones would be decided by a list.

echo
echo "== probe 3: the push trigger is narrowed by a paths filter =="

P3="$TMP/probe-narrowed"
make_tree "$P3"
sed -i "s|^    branches: \[main\]$|    branches: [main]\n    paths:\n      - 'src/**'|" \
  "$P3/.github/workflows/hosted-smoke.yml"
if grep -q '^    paths:$' "$P3/.github/workflows/hosted-smoke.yml"; then
  run_probe "$P3" narrowed 2
else
  bad "the probe did not take — the push trigger is not narrowed"
fi

# ── probe 4: the production-shaped job loses its guard ──────────────────────
#
# The guard is load-bearing for every push to main, not only for the manual
# dispatch. The job is pinned to a runner that is not registered, so a job
# queued against it holds its concurrency group until GitHub cancels it 24
# hours later — and the run never reports green.

echo
echo "== probe 4: the production-shaped job loses its opt-in guard =="

P4="$TMP/probe-unguarded"
make_tree "$P4"
sed -i "/^    if: github.event_name == 'workflow_dispatch'/d" \
  "$P4/.github/workflows/hosted-smoke.yml"
if grep -q "^    if: github.event_name == 'workflow_dispatch'" "$P4/.github/workflows/hosted-smoke.yml"; then
  bad "the probe did not take — the production job is still guarded"
else
  run_probe "$P4" unguarded 3
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
