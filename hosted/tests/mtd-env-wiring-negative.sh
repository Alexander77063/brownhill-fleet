#!/usr/bin/env bash
# hosted/tests/mtd-env-wiring-negative.sh — the negative case for the
# deployment's settings gate.
#
# hosted/tests/mtd-env-wiring.sh decides whether the deployment's settings
# reach the application under the names the application reads them by. A gate
# that cannot fail is not a gate: if the wiring broke — the unit stopped
# loading the file, the handover went back to the old names, the writer
# stopped rewriting the file — and the gate quietly stopped looking, it
# would report a healthy deployment on every commit, forever, and everybody
# would believe it.
#
# The failure this protects against is not hypothetical. The settings were
# wrong in exactly these ways once already: the handover named
# MTD_CLIENT_ID where the code read HMRC_MTD_CLIENT_ID, the redirect URI
# pointed at a page rather than at the route that receives the code, and
# nothing on the box provided any of them at all. The deployment installed
# cleanly and the HMRC page said "not connected", with nothing anywhere
# saying why.
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
GATE="hosted/tests/mtd-env-wiring.sh"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The files the gate reads. A copy of the tree with these in it is enough to
# run the gate, and nothing else.
#
#   hosted/tests/mtd-env-wiring.sh        the gate itself
#   hosted/bootstrap/install.sh            provisions the box
#   hosted/bootstrap/write-app-env.sh      writes the app's environment
#   hosted/bootstrap/substitute-fqdn.sh    gives the deployment its hostname
#   hosted/systemd/brownhill-next.service  the unit that loads the settings
#   HANDOFF-BROWNHILL.md                   the operator's instructions
#   src/lib/accounting/mtd.ts              reads the HMRC settings
#   src/lib/requests.ts                    reads the application's address
#   src/app/api/v1/accounting/mtd/[action]/route.ts
#                                           serves the OAuth callback
make_tree() {
  local root="$1"
  mkdir -p "$root/hosted/tests" \
           "$root/hosted/bootstrap" \
           "$root/hosted/systemd" \
           "$root/src/lib/accounting" \
           "$root/src/app/api/v1/accounting/mtd/[action]"

  cp "$REPO/hosted/tests/mtd-env-wiring.sh"   "$root/hosted/tests/"
  cp "$REPO/hosted/bootstrap/install.sh"       "$root/hosted/bootstrap/"
  cp "$REPO/hosted/bootstrap/write-app-env.sh" "$root/hosted/bootstrap/"
  cp "$REPO/hosted/bootstrap/substitute-fqdn.sh" "$root/hosted/bootstrap/"
  cp "$REPO/hosted/systemd/brownhill-next.service" "$root/hosted/systemd/"
  cp "$REPO/HANDOFF-BROWNHILL.md"              "$root/"
  cp "$REPO/src/lib/accounting/mtd.ts"         "$root/src/lib/accounting/"
  cp "$REPO/src/lib/requests.ts"               "$root/src/lib/"
  cp "$REPO/src/app/api/v1/accounting/mtd/[action]/route.ts" \
     "$root/src/app/api/v1/accounting/mtd/[action]/"
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

  bash "$root/hosted/tests/mtd-env-wiring.sh" >"$out" 2>&1 || rc=$?

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
bash "$REPO/hosted/tests/mtd-env-wiring.sh" >"$TMP/baseline.out" 2>&1 || baseline_rc=$?
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
bash "$COPY/hosted/tests/mtd-env-wiring.sh" >"$TMP/copy.out" 2>&1 || copy_rc=$?
if [[ "$copy_rc" -eq 0 ]]; then
  ok "the gate passes on an unperturbed copy of the tree"
else
  bad "the gate FAILS on an unperturbed copy — the copy is not faithful"
  sed 's/^/      /' "$TMP/copy.out"
fi

# ── probe 1: the unit stops loading the HMRC settings ──────────────────────
#
# This is what happens when somebody tidies the unit up, or when the file is
# renamed on the box and the unit is not updated with it. The application
# starts with no HMRC settings and reports that it has no HMRC connection,
# which looks exactly like an operator who has not filled the file in.

echo
echo "== probe 1: the unit stops loading mtd.env =="

P1="$TMP/probe-unit"
make_tree "$P1"
sed -i '/EnvironmentFile=-.*mtd\.env/d' "$P1/hosted/systemd/brownhill-next.service"
if grep -qE '^EnvironmentFile=-.*mtd\.env' "$P1/hosted/systemd/brownhill-next.service"; then
  bad "the probe did not take — the unit still loads mtd.env"
else
  run_probe "$P1" unit 2
fi

# ── probe 2: the handover goes back to the names the code does not read ────
#
# The fault this gate exists for. The handover told the operator to set
# MTD_CLIENT_ID; the code reads HMRC_MTD_CLIENT_ID; the value arrived and
# was ignored.

echo
echo "== probe 2: the handover uses the name the code does not read =="

P2="$TMP/probe-handoff"
make_tree "$P2"
sed -i 's/HMRC_MTD_CLIENT_ID=/MTD_CLIENT_ID=/' "$P2/HANDOFF-BROWNHILL.md"
if grep -qE '(^|[[:space:]])MTD_CLIENT_ID=' "$P2/HANDOFF-BROWNHILL.md"; then
  run_probe "$P2" handoff 3
else
  bad "the probe did not take — the handover still uses the real name"
fi

# ── probe 3: the writer stops writing the application's address ───────────
#
# Without the address, HMRC's redirect is built from a fallback of
# http://localhost:3000 — a URL that exists on the build machine and nowhere
# else. The OAuth flow cannot complete.

echo
echo "== probe 3: the writer stops writing the application's address =="

P3="$TMP/probe-writer"
make_tree "$P3"
sed -i "/NEXT_PUBLIC_APP_URL=/d" "$P3/hosted/bootstrap/write-app-env.sh"
if grep -q 'NEXT_PUBLIC_APP_URL=' "$P3/hosted/bootstrap/write-app-env.sh"; then
  bad "the probe did not take — the writer still writes the address"
else
  run_probe "$P3" writer 1
fi

# ── probe 4: the writer stops rewriting the file ───────────────────────────
#
# The promise install.sh makes about a rotated database password. The writer
# used to write only when the file was absent, so a rotated password never
# reached the application and the next sign-in failed with "password
# authentication failed".
#
# The write is made write-once by a guard in front of it — the behaviour the
# writer used to have.

echo
echo "== probe 4: the writer stops rewriting the file =="

P4="$TMP/probe-rotation"
make_tree "$P4"
sed -i 's|^target="\$SECRETS_DIR/app\.env"$|target="$SECRETS_DIR/app.env"\nif [[ -f "$target" ]]; then echo "wrote $target (unchanged)"; exit 0; fi|' \
  "$P4/hosted/bootstrap/write-app-env.sh"
if grep -q 'unchanged' "$P4/hosted/bootstrap/write-app-env.sh"; then
  run_probe "$P4" rotation 4
else
  bad "the probe did not take — the writer still rewrites the file"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
