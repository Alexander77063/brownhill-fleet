#!/usr/bin/env bash
# hosted/tests/acceptance-arithmetic.sh — the acceptance bar's own arithmetic.
#
# hosted/tests/acceptance.sh decides whether a deployment is fit to hand over.
# That decision is arithmetic, and the arithmetic was wrong.
#
# It asked "did the accounting gate pass?" rather than "how many gates ran?".
# So a deployment whose accounting module WAS enabled, and whose accounting
# smoke FAILED, dropped back to the five-gate bar and was reported as five of
# five — met. The gate that ran and failed lowered the bar instead of raising
# it, and the summary said "accounting module not enabled" about a deployment
# that had it enabled.
#
# The bar is now the count of gates that ran, and every gate that runs has to
# be green. This checks that, by running the real acceptance script against
# stubbed gates: the copy under test is byte-identical to the repository's,
# and only the gates it CALLS are stubs.
#
# It needs bash and git. No docker, no database, no build, no stack, and a
# couple of seconds.
set -uo pipefail

REAL_REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# --- the stub tree ----------------------------------------------------------

mkdir -p "$SANDBOX/hosted/tests/smoke" "$SANDBOX/hosted/tests/accounting" "$SANDBOX/bin"

cp "$REAL_REPO/hosted/tests/acceptance.sh" "$SANDBOX/hosted/tests/acceptance.sh"

# Every gate that is not under test passes.
for g in portability-guards verify-hosted-portability tls-assertion-negative \
         migrations-regression; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/hosted/tests/$g.sh"
done
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/hosted/tests/smoke/hosted-smoke.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/hosted/tests/no-committed-credentials-negative.sh"

# The two gates under test are driven by the environment.
cat > "$SANDBOX/hosted/tests/no-committed-credentials.sh" <<'STUB'
#!/usr/bin/env bash
[[ "${STUB_CREDENTIAL_GATE:-0}" == "1" ]] && exit 1
exit 0
STUB
cat > "$SANDBOX/hosted/tests/accounting/accounting-smoke.sh" <<'STUB'
#!/usr/bin/env bash
[[ "${STUB_ACCOUNTING_GATE:-0}" == "1" ]] && exit 1
exit 0
STUB

# The commands the acceptance script shells out to.
cat > "$SANDBOX/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$SANDBOX/bin/sudo" <<'STUB'
#!/usr/bin/env bash
# The only thing the script asks sudo for is how many chart_of_accounts rows
# there are. Zero means "not enabled".
[[ "${STUB_ACCOUNTING_ENABLED:-1}" == "1" ]] && echo 5 || echo 0
exit 0
STUB
cat > "$SANDBOX/bin/journalctl" <<'STUB'
#!/usr/bin/env bash
echo "Verified restore: /var/backups/brownhill/restore-ok"
exit 0
STUB
cat > "$SANDBOX/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# The only use the acceptance script makes of git is asking whether this is a
# checkout, so that is all this stub answers.
cat > "$SANDBOX/bin/git" <<'STUB'
#!/usr/bin/env bash
[[ "${STUB_GIT_CHECKOUT:-1}" == "1" ]] && exit 0
exit 1
STUB
chmod +x "$SANDBOX/bin/"*

# --- the scenarios ----------------------------------------------------------

# scenario <name> <expected-exit> <expected-result-line> <env assignments...>
scenario() {
  local name="$1" want_rc="$2" want_result="$3"; shift 3
  local out rc
  out="$(cd "$SANDBOX" && env PATH="$SANDBOX/bin:$PATH" "$@" bash "$SANDBOX/hosted/tests/acceptance.sh" 2>&1)"
  rc=$?
  if [[ "$rc" -ne "$want_rc" ]]; then
    bad "$name — exit $rc, expected $want_rc"
    printf '%s\n' "$out" | sed 's/^/      /'
    return
  fi
  ok "$name — exit $rc"
  if printf '%s\n' "$out" | grep -qF "$want_result"; then
    ok "$name — reports '$want_result'"
  else
    bad "$name — does not report '$want_result'"
    printf '%s\n' "$out" | sed 's/^/      /'
  fi
}

# Gate 5 needs both journalctl and systemctl to be present, and the
# accounting and credential gates are conditional. So the bar is:
#   5 baseline, +1 when the accounting module is enabled,
#          +1 when this is a git checkout.

echo "== every gate green, both conditional gates running =="
scenario "everything green" 0 "Result: 7 / 7 gates green" \
  STUB_ACCOUNTING_ENABLED=1 STUB_ACCOUNTING_GATE=0 STUB_CREDENTIAL_GATE=0 STUB_GIT_CHECKOUT=1

echo
echo "== a conditional gate that RUNS and FAILS must raise the bar =="
scenario "accounting fails" 1 "Result: 6 / 7 gates green" \
  STUB_ACCOUNTING_ENABLED=1 STUB_ACCOUNTING_GATE=1 STUB_CREDENTIAL_GATE=0 STUB_GIT_CHECKOUT=1
scenario "credential gate fails" 1 "Result: 6 / 7 gates green" \
  STUB_ACCOUNTING_ENABLED=1 STUB_ACCOUNTING_GATE=0 STUB_CREDENTIAL_GATE=1 STUB_GIT_CHECKOUT=1

echo
echo "== a gate that is SKIPPED does not count, and says so =="
scenario "accounting not enabled" 0 "Result: 6 / 6 gates green" \
  STUB_ACCOUNTING_ENABLED=0 STUB_ACCOUNTING_GATE=0 STUB_CREDENTIAL_GATE=0 STUB_GIT_CHECKOUT=1
scenario "not a git checkout" 0 "Result: 6 / 6 gates green" \
  STUB_ACCOUNTING_ENABLED=1 STUB_ACCOUNTING_GATE=0 STUB_CREDENTIAL_GATE=0 STUB_GIT_CHECKOUT=0

echo
echo "== the skip is visible, not silent =="
out="$(cd "$SANDBOX" && env PATH="$SANDBOX/bin:$PATH" STUB_GIT_CHECKOUT=0 bash "$SANDBOX/hosted/tests/acceptance.sh" 2>&1)"
if printf '%s\n' "$out" | grep -q "Skipped:.*no-committed-credentials"; then
  ok "the skipped gate is named in the summary"
else
  bad "the skipped gate is not named in the summary"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
