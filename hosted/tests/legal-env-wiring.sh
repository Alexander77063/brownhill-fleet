#!/usr/bin/env bash
# hosted/tests/legal-env-wiring.sh — the operator's own identity, from the
# application to the box, spelled one way.
#
# WHY THIS TEST EXISTS
# --------------------
# The legal pages used to name one company: the upstream's. On a box the
# CUSTOMER operates, the privacy policy told the customer to write to a
# company that has nothing to do with them, and published a registration
# number and a registered office that do not exist. The pages now publish the
# operator's own identity, and that identity is eight environment variables.
#
# Eight variables, read in one file and carried in two others, is a spelling
# waiting to happen. FOUR files have to agree on the names:
#
#   src/lib/legal.ts                          — what the application READS
#   hosted/bootstrap/install.sh               — what the installer WRITES
#   hosted/bootstrap/operator-secrets.example — what the operator is SHOWN
#   hosted/systemd/brownhill-next.service     — what the unit LOADS
#
# A name that is read but never written is a setting that does nothing. A name
# that is written but never read is a setting that does nothing either. And a
# name spelled one way in the application and another in the installer is the
# worst of the three, because NOTHING FAILS: the legal page omits the clause,
# forever, and nobody is told. The page still renders. It is just shorter than
# it should be, and the only symptom is a missing company number.
#
# That is the same failure as issue #120 — the install scripts wrote jwt.env
# and pg.env, and the service needed LOCAL_JWT_SECRET and DATABASE_URL too —
# in a different file.
#
# THE CHECKS
# ----------
#   1. The application reads a set of names, and it is not empty.
#   2. The installer writes exactly those names.
#   3. The operator's template carries exactly those names.
#   4. The unit loads the file.
#   5. The file is OPTIONAL where the unit loads it — a box that has not been
#      told who operates it still starts, and its pages omit what they have
#      no value for.
#
# It is a static check over the repository: no docker, no database, no
# secrets. It runs in about a second.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

APP="src/lib/legal.ts"
INSTALL="hosted/bootstrap/install.sh"
TEMPLATE="hosted/bootstrap/operator-secrets.example"
UNIT="hosted/systemd/brownhill-next.service"
ENV_FILE="/etc/brownhill/secrets/legal.env"

# ── 1: what the application reads ───────────────────────────────────────────

echo "== 1: the names the application reads =="

app_names=$(grep -Iho -E 'LEGAL_OPERATOR_[A-Z0-9_]+' "$APP" 2>/dev/null | sort -u || true)

if [ -z "$app_names" ]; then
  bad "the application reads no LEGAL_OPERATOR_* name — the legal pages have no identity to publish"
else
  count=$(printf '%s\n' "$app_names" | wc -l | tr -d ' ')
  ok "the application reads $count name(s):"
  printf '%s\n' "$app_names" | sed 's/^/      /'
fi

# ── 2: what the installer writes ────────────────────────────────────────────

echo
echo "== 2: the names the installer writes =="

# The legal.env block only. The installer's other secret files carry other
# variables, and a name mentioned in a comment elsewhere in the file is not
# a provision.
installer_names=$(
  sed -n "/write_secret ${ENV_FILE//\//\\/}/,/^fi$/p" "$INSTALL" |
    grep -Iho -E 'LEGAL_OPERATOR_[A-Z0-9_]+' | sort -u || true
)

if [ -z "$installer_names" ]; then
  bad "the installer never writes $ENV_FILE, so the application reads names nothing provides"
elif [ "$installer_names" != "$app_names" ]; then
  bad "the installer writes a different set of names than the application reads:"
  printf '      only the application reads: %s\n' "$(comm -23 <(printf '%s\n' "$app_names") <(printf '%s\n' "$installer_names") | tr '\n' ' ')"
  printf '      only the installer writes: %s\n' "$(comm -13 <(printf '%s\n' "$app_names") <(printf '%s\n' "$installer_names") | tr '\n' ' ')"
else
  ok "the installer writes exactly the names the application reads"
fi

# ── 3: what the operator is shown ───────────────────────────────────────────

echo
echo "== 3: the names the operator's template carries =="

template_names=$(
  grep -Iho -E '^LEGAL_OPERATOR_[A-Z0-9_]+=' "$TEMPLATE" 2>/dev/null |
    sed -E 's/=$//' | sort -u || true
)

if [ -z "$template_names" ]; then
  bad "the operator's template does not mention $ENV_FILE — nobody is told the names to fill in"
elif [ "$template_names" != "$app_names" ]; then
  bad "the operator's template carries a different set of names than the application reads:"
  printf '      only the application reads: %s\n' "$(comm -23 <(printf '%s\n' "$app_names") <(printf '%s\n' "$template_names") | tr '\n' ' ')"
  printf '      only the template carries: %s\n' "$(comm -13 <(printf '%s\n' "$app_names") <(printf '%s\n' "$template_names") | tr '\n' ' ')"
else
  ok "the operator's template carries exactly the names the application reads"
fi

# ── 4: what the unit loads ──────────────────────────────────────────────────

echo
echo "== 4: the file the unit loads =="

if grep -qE "^EnvironmentFile=-?${ENV_FILE//\//\\/}\$" "$UNIT"; then
  ok "the unit loads $ENV_FILE"
else
  bad "the unit does not load $ENV_FILE — the values reach the box and stop there"
fi

# ── 5: optional, so a box without it still starts ───────────────────────────

echo
echo "== 5: the file is optional where the unit loads it =="

# Without the leading '-' systemd treats a missing EnvironmentFile as a hard
# error: the unit fails to load its environment and the application never
# comes up. That is a far worse answer than a deployment whose legal pages
# omit the operator's company number.
if grep -qE "^EnvironmentFile=-${ENV_FILE//\//\\/}\$" "$UNIT"; then
  ok "the file is optional — a box without it still starts"
else
  bad "the unit loads $ENV_FILE as REQUIRED — a box without the file would fail to start the application at all"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
