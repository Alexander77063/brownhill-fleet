#!/usr/bin/env bash
# Prove the application runs on plain PostgreSQL — no Supabase, no GoTrue.
#
# This is the gate for the standalone (Brownhill) build. It stands up a
# throwaway postgres:16 container, applies the compatibility shim and every
# application migration UNMODIFIED, and then asserts that row-level security
# still enforces tenant isolation through the `app.user_id` GUC rather than
# through Supabase's `auth.uid()`.
#
# Run it from the repository root:
#   bash standalone/scripts/verify-portability.sh
#
# It is self-contained and repeatable: the container is destroyed and recreated
# each run, so a pass means the migrations apply from genuinely empty. A
# migration set re-applied to a database that already has the schema proves
# nothing — `create table if not exists` succeeds either way.
set -euo pipefail

# Git Bash on Windows rewrites a container path like /tmp/foo into a Windows
# path before it reaches docker. Turning the rewriting off is a no-op on Linux,
# where CI runs this script.
export MSYS_NO_PATHCONV=1

CONTAINER="${EFM_TEST_CONTAINER:-efm-portable-test}"
PORT="${EFM_TEST_PORT:-55433}"
IMAGE="postgres:16"
PG_PASSWORD="portable"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The one rule for waiting on a containerised postgres. See the file for why
# the socket is a trap and TCP is not.
#
# This proof used to probe over the socket and try to escape the trap with a
# "two consecutive successes" heuristic. That clears the restart only if the
# temporary server shuts down between two probes, and initdb routinely takes
# longer than the probe interval — so it was the same race with a longer
# fuse, and it would have failed at random on the box it is supposed to
# certify. It waits through the shared helper now.
# shellcheck source=scripts/lib/postgres-container.sh
source "$ROOT/scripts/lib/postgres-container.sh"

cleanup_container() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}

echo "==> recreating throwaway database container ($CONTAINER)"
cleanup_container
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB=efm \
  -p "$PORT:5432" \
  "$IMAGE" >/dev/null

# Wait by running a real query, not pg_isready, and over TCP rather than over
# the socket.
#
# The postgres image starts a TEMPORARY server to run initdb and the init
# scripts, then shuts it down and starts the real one. pg_isready answers yes
# during that window, so a run that trusts it races the restart and fails with
# "connection to server on socket ... failed" the moment migrations begin.
#
# The socket has the same problem in a subtler form: psql connects over it by
# default, so the temporary server answers the probe too. Requiring two
# consecutive successes only clears the restart if the temporary server shuts
# down between two probes, and initdb routinely takes longer than the probe
# interval. The real server is the first to listen on 127.0.0.1 and the
# temporary one never does, so asking over TCP cannot be fooled.
#
# The password is passed because this container was NOT started with
# POSTGRES_HOST_AUTH_METHOD=trust, and the probe runs over TCP.
echo "==> waiting for postgres"
if ! wait_for_container_postgres "$CONTAINER" 90 "$PG_PASSWORD"; then
  echo "TIMED OUT" >&2
  docker logs --tail 30 "$CONTAINER" >&2
  exit 1
fi

PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d efm)

echo "==> applying shim + all migrations to EMPTY plain postgres"
bash "$ROOT/standalone/scripts/apply-migrations.sh" "${PSQL[@]}" | tail -3

echo "==> proving RLS enforces through the app.user_id GUC"
# Capture first, then report: piping psql into grep would hand us grep's exit
# status, which is 0 whenever it matched a line — including a line saying FAIL.
set +e
proof_output="$("${PSQL[@]}" -v ON_ERROR_STOP=1 < "$ROOT/standalone/sql/portable-rls-proof.sql" 2>&1)"
proof_status=$?
set -e

echo "$proof_output" | grep -E "PASS|FAIL|ERROR" || true

echo "==> proving the billing allocation guard"
set +e
alloc_output="$("${PSQL[@]}" -v ON_ERROR_STOP=1 < "$ROOT/standalone/sql/billing-allocation-proof.sql" 2>&1)"
alloc_status=$?
set -e

echo "$alloc_output" | grep -E "PASS|FAIL|ERROR" || true

status=0
if [ "$proof_status" -ne 0 ]; then
  echo "==> RLS PROOF FAILED" >&2
  status=1
fi

if [ "$alloc_status" -ne 0 ]; then
  echo "==> ALLOCATION PROOF FAILED: money can be allocated to a void invoice" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "==> PORTABILITY VERIFIED: the app runs on plain PostgreSQL with RLS and the allocation guard intact"
fi

if [ "${EFM_KEEP_CONTAINER:-0}" != "1" ]; then
  echo "==> removing throwaway container (set EFM_KEEP_CONTAINER=1 to keep it)"
  cleanup_container
fi

exit "$status"
