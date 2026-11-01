#!/usr/bin/env bash
# hosted/tests/no-committed-credentials-negative.sh — the negative case for
# the no-credential gate.
#
# hosted/tests/no-committed-credentials.sh decides whether the tree holds a
# credential. A gate that cannot fail is not a gate: if the scan were quietly
# broken — a shape the rules stopped matching, a rule that stopped running —
# the gate would report a clean tree on every commit, forever, and everybody
# would believe it.
#
# So this runs that gate against a tree that DOES hold a credential, and
# requires it to fail on the right rule. Three probes, one per rule:
#
#   probe 1 — a connection URL with a literal value in it  → rule 1 must fail
#   probe 2 — a credential-named variable with a literal     → rule 2 must fail
#   probe 3 — a value written out in prose                  → rule 3 must fail
#
# The value is SYNTHETIC. It belongs to no account, grants access to nothing,
# and exists only to have the shape the rules hunt for.
#
# The value is assembled from base64 rather than written out, because this
# file lives in the tree the gate scans. Written plainly, the probe would make
# the gate fail on its own source — and a gate that cannot be run against
# the repository it ships in is not a gate.
#
# The probe is staged with `git add -N` because the gate scans TRACKED files.
# It is unstaged and deleted afterwards, in a trap, so an interrupted run
# leaves no debris. The baseline is checked first — the gate must pass on the
# clean tree — so that "exactly one rule failed" means the probe caused it
# and not something that was already broken.
#
# It needs git and a checkout. It needs no docker, no database, no build and
# no stack, and it takes seconds.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO/hosted/tests/no-committed-credentials.sh"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
PROBE_FILE=""

# Remove the probe from the index and from the disk, and take the scratch
# directory with it. A probe left behind would be a probe left behind.
cleanup() {
  if [[ -n "$PROBE_FILE" ]]; then
    git -C "$REPO" reset --quiet -- "$PROBE_FILE" >/dev/null 2>&1 || true
    rm -f "$REPO/$PROBE_FILE"
    PROBE_FILE=""
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# The synthetic value, assembled rather than written. It is deliberately
# meaningless: it is a shape, not a secret.
#
#   printf '%s' 'WHk5elEybUtwN1J0NFd2' | base64 -d
#
# The line above holds the encoded form; the decoded form never appears in
# this repository's tracked files, and never appears in prose.
PROBE_VALUE="$(printf '%s' 'WHk5elEybUtwN1J0NFd2' | base64 -d)"

# The fallback operator, held apart for the same reason: written inline it
# would make rule 2 match this file's own source.
PROBE_OR="||"

# Which rule the failure is attributed to. The gate prints "== N: …" before
# each rule's results, and the failure appears under the header it belongs
# to.
failing_rule() {
  awk '
    /^== [0-9]+:/ { split($0, a, " "); rule = a[2]; sub(/:$/, "", rule); next }
    /^  FAIL:/ { if (rule != "") { print rule; exit } }
  ' "$1"
}

# --- the probes -------------------------------------------------------------

write_probe_url() {
  cat > "$1" <<EOF
const databaseUrl = 'postgresql://app:${PROBE_VALUE}@db.internal:5432/brownhill';
EOF
}

write_probe_fallback() {
  cat > "$1" <<EOF
const DB_PASSWORD = process.env.DB_PASSWORD ${PROBE_OR} 'brownhill-operator-value';
EOF
}

write_probe_prose() {
  cat > "$1" <<EOF
The operator recovery password is ${PROBE_VALUE} and it must never be written here.
EOF
}

# --- the run ----------------------------------------------------------------

# Run the gate with one probe present and require it to fail on one rule.
run_probe() {
  local name="$1" expected="$2" writer="$3"
  local file=".probe-$name.txt"
  local out="$TMP/$name.out"
  local rc=0

  echo
  echo "== probe $name: the gate must fail on rule $expected =="

  PROBE_FILE="$file"
  "$writer" "$REPO/$file"

  if ! git -C "$REPO" add -N -- "$file" >/dev/null 2>&1; then
    bad "the probe could not be staged, so the gate could not see it"
    PROBE_FILE=""
    rm -f "$REPO/$file"
    return
  fi

  bash "$GATE" >"$out" 2>&1 || rc=$?

  git -C "$REPO" reset --quiet -- "$file" >/dev/null 2>&1 || true
  rm -f "$REPO/$file"
  PROBE_FILE=""

  if [[ "$rc" -eq 0 ]]; then
    bad "the gate PASSED with a probe present — rule $expected cannot fail"
    sed 's/^/      /' "$out"
    return
  fi
  ok "the gate fails when the probe is present"

  local failures
  failures="$(grep -c '^  FAIL:' "$out" || true)"
  if [[ "$failures" -eq 1 ]]; then
    ok "exactly one rule failed"
  else
    bad "$failures rules failed — one probe should trip one rule"
    sed 's/^/      /' "$out"
  fi

  local rule
  rule="$(failing_rule "$out")"
  if [[ "$rule" == "$expected" ]]; then
    ok "the failure is attributed to rule $expected"
  else
    bad "the failure is attributed to rule ${rule:-none}, not rule $expected"
    sed 's/^/      /' "$out"
  fi
}

# The gate scans the tree from the repository root, so run it there whatever
# directory this script was started from.
cd "$REPO" || exit 1

echo "== the baseline: the gate passes on the tree as it stands =="

baseline_rc=0
bash "$GATE" >"$TMP/baseline.out" 2>&1 || baseline_rc=$?
if [[ "$baseline_rc" -eq 0 ]]; then
  ok "the gate passes on the tree as it stands"
else
  bad "the gate FAILS on the clean tree — the probes below would prove nothing"
  sed 's/^/      /' "$TMP/baseline.out"
fi

run_probe url 1 write_probe_url
run_probe fallback 2 write_probe_fallback
run_probe prose 3 write_probe_prose

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
