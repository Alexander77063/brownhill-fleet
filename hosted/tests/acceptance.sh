#!/usr/bin/env bash
# hosted/tests/acceptance.sh — the bar a deployment must clear before it is
# called shippable (Spec §4.5.7 + accounting §4.6).
#
# Five gates always run. Two are conditional — the accounting module's smoke
# (when accounting.chart_of_accounts has rows) and the no-credential gate
# (when this is a git checkout) — and each one that RUNS raises the bar. A
# conditional gate that runs and fails does not get to lower it again.
#
# That last point was not true before, and it was the worse half of the
# arithmetic. The question was "did the accounting gate pass?", so a gate
# that ran and FAILED left the answer no, the denominator went back to five,
# and the bar was reported as met — on a deployment whose accounting smoke
# had just failed. The count of gates that ran is now the count of gates
# that had to pass.
set -uo pipefail
GATES_PASSED=0
GATES_REQUIRED=5
GATES_SKIPPED=()
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
#
# The negative gate runs last, and it runs the proof AGAIN with a CA that
# signed nothing, requiring the proof to fail on assertion 14. A
# verification that cannot fail is not a verification — and this one had
# started failing the job against a perfectly healthy stack, which is the
# other way a guard stops meaning anything.
echo "== Gate 2: the portability proof and its own guards =="
if bash hosted/tests/portability-guards.sh 2>/tmp/g2a.log \
   && bash hosted/tests/verify-hosted-portability.sh 2>/tmp/g2.log \
   && bash hosted/tests/tls-assertion-negative.sh 2>/tmp/g2b.log; then
  echo "Gate 2 OK"; GATES_PASSED=$((GATES_PASSED+1))
else
  echo "Gate 2 FAIL (see /tmp/g2a.log, /tmp/g2.log and /tmp/g2b.log)"
  [[ -f /tmp/g2a.log ]] && sed 's/^/      /' /tmp/g2a.log
  [[ -f /tmp/g2.log ]] && sed 's/^/      /' /tmp/g2.log
  [[ -f /tmp/g2b.log ]] && sed 's/^/      /' /tmp/g2b.log
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
    # It runs, so it counts: a failing accounting smoke raises the bar rather
    # than dropping the deployment back to the five-gate bar.
    GATES_REQUIRED=$((GATES_REQUIRED + 1))
    if bash hosted/tests/accounting/accounting-smoke.sh 2>/tmp/g6.log; then
      echo "Gate 6 OK"; GATES_PASSED=$((GATES_PASSED+1))
      GATE_NAMES+=("accounting")
    else
      echo "Gate 6 FAIL (see /tmp/g6.log)"
    fi
  else
    echo "Gate 6 skipped — accounting module not enabled (no chart_of_accounts rows)"
    GATES_SKIPPED+=("accounting")
  fi
else
  echo "Gate 6 skipped — sudo not present"
  GATES_SKIPPED+=("accounting")
fi

# 7 — no credential in the tree
#
# The repository is public, and it has already published two credentials in
# plain text: the box's database superuser password and the customer's own
# login password, both in tracked files. This gate is the half of that fix
# that can live in the repository — it checks the tree that is about to be
# handed over. The other half is rotation on the box, and the handover says
# how and when.
#
# It scans the TRACKED files, so it needs a git checkout: a deployed copy of
# the application is not a source tree. Where there is no checkout it is
# skipped, and says so, rather than reporting a tree it never read.
#
# The negative gate runs with it, for the same reason Gate 2 runs the
# negative TLS gate: a check that cannot fail proves nothing, and this one
# had a version that could not fail at all.
echo "== Gate 7: no credential in the tree =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GATES_REQUIRED=$((GATES_REQUIRED + 1))
  if bash hosted/tests/no-committed-credentials.sh >/tmp/g7.log 2>&1 \
     && bash hosted/tests/no-committed-credentials-negative.sh >>/tmp/g7.log 2>&1; then
    echo "Gate 7 OK"; GATES_PASSED=$((GATES_PASSED+1))
    GATE_NAMES+=("no-committed-credentials")
  else
    echo "Gate 7 FAIL (see /tmp/g7.log)"
    [[ -f /tmp/g7.log ]] && sed 's/^/      /' /tmp/g7.log
  fi
else
  echo "Gate 7 skipped — not a git checkout, so there is no tree to scan"
  echo "               CI runs this gate on every pull request"
  GATES_SKIPPED+=("no-committed-credentials")
fi

echo
echo "Gate names: ${GATE_NAMES[*]}"
if [[ ${#GATES_SKIPPED[@]} -gt 0 ]]; then
  echo "Skipped: ${GATES_SKIPPED[*]}"
fi
# Every gate that ran has to be green. A skipped gate is not a green gate,
# and it does not count towards the bar.
echo "Result: $GATES_PASSED / $GATES_REQUIRED gates green"
[[ "$GATES_PASSED" -eq "$GATES_REQUIRED" ]]
