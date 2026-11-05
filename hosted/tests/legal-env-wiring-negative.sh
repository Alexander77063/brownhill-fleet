#!/usr/bin/env bash
# hosted/tests/legal-env-wiring-negative.sh — the negative case for the
# operator-identity gate.
#
# hosted/tests/legal-env-wiring.sh decides whether the operator's own identity
# reaches the legal pages under the names the application reads them by. A
# gate that cannot fail is not a gate: if the wiring broke — the installer
# stopped writing the file, the unit stopped loading it, the operator's
# template lost a name — and the gate quietly stopped looking, it would
# report a healthy deployment on every commit, forever, and everybody would
# believe it.
#
# The failure this protects against is not hypothetical, and it is the quiet
# kind. The legal pages used to publish the upstream's company: on a box the
# customer operates, the privacy policy named a company with nothing to do
# with them, and a registration number that did not exist. The pages now
# publish the operator's own identity, and a name that is read but never
# written produces exactly the same symptom as the old bug: a shorter
# document, with a clause missing, and nothing anywhere saying why.
#
# So this runs the gate against trees that DO have each fault, and requires
# it to fail on the right check each time.
#
# The trees are copies, not edits of the repository. A negative gate that
# modified tracked files in place could leave the tree broken if it were
# interrupted, and could damage the very thing it is meant to be checking.
#
# It needs bash and a checkout. It needs no docker, no database, no secrets
# and no stack, and it takes seconds.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="hosted/tests/legal-env-wiring.sh"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The files the gate reads. A copy of the tree with these in it is enough to
# run the gate, and nothing else.
#
#   hosted/tests/legal-env-wiring.sh         the gate itself
#   src/lib/legal.ts                          reads the operator's identity
#   hosted/bootstrap/install.sh               writes the box's secrets
#   hosted/bootstrap/operator-secrets.example what the operator is shown
#   hosted/systemd/brownhill-next.service     the unit that loads the file
make_tree() {
  local root="$1"
  mkdir -p "$root/hosted/tests" \
           "$root/hosted/bootstrap" \
           "$root/hosted/systemd" \
           "$root/src/lib"

  cp "$REPO/hosted/tests/legal-env-wiring.sh" "$root/hosted/tests/"
  cp "$REPO/src/lib/legal.ts"                 "$root/src/lib/"
  cp "$REPO/hosted/bootstrap/install.sh"      "$root/hosted/bootstrap/"
  cp "$REPO/hosted/bootstrap/operator-secrets.example" "$root/hosted/bootstrap/"
  cp "$REPO/hosted/systemd/brownhill-next.service" "$root/hosted/systemd/"
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

  bash "$root/hosted/tests/legal-env-wiring.sh" >"$out" 2>&1 || rc=$?

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
bash "$REPO/hosted/tests/legal-env-wiring.sh" >"$TMP/baseline.out" 2>&1 || baseline_rc=$?
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
bash "$COPY/hosted/tests/legal-env-wiring.sh" >"$TMP/copy.out" 2>&1 || copy_rc=$?
if [[ "$copy_rc" -eq 0 ]]; then
  ok "the gate passes on an unperturbed copy of the tree"
else
  bad "the gate FAILS on an unperturbed copy — the copy is not faithful"
  sed 's/^/      /' "$TMP/copy.out"
fi

# ── probe 1: the unit stops loading the file ───────────────────────────────
#
# The values reach the box and stop there. The application starts, its pages
# render, and every operator clause is missing — which is exactly what a box
# with no legal.env looks like, so nobody can tell the difference.

echo
echo "== probe 1: the unit stops loading legal.env =="

P1="$TMP/probe-unit"
make_tree "$P1"
sed -i '/EnvironmentFile=-.*legal\.env/d' "$P1/hosted/systemd/brownhill-next.service"
if grep -qE '^EnvironmentFile=-.*legal\.env' "$P1/hosted/systemd/brownhill-next.service"; then
  bad "the probe did not take — the unit still loads legal.env"
else
  run_probe "$P1" unit 4
fi

# ── probe 2: the unit makes the file REQUIRED ───────────────────────────────
#
# Without the leading '-' systemd treats a missing EnvironmentFile as a hard
# error. A box that has not been told who operates it would fail to start the
# application at all — a far worse answer than a deployment whose legal pages
# omit a company number.

echo
echo "== probe 2: the unit loads legal.env as REQUIRED =="

P2="$TMP/probe-required"
make_tree "$P2"
sed -i 's|^EnvironmentFile=-/etc/brownhill/secrets/legal\.env$|EnvironmentFile=/etc/brownhill/secrets/legal.env|' \
  "$P2/hosted/systemd/brownhill-next.service"
if grep -qE '^EnvironmentFile=-.*legal\.env' "$P2/hosted/systemd/brownhill-next.service"; then
  bad "the probe did not take — the unit still loads legal.env optionally"
else
  run_probe "$P2" required 5
fi

# ── probe 3: the installer stops writing the file ───────────────────────────
#
# The values the operator fills in never arrive. The legal pages read an empty
# identity and omit every clause — with nothing to say why.

echo
echo "== probe 3: the installer stops writing legal.env =="

P3="$TMP/probe-installer"
make_tree "$P3"
sed -i '/^if \[\[ ! -f \/etc\/brownhill\/secrets\/legal\.env \]\]; then$/,/^fi$/d' \
  "$P3/hosted/bootstrap/install.sh"
if grep -q 'legal\.env' "$P3/hosted/bootstrap/install.sh"; then
  bad "the probe did not take — the installer still mentions legal.env"
else
  run_probe "$P3" installer 2
fi

# ── probe 4: the application reads a name nobody writes ─────────────────────
#
# The application grows a ninth clause. The installer has not been taught to
# write it, so it is read as empty and omitted — silently, forever, with the
# pages still rendering. This is the fault the gate exists to catch, and the
# one that is easiest to introduce: a new env var in the application, and
# nothing else.

echo
echo "== probe 4: the application reads a name the installer does not write =="

P4="$TMP/probe-app"
make_tree "$P4"
printf '\n// A ninth clause the application reads.\nexport const FOOTNOTE = process.env.LEGAL_OPERATOR_FOOTNOTE ?? "";\n' \
  >> "$P4/src/lib/legal.ts"
if grep -q 'LEGAL_OPERATOR_FOOTNOTE' "$P4/src/lib/legal.ts"; then
  run_probe "$P4" application 2
else
  bad "the probe did not take — the application does not read the extra name"
fi

# ── probe 5: the operator's template loses a name ───────────────────────────
#
# The value is set on the box, the application reads it, and the operator was
# never told it exists — so it stays empty. The gate is the only thing that
# can notice.

echo
echo "== probe 5: the operator's template loses a name =="

P5="$TMP/probe-template"
make_tree "$P5"
sed -i '/^LEGAL_OPERATOR_WEBSITE=$/d' "$P5/hosted/bootstrap/operator-secrets.example"
if grep -qE '^LEGAL_OPERATOR_WEBSITE=' "$P5/hosted/bootstrap/operator-secrets.example"; then
  bad "the probe did not take — the template still carries the name"
else
  run_probe "$P5" template 3
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
