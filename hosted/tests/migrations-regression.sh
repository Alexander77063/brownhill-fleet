#!/usr/bin/env bash
# hosted/tests/migrations-regression.sh — replays every shipped migration against an empty
# postgres:16 in a container and asserts verify-portability still holds. Fails PRs that edit a
# shipped migration in a backwards-incompatible way.
#
# Skips gracefully when docker is absent; that env is for dev hosts without docker.

set -euo pipefail
if ! command -v docker >/dev/null 2>&1; then
  echo "docker not present; skipping migrations-regression"
  exit 0
fi

cid=$(docker run -d --rm -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16)
trap "docker rm -f $cid >/dev/null 2>&1 || true" EXIT
sleep 2
for _ in $(seq 1 30); do
  docker exec -u postgres "$cid" psql -c 'SELECT 1' >/dev/null 2>&1 && break
  sleep 0.5
done

docker cp standalone/sql/0000_supabase_shim.sql "$cid":/tmp/
mkdir -p .tmp/migrations
cp supabase/migrations/*.sql .tmp/migrations/
docker cp .tmp/migrations/. "$cid":/tmp/migrations/
docker cp standalone/sql/portable-rls-proof.sql "$cid":/tmp/

docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/0000_supabase_shim.sql
for f in $(ls -1 supabase/migrations/*.sql | sort); do
  bn=$(basename "$f")
  docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f "/tmp/migrations/$bn"
done
docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/portable-rls-proof.sql
rm -rf .tmp
echo OK
