#!/usr/bin/env bash
# hosted/tests/secret-file-permissions-negative.sh — the negative case for
# the credential-file gate.
#
# hosted/tests/secret-file-permissions.sh decides whether the installer
# writes its credential files in a way that keeps them away from everybody
# else. A gate that cannot fail is not a gate: if the writer went back to
# writing straight to the target path — which is how it used to write them —
# and the gate quietly stopped looking, it would report a healthy box on
# every commit, forever, and everybody would believe it.
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
GATE="hosted/tests/secret-file-permissions.sh"

PASS=0
FAIL=0
SKIP=0
ok()   { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  skip: $1"; SKIP=$((SKIP + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The mode of a file. `stat` spells this differently on GNU and BSD, so both
# are tried.
file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || echo ""
}

# Does this file system honour permissions at all? Git Bash on Windows mounts
# NTFS with `noacl`, where `chmod` is a no-op. A probe that needs a mode
# cannot say anything there, so it is skipped out loud rather than run.
modes_are_honoured() {
  local probe="$TMP/mode-probe"
  : > "$probe"
  chmod 0600 "$probe" 2>/dev/null
  [[ "$(file_mode "$probe")" == "600" ]]
}

# The files the gate reads. A copy of the tree with these in it is enough to
# run the gate, and nothing else.
#
#   hosted/tests/secret-file-permissions.sh  the gate itself
#   hosted/bootstrap/install.sh                provisions the box, and holds
#                                             the secret writer
make_tree() {
  local root="$1"
  mkdir -p "$root/hosted/tests" "$root/hosted/bootstrap"
  cp "$REPO/$GATE"        "$root/hosted/tests/"
  cp "$REPO/hosted/bootstrap/install.sh" "$root/hosted/bootstrap/"
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

# ── probe 1: the credential is written straight to its final path ───────────
#
# The fault the gate exists for. The writer goes back to writing the secret
# into the path the services read it from, so the credential is at that path
# — empty, and then world-readable — before it has been written.

echo
echo "== probe 1: the credential is written straight to its final path =="

P1="$TMP/probe-direct-write"
make_tree "$P1"
sed -i -e 's|> "\$tmp"$|> "$path"|' -e '/mv -f -- "\$tmp" "\$path"/d' \
  "$P1/hosted/bootstrap/install.sh"
if grep -q 'printf .*> "\$path"' "$P1/hosted/bootstrap/install.sh"; then
  run_probe "$P1" direct-write 4
else
  bad "the probe did not take — the writer still writes through a temporary file"
fi

# ── probe 2: the temporary file is never narrowed ───────────────────────────
#
# The other half of the property: the file has to ARRIVE at the target path
# already narrowed. If the temporary file keeps the permissions mktemp gave
# it, the credential lands as 0600 — readable by the owner alone, so the
# services that are supposed to read it cannot, and the box does not work.
#
# This probe is about a mode, so it can only say anything on a file system
# that honours modes. Where they are not honoured the probe is skipped out
# loud, in the same way the gate skips its own mode check.

echo
echo "== probe 2: the temporary file is never narrowed =="

if modes_are_honoured; then
  P2="$TMP/probe-unnarrowed"
  make_tree "$P2"
  sed -i '/^    chmod 0640 "\$tmp"$/d' "$P2/hosted/bootstrap/install.sh"
  if grep -q 'chmod 0640 "\$tmp"' "$P2/hosted/bootstrap/install.sh"; then
    bad "the probe did not take — the writer still narrows the temporary file"
  else
    run_probe "$P2" unnarrowed 3
  fi
else
  skip "this file system does not honour permissions, so the probe cannot say anything here. It runs in CI, where the mode is real"
fi

echo
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
