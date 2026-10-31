#!/usr/bin/env bash
# hosted/tests/acceptance.sh — the six-gate bar (Spec §4.5.7 + accounting §4.6).
# All six must return 0 for a deploy to be called shippable. Gate 6 is opt-in by
# the presence of accounting.chart_of_accounts; if the accounting module isn't
# enabled (e.g. the SaaS profile), Gate 6 is skipped and the bar is 5 gates.
set -uo pipefail
GATES_PASSED=0
GATE_NAMES=( "hosted-tests" "verify-hosted-portability" "migrations-regression" "hosted-smoke" "backup-verify" )

# 1 — pnpm test on DEPLOYMENT_PROFILE=hosted
#
# The filter this used to carry — `pnpm --filter @brownhill/webapp test` —
# matched no package: this repository is a single package named
# "elite-fleet-management", with no pnpm-workspace.yaml. pnpm prints "No
# projects matched the filters" and exits 0, so the gate passed without
# running a single test. The command below runs the real suite.
echo "== Gate 1: DEPLOYMENT_PROFILE=hosted pnpm test =="
if DEPLOYMENT_PROFILE=hosted pnpm test 2>/tmp/g1.log; then
  echo "Gate 1 OK"; GATES_PASSED=$((GATES_PASSED+1))
else echo "Gate 1 FAIL (see /tmp/g1.log)"; fi

# 2 — verify-hosted-portability.sh 0–17 green
#
# The proof's OWN guards run first, in the same gate. Four of those guards
# could never pass — the backup assertion asked for `systemctl` rather than
# for the Brownhill unit, the HTTPS assertion passed `-k` beside `--cacert`,
# the tenant assertion loaded a package this project does not depend on, and
# the off-host assertion synced to a bucket named "test". A guard that can
# never pass is not a guard: in a build log a skipped assertion is
# indistinguishable from a passing one. The guards are what make this gate
# mean something, so they are part of it rather than a separate line.
echo "== Gate 2: the portability proof and its own guards =="
if bash hosted/tests/portability-guards.sh 2>/tmp/g2a.log \
   && bash hosted/tests/verify-hosted-portability.sh 2>/tmp/g2.log; then
  echo "Gate 2 OK"; GATES_PASSED=$((GATES_PASSED+1))
else
  echo "Gate 2 FAIL (see /tmp/g2a.log and /tmp/g2.log)"
  [[ -f /tmp/g2a.log ]] && sed 's/^/      /' /tmp/g2a.log
  [[ -f /tmp/g2.log ]] && sed 's/^/      /' /tmp/g2.log
fi

# 3 — migrations-regression.sh green
echo "== Gate 3: migrations-regression.sh =="
if bash hosted/tests/migrations-regression.sh 2>/tmp/g3.log; then
  echo "Gate 3 OK"; GATES_PASSED=$((GATES_PASSED+1))
else echo "Gate 3 FAIL (see /tmp/g3.log)"; fi

# 4 — hosted-smoke.sh green (bootstrap → login → 1 .from() per major resource)
echo "== Gate 4: hosted-smoke.sh =="
if bash hosted/tests/smoke/hosted-smoke.sh 2>/tmp/g4.log; then
  echo "Gate 4 OK"; GATES_PASSED=$((GATES_PASSED+1))
else echo "Gate 4 FAIL (see /tmp/g4.log)"; fi

# 5 — one Sunday backup-verify has run on the target VM
echo "== Gate 5: backup-verify service ran within last 7 days =="
if command -v journalctl >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
  if journalctl -u brownhill-backup-verify.service --since '7 days ago' --no-pager | grep -q "Verified restore:"; then
    echo "Gate 5 OK"; GATES_PASSED=$((GATES_PASSED+1))
  else
    echo "Gate 5 FAIL — schedule a Sunday verify or trigger it manually"
  fi
else
  echo "Gate 5 skipped (no systemd/journalctl) — fall back to inspecting /var/log/brownhill/backup-verify.log"
  if [[ -f /var/log/brownhill/backup-verify.log ]] && grep -q "Verified restore:" /var/log/brownhill/backup-verify.log; then
    echo "Gate 5 OK"; GATES_PASSED=$((GATES_PASSED+1))
  else echo "Gate 5 FAIL — no verify log present"; fi
fi

# 6 — accounting module smoke (opt-in: only when accounting.chart_of_accounts is non-empty)
echo "== Gate 6: accounting module =="
if command -v sudo >/dev/null 2>&1; then
  has_acct=$(sudo -u postgres /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -tAc \
    "select count(*) from accounting.chart_of_accounts limit 1" 2>/dev/null || echo 0)
  if [[ "$has_acct" -gt 0 ]] 2>/dev/null; then
    if bash hosted/tests/accounting/accounting-smoke.sh 2>/tmp/g6.log; then
      echo "Gate 6 OK"; GATES_PASSED=$((GATES_PASSED+1))
      GATE_NAMES+=("accounting")
    else
      echo "Gate 6 FAIL (see /tmp/g6.log)"
    fi
  else
    echo "Gate 6 skipped — accounting module not enabled (no chart_of_accounts rows)"
  fi
else
  echo "Gate 6 skipped — sudo not present"
fi

echo
echo "Gate names: ${GATE_NAMES[*]}"
# Required gates: 5 baseline (Gates 1-5). Gate 6 is optional. If accounting
# is enabled, the bar is 6; otherwise it's 5.
if printf '%s\n' "${GATE_NAMES[@]}" | grep -q '^accounting$'; then
  echo "Result: $GATES_PASSED / 6 gates green"
  [[ "$GATES_PASSED" -eq 6 ]]
else
  echo "Result: $GATES_PASSED / 5 gates green (accounting module not enabled)"
  [[ "$GATES_PASSED" -eq 5 ]]
fi
