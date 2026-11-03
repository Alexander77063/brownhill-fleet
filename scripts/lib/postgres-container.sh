#!/usr/bin/env bash
# scripts/lib/postgres-container.sh — the ONE rule for waiting for a
# containerised postgres.
#
# It lives here, at the root of the repository, because both profiles need it:
# the hosted gates under hosted/tests/ and the standalone proof under
# standalone/scripts/. A rule kept in one profile's folder is a rule the other
# profile cannot follow, and a rule kept in two places is two chances to
# forget it.
#
# WHY THIS EXISTS
# ---------------
# The postgres image does not start one server. It starts a TEMPORARY one,
# runs initdb and the init scripts against it, shuts it down, and only then
# starts the real server. The temporary server is started with
# `listen_addresses=''`, so it listens on the unix socket and on NOTHING
# else.
#
# That matters because psql connects over the unix socket when it is not
# told otherwise. A probe that asks "is postgres up yet?" by running
# `psql -c 'SELECT 1'` therefore gets YES from the temporary server — a
# server that is about to be shut down under it. The probe declares the
# database ready, the next command arrives, and the server has gone:
#
#   FAIL: the throwaway postgres never came up
#
# ...which says nothing whatever about the thing under test.
#
# It cost ONE red build in this repository's CI history: 2026-11-03, at the
# seed gate. What makes the cause certain is the timing in that log — the
# gate had a THIRTY-SECOND budget (60 polls of half a second) and failed in
# 0.98 of them, reporting "Result: 0 passed, 0 failed". A probe with thirty
# seconds to wait cannot time out in one, so the probe SUCCEEDED and the very
# next line found the server gone. The only server in that container that
# comes and goes is the temporary one.
#
# The other red builds that week were three DIFFERENT defects — the
# build-time font fetch, the fixture-name collision and the env-var
# regression — and reading the failing step out of a run is what tells them
# apart.
#
# The defect sat in FIVE places. Only one of them had fired in CI; the other
# four were live in the customer's own box, where there is no CI to re-run.
#
# The standalone proof met the same trap and tried to escape it with a
# "two consecutive successes" heuristic: that clears the restart only if the
# temporary server shuts down between two probes, and initdb routinely takes
# longer than the probe interval. It was a race with a longer fuse, not a
# fix.
#
# THE RULE
# --------
# Probe over TCP, and run a REAL query rather than pg_isready: a server that
# is up but still refusing queries is not ready either.
#
# The real server is the first one to listen on 127.0.0.1; the temporary one
# never does. That makes the wait deterministic instead of lucky.
#
# WHO USES IT
# -----------
#   hosted/tests/seed-fail-closed.sh
#   hosted/tests/migrations-regression.sh
#   hosted/tests/hosted-bootstrap-idempotency.sh
#   standalone/scripts/verify-portability.sh
#
# hosted/tests/postgres-readiness-probe.sh holds every one of them to this
# rule, and hosted/tests/postgres-readiness-probe-negative.sh breaks the rule
# on purpose, in a copy of the tree, to prove the gate can fail.

# container_postgres_probe <container> [port] [password]
#
# One probe: a real query over TCP, inside the container.
# Returns 0 when the server answers, non-zero when it does not.
#
# The port is the port INSIDE the container (5432 in every case here) — the
# probe runs inside, so the published host port is irrelevant to it.
#
# The password is only needed by a container that was NOT started with
# POSTGRES_HOST_AUTH_METHOD=trust. It is passed rather than assumed, so the
# probe works whatever pg_hba.conf says: a server that asks for a password
# gets it, and a server that does not ask is not troubled by one.
#
# It is passed as an argument and NOT read from the environment. An
# environment variable that nothing provides is a setting the deployment does
# not have, and hosted/tests/env-var-names.sh refuses to let one in: every
# BROWNHILL_* the code reads has to be provided by something, or to have a
# documented fallback. This one has neither — every caller that needs a
# password passes it.
container_postgres_probe() {
  local cid="$1"
  local port="${2:-5432}"
  local password="${3:-}"
  local -a pg_env=(-e PGHOST=127.0.0.1 -e "PGPORT=$port")
  if [ -n "$password" ]; then
    pg_env+=(-e "PGPASSWORD=$password")
  fi
  docker exec "${pg_env[@]}" -u postgres "$cid" \
    psql -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1
}

# wait_for_container_postgres <container> [budget-seconds] [password]
#
# Waits until the container's postgres answers a real query over TCP.
# Returns 0 when it is ready, 1 when it was not ready within the budget.
#
# The budget is in seconds and the poll is twice a second, so the wait is
# half as long as the number suggests would be necessary: initdb of an empty
# cluster takes a couple of seconds, and the budget is there to catch a
# container that is never going to come up, not to hurry one that is on its
# way.
wait_for_container_postgres() {
  local cid="$1"
  local budget_seconds="${2:-60}"
  local password="${3:-}"
  local attempt=0
  local attempts=$((budget_seconds * 2))

  while [ "$attempt" -lt "$attempts" ]; do
    if container_postgres_probe "$cid" 5432 "$password"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  return 1
}
