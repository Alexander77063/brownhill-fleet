#!/usr/bin/env bash
# hosted/tests/hosted-smoke-on-main.sh — every workflow runs on the branch
# the deployment is cut from.
#
# WHY THIS TEST EXISTS
# --------------------
# The `hosted-smoke` workflow is the only job in this repository that runs the
# database-backed suites for real: the integration files, the row-level
# security proofs and the migration replay, all against a postgres that is
# provisioned but never seeded. Every other job either skips those files or
# stands in for them.
#
# It was triggered by `pull_request` and `workflow_dispatch` and nothing else.
# So it ran on a pull request and on nothing else: a push to `main` — the
# branch the deployment is cut from, the branch the release is made from, the
# branch the handover describes — brought the job up for nobody. The
# database-backed suite was proven on the branch and then not proven again on
# the thing that ships.
#
# That is the same fault this repository has already paid for once, one level
# down. The workflow's `pull_request` filter used to name the schema, the
# scripts and the hosted box, and nothing under `src/` — so a change to the
# ledger's own code never brought the job up at all, and the database-backed
# tests ran nowhere in CI for weeks. The filter was widened. The set of
# triggers was not, and the gap was silent: nothing failed, because nothing
# was supposed to fail.
#
# So the rule this gate enforces is that the branch the deployment is cut
# from is a branch every job runs on, and that the one job which cannot run
# there stays opt-in.
#
# THE CHECKS
# ----------
#   1. Every workflow in .github/workflows/ declares a push trigger. A
#      workflow with no push trigger is a workflow that never runs on main.
#
#   2. That trigger names `main`, and it is not narrowed by a paths filter.
#      A filter on the push trigger would reproduce the fault this gate
#      exists to catch, one level up: the job would run on some pushes and
#      not on others, and which ones would be decided by a list. The
#      `pull_request` trigger keeps its filter — a pull request that touches
#      nothing this repository owns does not need the hosted stack — but a
#      push to main is the branch being changed, so it runs.
#
#   3. The production-shaped job stays opt-in. It is pinned to
#      `self-hosted, pulsar`, no runner is registered for that label, and a
#      job queued against a runner that does not exist holds its concurrency
#      group until GitHub cancels it 24 hours later. So the guard on that job
#      is load-bearing for every push to main, not just for the workflow
#      dispatch: without it, the first push to main would queue a job that
#      never starts, and the run would never report green.
#
# A workflow that is genuinely not wanted on main — a release cut, say —
# says so here, and this gate is changed when it does. The default is that
# main is the branch every job runs on.
#
# It is a static check over the workflow files: no docker, no database, no
# secrets, and about a second of work.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

WORKFLOWS_DIR=".github/workflows"

# ── reading a workflow file ─────────────────────────────────────────────────
#
# These are not a YAML parser. They read the shape of the file as it is
# written, which is the shape this repository writes it in: a key at the left
# margin, its block indented under it. That is enough to answer the three
# questions this gate asks, and it means the gate does not need a YAML
# library the repository does not otherwise depend on.

# The lines of the block under a key, at a given indentation.
#
#   yaml_block INDENT KEY      (reads stdin)
#
# The block is the run of lines indented further than INDENT, starting after
# the line "<INDENT spaces>KEY:". A blank line and a comment do not end it;
# the next key at or above INDENT does. A key written with a value on its own
# line ("key: value") has no block, and yields nothing.
yaml_block() {
  local indent="$1" key="$2"
  awk -v indent="$indent" -v key="$key" '
    BEGIN { pad = ""; for (i = 0; i < indent; i++) pad = pad " "; inside = 0 }
    !inside {
      if ($0 ~ "^" pad key ":[[:space:]]*$") inside = 1
      next
    }
    {
      if ($0 ~ /^[[:space:]]*$/) { print; next }
      if ($0 ~ /^[[:space:]]*#/) { print; next }
      match($0, /^ */)
      if (RLENGTH <= indent) exit
      print
    }
  '
}

# The value of a key inside a block: what is written on the line, or the list
# written underneath it.
#
#   yaml_value INDENT KEY      (reads stdin)
yaml_value() {
  local indent="$1" key="$2"
  awk -v indent="$indent" -v key="$key" '
    BEGIN { pad = ""; for (i = 0; i < indent; i++) pad = pad " " }
    {
      line = $0
      sub(/[[:space:]]+#.*$/, "", line)
      if (line ~ "^" pad key ":") {
        rest = substr(line, length(pad) + length(key) + 2)
        gsub(/^[[:space:]]+/, "", rest)
        gsub(/[[:space:]]+$/, "", rest)
        if (rest != "") { print rest; exit }
        inlist = 1
        next
      }
      if (inlist) {
        if (line ~ /^[[:space:]]*$/) next
        if (line ~ /^[[:space:]]*-[[:space:]]*/) {
          v = line
          sub(/^[[:space:]]*-[[:space:]]*/, "", v)
          gsub(/^[[:space:]]+/, "", v)
          gsub(/[[:space:]]+$/, "", v)
          print v
          next
        }
        exit
      }
    }
  '
}

# The items of a list, whatever shape the list was written in: inline
# ("[main, develop]"), single ("main") or one per line underneath.
list_items() {
  tr ',' '\n' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
          -e 's/^\[//' -e 's/\]$//' \
          -e 's/^"//' -e 's/"$//' \
          -e "s/^'//" -e "s/'\$//" \
    | grep -v '^$'
}

# The `push:` trigger of a workflow, as a block of lines.
push_block_for() {
  yaml_block 0 on < "$1" | yaml_block 2 push
}

# ── the workflows ───────────────────────────────────────────────────────────

mapfile -t WORKFLOWS < <(ls -1 "$WORKFLOWS_DIR"/*.yml 2>/dev/null | sort)

# ── 1. every workflow is triggered by a push ────────────────────────────────

echo "== 1: every workflow declares a push trigger =="

if [ "${#WORKFLOWS[@]}" -eq 0 ]; then
  bad "no workflow file was found in $WORKFLOWS_DIR — the gate has looked at nothing"
else
  ok "the gate read ${#WORKFLOWS[@]} workflow file(s) from $WORKFLOWS_DIR"
fi

for wf in "${WORKFLOWS[@]}"; do
  name="$(basename "$wf")"
  block="$(push_block_for "$wf")"
  if [ -z "$block" ]; then
    bad "$name declares no push trigger — a push to main brings it up for nobody"
  else
    ok "$name declares a push trigger"
  fi
done

# ── 2. the push trigger names main, and is not narrowed ─────────────────────

echo
echo "== 2: the push trigger names main, and is not narrowed by a paths filter =="

for wf in "${WORKFLOWS[@]}"; do
  name="$(basename "$wf")"
  block="$(push_block_for "$wf")"
  if [ -z "$block" ]; then
    bad "$name has no push trigger to narrow — see check 1"
    continue
  fi

  branches="$(yaml_value 4 branches < <(printf '%s\n' "$block") | list_items)"
  if printf '%s\n' "$branches" | grep -qx 'main'; then
    ok "$name's push trigger names main"
  else
    bad "$name's push trigger names [$(printf '%s' "$branches" | tr '\n' ' ')], not main"
  fi

  if printf '%s\n' "$block" | grep -qE '^[[:space:]]+paths:'; then
    bad "$name's push trigger is narrowed by a paths filter — a push that touches nothing in the list brings the job up for nobody"
  else
    ok "$name's push trigger is not narrowed by a paths filter"
  fi
done

# ── 3. the production-shaped job stays opt-in ───────────────────────────────

echo
echo "== 3: the production-shaped job stays opt-in =="

prod="$(yaml_block 2 hosted-smoke-production < "$WORKFLOWS_DIR/hosted-smoke.yml")"
if [ -z "$prod" ]; then
  ok "the hosted-smoke workflow has no production-shaped job — there is nothing to guard"
else
  if printf '%s\n' "$prod" | grep -qE "^[[:space:]]+if:.*workflow_dispatch"; then
    ok "the production-shaped job is guarded by workflow_dispatch — a push to main cannot start it"
  else
    bad "the production-shaped job is not guarded by workflow_dispatch — a push to main would queue it against a runner that is not registered, and hold its concurrency group for 24 hours"
  fi
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
