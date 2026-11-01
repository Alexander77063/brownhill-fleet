#!/usr/bin/env bash
# hosted/tests/tls-assertion-negative.sh — the negative case for assertion 14.
#
# Assertion 14 of the portability proof verifies nginx's certificate chain
# against a named CA. A verification that cannot fail is not a verification:
# if the CA were wrong, or nginx served a self-signed certificate, or the
# certificate were for a different name, the assertion would still pass and
# the handover would still be signed off.
#
# It very nearly was. The assertion failed the hosted-smoke job on 2026-10-31
# while the stack was healthy, because it judged the chain by an HTTP status
# whitelist that did not include the 307 nginx answers for /. A failure is
# not the only way to be wrong: an assertion that cries wolf at a healthy
# server is a guard nobody can trust to catch a sick one.
#
# So this runs the proof against the LIVE stack with a CA that signed
# nothing, and requires the proof to FAIL on assertion 14. That is the case
# that gives the positive case its meaning.
#
# The bogus CA is generated here rather than committed. A committed "bad" CA
# is a file that eventually gets trusted by accident — the same mistake in
# the opposite direction as the one this file exists to catch.
#
# It needs the stack up (it talks to nginx on 443) and openssl. It needs no
# database, no build and no container of its own.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROOF="$REPO/hosted/tests/verify-hosted-portability.sh"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  skip: $1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A path a native Windows program can open.
#
# Git Bash hands a Windows program an MSYS path — /tmp/... — which openssl
# resolves as C:\tmp\..., which does not exist. cygpath converts it. On
# Linux there is nothing to convert and cygpath is not present.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    echo "$1"
  fi
}

echo "== the negative case: a CA that signed nothing =="

# On the deployed box, assertion 14 verifies against the system's own trust
# store rather than against a named CA — so pointing it at a bogus CA there
# would prove nothing, and running the proof again would re-run the box's
# real backup and restore drills. The gate says so rather than pretending.
#
# The mechanism is the same on both: openssl, with a verification failure
# turned into a non-zero exit. This gate proves the mechanism fails when it
# should; the box path differs only in which trust anchor is named.
if [[ -d "${BROWNHILL_BOX_DIR:-/etc/brownhill}" ]]; then
  skip "this machine is the deployed box: assertion 14 verifies against the system's trust store there, and the bogus-CA trick applies to the test-CA path only"
  echo
  echo "Result: $PASS passed, $FAIL failed"
  [[ "$FAIL" -eq 0 ]]
  exit $?
fi

if ! command -v openssl >/dev/null 2>&1; then
  bad "openssl is not available, so the bogus CA cannot be generated"
  echo
  echo "Result: $PASS passed, $FAIL failed"
  [[ "$FAIL" -eq 0 ]]
  exit $?
fi

# A self-signed certificate that signed nothing. One day is enough: it only
# has to exist for the length of this run.
#
# MSYS_NO_PATHCONV=1 stops Git Bash from rewriting the subject. Git Bash
# converts an argument that begins with a slash into a Windows path, so
# "/CN=Brownhill Not The CA" arrives as "C:/Program Files/Git/CN=..." and
# openssl rejects it. On Linux the variable is simply an unused one.
if ! MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout "$(native_path "$TMP/bogus.key")" -out "$(native_path "$TMP/bogus.pem")" \
     -days 1 -subj "/CN=Brownhill Not The CA" >"$TMP/gen.log" 2>&1; then
  bad "could not generate the bogus CA — $(tail -2 "$TMP/gen.log" | tr '\n' ' ')"
else
  ok "a bogus CA was generated"

  # The standalone replay is skipped: it stands up its own throwaway
  # postgres and replays the whole migration history, which takes minutes and
  # has nothing to do with whether assertion 14 can fail.
  BROWNHILL_TEST_CA="$TMP/bogus.pem" \
  BROWNHILL_SKIP_STANDALONE_REPLAY=1 \
    bash "$PROOF" >"$TMP/proof.out" 2>&1
  rc=$?

  if [[ "$rc" -ne 0 ]]; then
    ok "the proof fails when the certificate does not chain to the named CA"
  else
    bad "the proof PASSED against a CA that signed nothing — assertion 14 cannot fail"
    sed 's/^/      /' "$TMP/proof.out"
  fi

  if grep -q 'FAIL: 14:' "$TMP/proof.out"; then
    ok "the failure is attributed to assertion 14"
  else
    bad "the proof failed, but not on assertion 14"
    sed 's/^/      /' "$TMP/proof.out"
  fi

  if grep -q 'ok: 14:' "$TMP/proof.out"; then
    bad "assertion 14 reported success against a CA that signed nothing"
  else
    ok "assertion 14 did not report success"
  fi
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
