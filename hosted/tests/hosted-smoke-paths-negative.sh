#!/usr/bin/env bash
# hosted/tests/hosted-smoke-paths-negative.sh — the negative case for the
# paths-filter gate.
#
# hosted/tests/hosted-smoke-paths.sh decides whether the pull-request filter
# on the `hosted-smoke` job names everything that job reads. A gate that
# cannot fail is not a gate: if the filter were narrowed to exclude a
# directory the job reads, and the gate quietly stopped looking, it would
# report a healthy pipeline on every commit, forever, and everybody would
# believe it.
#
# That is not a hypothetical failure. It is what this repository has already
# paid for twice, one level down. The filter used to name the schema and
# nothing under `src/`, so the ledger's own code never brought the job up at
# all, and the database-backed tests ran nowhere in CI for weeks. The filter
# was widened — and the set of paths it names is not, and the gap is silent:
# nothing fails, because nothing is supposed to fail.
#
# So this runs the gate against trees that DO have the fault, and requires it
# to fail on the right check each time.
#
# The trees are copies, not edits of the repository. A negative gate that
# modified tracked files in place could leave the tree broken if it were
# interrupted, and could damage the very thing it is meant to be checking.
#
# It needs bash and a checkout. It needs no docker, no database, no secrets
# and no stack, and it takes under a minute.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="hosted/tests/hosted-smoke-paths.sh"
WORKFLOW=".github/workflows/hosted-smoke.yml"
UNFILTERED=".github/workflows/unit-tests.yml"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The tree the gate runs against.
#
# The gate asks the repository two questions — which files are tracked, and
# which paths the hosted tree names — so the copy has to BE a repository, with
# the same files tracked in it. It is built from `git ls-files`, so the copy
# is the repository and not a guess about it.
make_tree() {
  local root="$1"
  mkdir -p "$root"

  local -a TRACKED=()
  mapfile -d '' -t TRACKED < <(git -C "$REPO" ls-files -z)

  # The tracked paths, as a set, so the lookups below are one lookup each.
  local -A IS_TRACKED=()
  local f
  for f in ${TRACKED[@]+"${TRACKED[@]}"}; do
    IS_TRACKED["$f"]=1
  done

  # The two files this branch adds. Before the branch is committed they are
  # not in the tracked list and have to be named; once it is committed they
  # are, and naming them a second time makes `cp` warn about a source file
  # specified more than once. A gate that prints a warning every time it
  # runs is a gate whose output stops being read, so each one is added only
  # when the repository does not have it yet.
  local -a EXTRA=(
    "hosted/tests/hosted-smoke-paths.sh"
    "hosted/tests/hosted-smoke-paths-negative.sh"
  )
  local -a NOT_TRACKED=()
  local e
  for e in "${EXTRA[@]}"; do
    if [ -z "${IS_TRACKED[$e]+x}" ]; then
      TRACKED+=("$e")
      NOT_TRACKED+=("$e")
    fi
  done

  ( cd "$REPO" && cp --parents ${TRACKED[@]+"${TRACKED[@]}"} "$root" )

  # The gate reads the repository's own file list, so the copy has to BE a
  # repository, with the same files tracked in it.
  #
  # The index is fed in rather than built by `git add`. `git add` writes an
  # object for every file, and on this machine one of those writes is
  # refused by a file lock every so often — which leaves the copy with an
  # EMPTY index, and the gate then answers "no repository root was found to
  # check" for a tree that has nine hundred files in it. Feeding the index in
  # records the paths and writes nothing but the index itself, which is the
  # only thing the gate ever reads.
  local out tracked
  ( cd "$root" && git init -q 2>&1 ) | head -2
  {
    git -C "$REPO" ls-files -s | awk '{ printf "%s %s\t%s\n", $1, $2, $4 }'
    # The files this branch adds, which the repository does not track yet:
    # an empty blob, which records the path without writing an object.
    for e in ${NOT_TRACKED[@]+"${NOT_TRACKED[@]}"}; do
      printf '100644 %s\t%s\n' "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" "$e"
    done
  } > "$root/.index-info"
  out="$( cd "$root" && git update-index --info-only --index-info < "$root/.index-info" 2>&1 )"
  rm -f "$root/.index-info"
  tracked="$( cd "$root" && git ls-files 2>/dev/null | wc -l )"
  if [ "$tracked" -lt 1 ]; then
    bad "the copy at $root is not a repository with any tracked file — the probes below would prove nothing"
    [ -n "$out" ] && echo "      git said: $out"
    return 1
  fi
  return 0
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
if make_tree "$COPY"; then
  copy_rc=0
  bash "$COPY/$GATE" >"$TMP/copy.out" 2>&1 || copy_rc=$?
  if [[ "$copy_rc" -eq 0 ]]; then
    ok "the gate passes on an unperturbed copy of the tree"
  else
    bad "the gate FAILS on an unperturbed copy — the copy is not faithful"
    sed 's/^/      /' "$TMP/copy.out"
  fi
fi

# ── probe 1: the filter is narrowed ─────────────────────────────────────────
#
# The fault the gate was written for. The filter drops a directory the job
# reads — `src/**`, which is the application the job builds, serves and
# tests — so a pull request that changes the ledger's own code no longer
# brings the hosted job up, and the pull request says green.

echo
echo "== probe 1: the filter is narrowed and leaves out what the job reads =="

P1="$TMP/probe-narrowed"
if make_tree "$P1"; then
  sed -i "\|src/\*\*|d" "$P1/$WORKFLOW"
  if grep -q "src/\*\*" "$P1/$WORKFLOW"; then
    bad "the probe did not take — src/** is still in the filter"
  else
    run_probe "$P1" narrowed 2
  fi
fi

# ── probe 2: the filter drops a file the COMMANDS read ──────────────────────
#
# `.dockerignore` is not named by the hosted tree — the COMMANDS read it, not
# the gates — so it is checked separately, and this probe is the one that
# proves that separate check can fail.

echo
echo "== probe 2: the filter drops the configuration the commands read =="

P2="$TMP/probe-no-dockerignore"
if make_tree "$P2"; then
  sed -i "\|'\.dockerignore'|d" "$P2/$WORKFLOW"
  if grep -q "dockerignore" "$P2/$WORKFLOW"; then
    bad "the probe did not take — .dockerignore is still in the filter"
  else
    run_probe "$P2" no-dockerignore 3
  fi
fi

# ── probe 3: the filter names nothing at all ─────────────────────────────────
#
# The coarsest version of the same fault: the filter is gone, so the job
# never comes up for any pull request, and the gate has nothing to check.

echo
echo "== probe 3: the filter names no paths at all =="

P3="$TMP/probe-no-filter"
if make_tree "$P3"; then
  awk '
    /^    paths:[[:space:]]*$/ { skip = 1; next }
    skip {
      if ($0 ~ /^[[:space:]]*$/) next
      match($0, /^ */)
      if (RLENGTH <= 4) { skip = 0; print; next }
      next
    }
    { print }
  ' "$P3/$WORKFLOW" > "$P3/$WORKFLOW.new"
  mv "$P3/$WORKFLOW.new" "$P3/$WORKFLOW"
  if grep -q "^    paths:" "$P3/$WORKFLOW"; then
    bad "the probe did not take — the filter is still there"
  else
    run_probe "$P3" no-filter 1
  fi
fi

# ── probe 4: a whole-repository gate goes behind the filter ────────────────
#
# The environment-variable gate scans EVERY tracked file, because the rule it
# enforces cannot tell which file a setting was written in. No list of paths
# can cover the whole tree, so such a gate has to live in a workflow that no
# filter can narrow. Put it back behind the filter and it is a gate that
# looks for the whole repository in a job that only comes up for part of it.

echo
echo "== probe 4: a whole-repository gate goes behind the filter =="

P4="$TMP/probe-whole-tree-behind-filter"
if make_tree "$P4"; then
  awk '
    !done && /^      - name:/ {
      print "      - name: The deployment settings"
      print "        run: bash hosted/tests/env-var-names.sh"
      done = 1
    }
    { print }
  ' "$P4/$WORKFLOW" > "$P4/$WORKFLOW.new"
  mv "$P4/$WORKFLOW.new" "$P4/$WORKFLOW"
  if grep -qF "bash hosted/tests/env-var-names.sh" "$P4/$WORKFLOW"; then
    run_probe "$P4" whole-tree-behind-filter 4
  else
    bad "the probe did not take — the whole-repository gate is not in the hosted job"
  fi
fi

# ── probe 5: a whole-repository gate stops running on every pull request ────
#
# The other half of the same fault: the gate that scans the whole repository
# is simply not run any more, and the job that cannot see most of the
# repository does not carry it either. Nothing fails, because nothing is
# supposed to fail.

echo
echo "== probe 5: a whole-repository gate stops running on every pull request =="

P5="$TMP/probe-whole-tree-not-run"
if make_tree "$P5"; then
  awk '
    /^      - name: One spelling, and one wiring/ { skip = 1; next }
    skip {
      if (/^        run: bash hosted\/tests\/env-var-names\.sh$/) { skip = 0 }
      next
    }
    { print }
  ' "$P5/$UNFILTERED" > "$P5/$UNFILTERED.new"
  mv "$P5/$UNFILTERED.new" "$P5/$UNFILTERED"
  if grep -qF "bash hosted/tests/env-var-names.sh" "$P5/$UNFILTERED"; then
    bad "the probe did not take — the whole-repository gate still runs there"
  else
    run_probe "$P5" whole-tree-not-run 5
  fi
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
