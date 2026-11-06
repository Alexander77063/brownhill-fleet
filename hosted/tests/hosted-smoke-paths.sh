#!/usr/bin/env bash
# hosted/tests/hosted-smoke-paths.sh — the hosted job comes up for everything
# it reads.
#
# WHY THIS TEST EXISTS
# --------------------
# The `hosted-smoke` job is the only job in this repository that runs the
# database-backed suites for real: the integration files, the row-level
# security proofs and the migration replay, against a postgres that is
# provisioned but never seeded. It is narrowed by a `paths` filter, so that a
# pull request which touches nothing this repository owns does not pay for a
# stack it cannot break.
#
# A filter is a list of files, and a list is only as good as what it leaves
# out. This job's filter used to name the schema, the scripts, the hosted box
# and three hand-picked directories under `src/` — and it left out the
# application's own middleware, the repository's own scripts, the helper that
# decides whether fourteen database-backed files run or silently skip, the unit
# tests the job also runs, `vercel.json` (which the cron gate compares against
# the timers on the box), the demo data the seed gate feeds in, and the build
# configuration. Every one of those could break this job without the job
# coming up to find out, so the pull request said green and `main` said red.
#
# That is the same fault this repository has already paid for twice, one
# level down: the filter used to name the schema and nothing under `src/`, so
# the ledger's own code never brought the job up at all, and the
# database-backed tests ran nowhere in CI for weeks. The filter was widened.
# The set of paths it names is not, and the gap is silent: nothing fails,
# because nothing is supposed to fail.
#
# So the filter is now HELD TO ACCOUNT rather than trusted. Three things are
# checked, and all of them are derived from the repository rather than
# declared:
#
#   1. Every path the hosted box reads is inside the filter. The roots are
#      read out of the hosted tree itself, so a new gate that reads a new
#      directory brings the job up automatically — and if the filter is
#      narrowed to exclude it, this gate fails.
#
#   2. The configuration the job's COMMANDS read is inside the filter. Those
#      are named here, because nothing in the hosted tree names them — the
#      commands do — and each one is checked against the command that reads
#      it, so an entry cannot outlive its reason.
#
#   3. No gate that reads the WHOLE repository runs behind the filter. The
#      filter is a list of paths, so it cannot cover the whole tree; a gate
#      that reads the whole tree therefore has to live in a workflow that no
#      filter can narrow. The environment-variable gate is one: it scans every
#      tracked file, because the rule it enforces cannot tell which file a
#      setting was written in. It used to live here, which is why the filter
#      could never be made correct.
#
# A COMMENT IS NOT A READ. `hosted/scripts/build-app.mjs` mentions
# `docs/product/02-trd.md` in a note about where a rule is written down; a
# comment cannot open a file, and a filter that carried every path a comment
# mentions would bring the whole hosted stack up for every documentation
# change. So the comment lines are removed before the paths are read out.
#
# It is a static check over the repository: no docker, no database, no
# secrets, and about a second of work.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

WORKFLOW=".github/workflows/hosted-smoke.yml"
UNFILTERED_WORKFLOW=".github/workflows/unit-tests.yml"

# ── reading the filter ──────────────────────────────────────────────────────
#
# The same shape the repository writes its workflow files in: a key at the
# left margin, its block indented under it. A full YAML parser is not needed
# to answer "which paths does the pull-request trigger name", and not having
# one keeps the gate a shell script that runs anywhere.

# The lines of the block under a key, at a given indentation.
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

# ── the glob matcher ────────────────────────────────────────────────────────
#
# A filter entry is a git path pattern. This turns one into a regular
# expression: `**` crosses directory boundaries, `*` does not, and every
# other metacharacter is literal.

glob_regex() {
  local g
  g="$(printf '%s' "$1" | sed -e 's/[][\\.^$+(){}|]/\\&/g')"
  g="${g//\*\*/@GLOBSTAR@}"
  g="${g//\*/[^/]*}"
  g="${g//@GLOBSTAR@/.+}"
  printf '%s' "$g"
}

# The compiled form of the filter: one regular expression per entry, built
# ONCE. Compiling them per path costs a `sed` per entry per path, and this
# check asks about hundreds of paths.
REGEXES=()
compile_entries() {
  local entry
  for entry in ${ENTRIES[@]+"${ENTRIES[@]}"}; do
    REGEXES+=("$(glob_regex "$entry")")
  done
}

# Does the filter cover this directory? A directory is covered when an entry
# matches something INSIDE it — because `src/**` covers `src/app/page.tsx`,
# and `src/app/**` does not.
#
# The entry `src` on its own does not count: a path filter names the changed
# FILE paths, and a changed `src/app/page.tsx` is not a changed `src`. GitHub
# spells "everything under src" as `src/**`, and so does this gate.
covers_dir() {
  local want="$1" regex
  for regex in ${REGEXES[@]+"${REGEXES[@]}"}; do
    if [[ "$want/__probe__" =~ $regex ]]; then
      return 0
    fi
  done
  return 1
}

# Does the filter cover this file?
covers_file() {
  local want="$1" regex
  for regex in ${REGEXES[@]+"${REGEXES[@]}"}; do
    if [[ "$want" =~ $regex ]]; then
      return 0
    fi
  done
  return 1
}

# ── 1. the filter exists ────────────────────────────────────────────────────

echo "== 1: the pull-request trigger is filtered =="

if [ ! -f "$WORKFLOW" ]; then
  bad "the workflow file is missing ($WORKFLOW) — the gate has looked at nothing"
  echo
  echo "Result: $PASS passed, $FAIL failed"
  exit 1
fi

mapfile -t ENTRIES < <(
  yaml_block 0 on < "$WORKFLOW" |
    yaml_block 2 pull_request |
    yaml_block 4 paths |
    sed -e 's/^[[:space:]]*//' -e 's/^-\{1\}[[:space:]]*//' \
        -e "s/^'//" -e "s/'$//" -e 's/^"//' -e 's/"$//' |
    grep -v -e '^$' -e '^#'
)

if [ "${#ENTRIES[@]}" -eq 0 ]; then
  bad "the pull-request trigger names no paths — the gate has nothing to check"
else
  ok "the filter names ${#ENTRIES[@]} path(s)"
fi

compile_entries

# ── the hosted tree, with its comments taken out ────────────────────────────

# A comment cannot read a file, so the comment lines are removed before the
# paths are read out. Everything else is left exactly as it is.
#
# Two kinds of comment are removed: the whole line (`#`, `*` inside a block
# comment, `//`), and the tail of a line after a `#` that starts a word. The
# second matters: `hosted/tests/no-committed-credentials.sh` carries a table
# of values, and one of its rows ends with a note naming `.env.example` — a
# note about where a value came from, not a read of the file.
hosted_code() {
  grep -rh \
    --include='*.sh' --include='*.mjs' --include='*.ts' --include='*.yml' \
    --include='*.yaml' --include='*.json' --include='*.conf' \
    --include='*.template' --include='*.example' --include='Dockerfile*' \
    -vE '^[[:space:]]*(#|\*|//|/\*)' hosted/ 2>/dev/null |
    sed -e 's/[[:space:]]#.*$//'
}

# ── 2. every path the hosted tree reads is inside the filter ────────────────
#
# The paths are READ OUT of the hosted tree rather than listed here, so a new
# gate that reads a new file is covered by the filter automatically — and a
# filter narrowed to exclude it fails this gate.

echo
echo "== 2: every path the hosted box reads is inside the filter =="

# Every path-like token the hosted tree names, in one pass. `hosted/tests/x.sh`
# contributes itself, `src/middleware.ts` contributes itself, and so on.
mapfile -t NAMED_PATHS < <(
  hosted_code |
    grep -oE '[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]*' |
    sed -e 's:/$::' |
    sort -u
)

# Every file-like token the hosted tree names, in one pass.
mapfile -t NAMED_FILES < <(hosted_code | grep -oE '[A-Za-z0-9_.-]+\.[A-Za-z0-9]+' | sort -u)
declare -A NAMED_FILE_SET=()
for f in ${NAMED_FILES[@]+"${NAMED_FILES[@]}"}; do
  NAMED_FILE_SET["$f"]=1
done

# The repository's own tracked files, and the directories that hold them. Read
# ONCE and kept as sets: the check asks "is this path a file or a directory"
# for every path the hosted tree names, and a `git ls-files` per path is a
# process per path.
declare -A TRACKED_FILE_SET=()
declare -A TRACKED_DIR_SET=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  TRACKED_FILE_SET["$f"]=1
  d="$f"
  while [[ "$d" == */* ]]; do
    d="${d%/*}"
    TRACKED_DIR_SET["$d"]=1
  done
done < <(git ls-files 2>/dev/null)

# The repository's own top-level entries, and the directories among them.
mapfile -t TOP_DIRS < <(printf '%s\n' "${!TRACKED_FILE_SET[@]}" | awk -F/ 'NF>1 {print $1}' | sort -u)
mapfile -t TOP_FILES < <(printf '%s\n' "${!TRACKED_FILE_SET[@]}" | awk -F/ 'NF==1 {print}' | sort -u)

roots_ok=0
for root in "${TOP_DIRS[@]}"; do
  case "$root" in
    node_modules|.next|.git|.claude|dist|coverage|out) continue ;;
  esac

  # The paths the hosted tree names under this root. The check is per PATH and
  # not per ROOT, because a read of `.github/workflows/` is covered by
  # `.github/workflows/**` — and asking the filter to cover the whole
  # `.github/` tree would be asking for more than the hosted job reads.
  under=()
  for p in ${NAMED_PATHS[@]+"${NAMED_PATHS[@]}"}; do
    [ "${p%%/*}" = "$root" ] && under+=("$p")
  done
  [ "${#under[@]}" -eq 0 ] && continue

  missing=()
  for p in "${under[@]}"; do
    if [ -n "${TRACKED_FILE_SET[$p]+x}" ]; then
      covers_file "$p" || missing+=("$p")
    else
      covers_dir "$p" || missing+=("$p")
    fi
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    ok "the filter covers the ${#under[@]} path(s) the hosted box reads under $root/"
    roots_ok=$((roots_ok + 1))
  else
    for p in "${missing[@]}"; do
      bad "the hosted box reads $p and the filter does not cover it — a change there can break this job without bringing it up"
    done
  fi
done

if [ "$roots_ok" -eq 0 ]; then
  bad "no repository root was found to check — the gate has looked at nothing"
fi

for file in "${TOP_FILES[@]}"; do
  case "$file" in
    *.md) continue ;;
  esac
  [ -n "${NAMED_FILE_SET[$file]+x}" ] || continue
  if covers_file "$file"; then
    ok "the filter covers $file"
  else
    bad "the hosted box reads $file and the filter does not cover it — a change there can break this job without bringing it up"
  fi
done

# ── 3. the configuration the job's commands read ────────────────────────────
#
# These are not named by the hosted tree — the COMMANDS read them — so they
# are named here, each with the command that reads it. The command is checked
# to still be there, so an entry cannot outlive its reason.

echo
echo "== 3: the configuration the job's commands read is inside the filter =="

# path|command|where the command is
config_read_by() {
  local path="$1" command="$2" where="$3"
  if ! grep -qF -- "$command" "$where" 2>/dev/null; then
    bad "$path is listed as read by \`$command\`, and that command is no longer in $where — the filter entry has outlived its reason"
    return 1
  fi
  if covers_file "$path"; then
    ok "the filter covers $path (read by \`$command\`)"
    return 0
  fi
  bad "$path is read by \`$command\` and the filter does not cover it"
  return 1
}

config_read_by "pnpm-lock.yaml"      "pnpm install --frozen-lockfile" "$WORKFLOW"
config_read_by "next.config.ts"      "next build"                   "hosted/dev/Dockerfile.next"
config_read_by "tsconfig.json"       "next build"                   "hosted/dev/Dockerfile.next"
config_read_by "postcss.config.mjs"  "next build"                   "hosted/dev/Dockerfile.next"
config_read_by "vitest.config.ts"    "pnpm test"                    "$WORKFLOW"
config_read_by ".dockerignore"       "docker compose"               "$WORKFLOW"

# ── 4 and 5. a gate that reads the whole repository cannot live behind a
# filter ─────────────────────────────────────────────────────────────────────

echo
echo "== 4: no gate behind the filter reads the whole repository =="

# The scripts the hosted job runs.
#
# The comment lines come out first. A comment cannot run a gate, and this
# workflow says in a comment that the whole-repository gate has moved
# elsewhere — which is exactly the sentence that must not be read as a place
# the gate still runs.
#
# The path is taken from `hosted/`, not from the word before it: the workflow
# writes `bash hosted/tests/x.sh`, and a reference that carried the `bash `
# with it was not a path, so the file was never found and the check never
# looked at anything.
mapfile -t GATE_TOKENS < <(
  grep -v '^[[:space:]]*#' "$WORKFLOW" 2>/dev/null |
    grep -ohE 'hosted/tests/[][A-Za-z0-9_./*-]+' |
    sort -u
)

# A token can be a glob — the chaos drills are run by a loop over two
# patterns — and a glob names several gates, so every file it matches is
# checked, not just the pattern.
HOSTED_GATES=()
for token in ${GATE_TOKENS[@]+"${GATE_TOKENS[@]}"}; do
  for f in $token; do
    [ -f "$f" ] && HOSTED_GATES+=("$f")
  done
done
mapfile -t HOSTED_GATES < <(printf '%s\n' ${HOSTED_GATES[@]+"${HOSTED_GATES[@]}"} | sort -u)

# A gate that lists the whole repository. `git ls-files --error-unmatch` is
# a single-file question and is not one of these; anything else that lists
# files is.
reads_whole_repository() {
  grep -qE 'git ls-files' "$1" 2>/dev/null && ! grep -q 'git ls-files --error-unmatch' "$1" 2>/dev/null
}

behind_filter=0
for gate in "${HOSTED_GATES[@]}"; do
  [ -f "$gate" ] || continue
  if reads_whole_repository "$gate"; then
    bad "$gate reads the whole repository and runs in a job narrowed by a paths filter — no list of paths can cover the whole tree, so the filter below it can never be complete"
    behind_filter=$((behind_filter + 1))
  fi
done
if [ "$behind_filter" -eq 0 ]; then
  ok "no gate the hosted job runs reads the whole repository"
fi

echo
echo "== 5: every whole-repository gate runs where no filter can narrow it =="

mapfile -t WHOLE_TREE_GATES < <(
  for g in hosted/tests/*.sh hosted/tests/*/*.sh; do
    [ -f "$g" ] || continue
    if reads_whole_repository "$g"; then
      printf '%s\n' "$g"
    fi
  done
)

for gate in "${WHOLE_TREE_GATES[@]}"; do
  [ -f "$gate" ] || continue
  if grep -qhF -- "bash $gate" "$UNFILTERED_WORKFLOW" 2>/dev/null; then
    ok "$gate runs in $UNFILTERED_WORKFLOW, which has no paths filter"
  else
    bad "$gate reads the whole repository and does not run in $UNFILTERED_WORKFLOW — a gate that reads the whole tree has to run on every pull request, including the ones that touch nothing under hosted/"
  fi
done

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
