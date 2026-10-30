#!/usr/bin/env bash
# hosted/tests/migrations-regression.sh — replays every shipped migration against an empty
# postgres:16 in a container and asserts verify-portability still holds. Fails PRs that edit a
# shipped migration in a backwards-incompatible way.
#
# Two phases, because there are two ways a migration history can be wrong:
#
#   1. FROM ZERO — the shim, every migration in filename order, then the RLS proof and the
#      billing allocation proof. This is the path a brand-new install takes.
#
#   2. OVER EXISTING DATA — the same history again, but with rent-to-buy agreements already
#      in the table when the rent-to-buy contract migration lands, so its backfill is
#      exercised against rows that really exist.
#
# Phase 1 alone is not enough. A from-zero replay applies 0077 to an empty `agreements`
# table: its backfill updates zero rows and its CHECK constraint is validated against zero
# rows, so a broken backfill is invisible. A live deployment is the opposite — the
# rent-to-buy book already exists, and a backfill that mis-computes or misses a row would
# fail the deploy in front of a customer. Phase 2 is that case, made permanent.
#
# Skips gracefully when docker is absent; that env is for dev hosts without docker.

set -euo pipefail

# Git Bash on Windows rewrites a container path like /tmp/migrations into a
# Windows path before it reaches docker, so `mkdir -p /tmp/migrations` inside
# the container becomes `mkdir -p C:/Users/.../Temp/migrations` and fails with
# "cannot create directory 'C'". Turning the rewriting off is a no-op on Linux,
# where CI runs this script.
export MSYS_NO_PATHCONV=1

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
# The migrations go straight from the working tree into the container — the
# trailing /. copies the CONTENTS of the directory, and there is no staging
# copy on the host for this script to clean up afterwards.
docker exec -u postgres "$cid" mkdir -p /tmp/migrations
docker cp supabase/migrations/. "$cid":/tmp/migrations/
docker cp standalone/sql/portable-rls-proof.sql "$cid":/tmp/
docker cp standalone/sql/billing-allocation-proof.sql "$cid":/tmp/
docker cp hosted/tests/backfill-fixture.sql "$cid":/tmp/
docker cp hosted/tests/backfill-assert.sql "$cid":/tmp/

docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/0000_supabase_shim.sql
for f in $(ls -1 supabase/migrations/*.sql | sort); do
  bn=$(basename "$f")
  docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f "/tmp/migrations/$bn"
done
docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/portable-rls-proof.sql
# The billing allocation guard: money may never be allocated to a void invoice,
# and the two caps that were always there still hold. This proof FAILS against
# a schema without migration 0082, so it is a real guard and not a rubber stamp.
docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/billing-allocation-proof.sql

# ── Phase 2: the same history, over data that already exists ───────────────────
echo "== phase 2: the rent-to-buy backfill, over existing rent-to-buy rows =="

# The split point is the migration that introduces the rent-to-buy contract columns.
# It is found by CONTENT, not by number, so it stays correct as the history grows.
split=""
for f in $(ls -1 supabase/migrations/*.sql | sort); do
  if grep -q 'agreed_vehicle_price_pence' "$f"; then
    split=$(basename "$f")
    break
  fi
done

if [ -z "$split" ]; then
  echo "no migration introduces agreed_vehicle_price_pence — the backfill phase has nothing to test"
else
  echo "the rent-to-buy contract arrives in $split"

  docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -c 'create database backfill'
  # The shim is idempotent (roles are guarded, schemas and tables use IF NOT EXISTS), so
  # applying it to a second database in the same cluster is safe and necessary: the roles
  # are cluster-wide, but the `auth` schema and its tables are per-database.
  docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -d backfill -f /tmp/0000_supabase_shim.sql

  # Everything before the split, onto an empty database.
  reached=0
  for f in $(ls -1 supabase/migrations/*.sql | sort); do
    bn=$(basename "$f")
    if [ "$bn" = "$split" ]; then reached=1; fi
    if [ "$reached" = "0" ]; then
      docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -d backfill -f "/tmp/migrations/$bn"
    fi
  done

  # The data a live deployment would already hold.
  docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -d backfill -f /tmp/backfill-fixture.sql

  # The split migration and everything after it, over that data.
  reached=0
  for f in $(ls -1 supabase/migrations/*.sql | sort); do
    bn=$(basename "$f")
    if [ "$bn" = "$split" ]; then reached=1; fi
    if [ "$reached" = "1" ]; then
      docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -d backfill -f "/tmp/migrations/$bn"
    fi
  done

  docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -d backfill -f /tmp/backfill-assert.sql
fi

echo OK

