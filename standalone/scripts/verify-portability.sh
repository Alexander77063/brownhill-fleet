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

CONTAINER="${EFM_TEST_CONTAINER:-efm-portable-test}"
PORT="${EFM_TEST_PORT:-55433}"
IMAGE="postgres:16"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cleanup_container() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}

echo "==> recreating throwaway database container ($CONTAINER)"
cleanup_container
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=portable \
  -e POSTGRES_DB=efm \
  -p "$PORT:5432" \
  "$IMAGE" >/dev/null

# Wait by running a real query, not pg_isready.
#
# The postgres image starts a TEMPORARY server to run initdb and the init
# scripts, then shuts it down and starts the real one. pg_isready answers yes
# during that window, so a run that trusts it races the restart and fails with
# "connection to server on socket ... failed" the moment migrations begin.
# Requiring two consecutive successful queries clears the restart.
echo -n "==> waiting for postgres"
ready=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" psql -U postgres -d efm -tAc 'select 1' >/dev/null 2>&1; then
    ready=$((ready + 1))
    if [ "$ready" -ge 2 ]; then
      echo " ready"
      break
    fi
  else
    ready=0
  fi
  echo -n "."
  sleep 1
done

if [ "$ready" -lt 2 ]; then
  echo " TIMED OUT" >&2
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

if [ "$proof_status" -eq 0 ]; then
  echo "==> PORTABILITY VERIFIED: the app runs on plain PostgreSQL with RLS intact"
  status=0
else
  echo "==> PORTABILITY FAILED" >&2
  status=1
fi

if [ "${EFM_KEEP_CONTAINER:-0}" != "1" ]; then
  echo "==> removing throwaway container (set EFM_KEEP_CONTAINER=1 to keep it)"
  cleanup_container
fi

exit "$status"
