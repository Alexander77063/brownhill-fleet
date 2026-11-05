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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The one rule for waiting on a containerised postgres. See the file for why
# the socket is a trap and TCP is not.
# shellcheck source=scripts/lib/postgres-container.sh
source "$ROOT/scripts/lib/postgres-container.sh"

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
# Wait for the REAL server, over TCP.
#
# This used to be a socket probe — `psql -c 'SELECT 1'` — and it was a race:
# the postgres image answers a socket probe from the TEMPORARY server it
# starts to run initdb, then shuts that server down. The gate would declare
# the database ready and the next command would find the server gone. The
# old loop had no final assert either, so a database that never came up was
# reported as a MIGRATION failure, which is a different defect entirely.
if ! wait_for_container_postgres "$cid" 60; then
  echo "FAIL: the throwaway postgres never came up"
  docker logs --tail 30 "$cid" 2>&1 || true
  exit 1
fi

docker cp standalone/sql/0000_supabase_shim.sql "$cid":/tmp/
# The migrations go straight from the working tree into the container — the
# trailing /. copies the CONTENTS of the directory, and there is no staging
# copy on the host for this script to clean up afterwards.
docker exec -u postgres "$cid" mkdir -p /tmp/migrations
docker cp supabase/migrations/. "$cid":/tmp/migrations/
docker cp standalone/sql/portable-rls-proof.sql "$cid":/tmp/
docker cp standalone/sql/billing-allocation-proof.sql "$cid":/tmp/
docker cp standalone/sql/void-balance-proof.sql "$cid":/tmp/
docker cp standalone/sql/void-balance-negative.sql "$cid":/tmp/
docker cp tests/rls/accounting-portable-proof.sql "$cid":/tmp/
docker cp hosted/tests/backfill-fixture.sql "$cid":/tmp/
docker cp hosted/tests/backfill-assert.sql "$cid":/tmp/

docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/0000_supabase_shim.sql
for f in $(ls -1 supabase/migrations/*.sql | sort); do
  bn=$(basename "$f")
  docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f "/tmp/migrations/$bn"
done
docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/portable-rls-proof.sql
# The accounting schema's own assertions (10-16): the tables it is built on,
# the accounts the ledger posts to, the VAT codes, the append-only audit log,
# and the global-code uniqueness that migration 0069 dropped.
#
# This file used to exist and NOTHING RAN IT. It was written, it was
# correct-looking, and it had never once been executed — so it kept a stale
# table name ('mtd_credentials', renamed to 'firs_credentials' by migration
# 0069) and two assertions written as "is at least one of these there?"
# instead of "are they all there?". Six required chart-of-accounts codes, one
# of them missing for the life of the module ('2200', VAT Output), and the
# assertion was green. It is run here now.
docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/accounting-portable-proof.sql
# The billing allocation guard: money may never be allocated to a void invoice,
# and the two caps that were always there still hold. This proof FAILS against
# a schema without migration 0082, so it is a real guard and not a rubber stamp.
docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/billing-allocation-proof.sql

# The voided invoice is worth nothing. A cancelled invoice must not appear in
# any amount owed, because the driver's payment checkout SUMS this balance and
# charges it: against a schema without migration 0087, a voided invoice still
# carried its full gross, and the customer was charged for work that had been
# cancelled.
docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/void-balance-proof.sql

# ── The void-balance proof can fail ─────────────────────────────────────────
#
# A gate that cannot fail is not a gate. The proof above is run a second
# time against the views as migration 0011 left them, and it MUST fail
# there. Then the migration is re-applied and the proof must pass again —
# which is what proves that restoring the views was what broke it, and that
# re-applying the migration is what fixes it.
echo "== the void-balance proof can fail =="

# The migration is found by CONTENT, not by number, so the guard keeps
# guarding when the history grows.
void_migration=""
for f in $(ls -1 supabase/migrations/*.sql | sort); do
  if grep -q 'create or replace view public.v_invoice_balance' "$f"; then
    void_migration=$(basename "$f")
    break
  fi
done

if [ -z "$void_migration" ]; then
  echo "FAIL: no migration replaces v_invoice_balance — the void-balance proof has nothing to be proven by"
  exit 1
fi
echo "the void-balance fix is $void_migration"

docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/void-balance-negative.sql

set +e
docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/void-balance-proof.sql
negative_status=$?
set -e

if [ "$negative_status" -eq 0 ]; then
  echo "FAIL: the void-balance proof PASSED against the pre-fix views — it is not a gate"
  # Put the fix back before leaving, so the rest of the run is not sitting on
  # a schema with the defect restored.
  docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f "/tmp/migrations/$void_migration"
  exit 1
fi
echo "ok: the void-balance proof fails against the pre-fix views"

# Put the fix back and prove the proof is green again.
docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f "/tmp/migrations/$void_migration"
docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -f /tmp/void-balance-proof.sql
echo "ok: the void-balance proof passes again once the fix is re-applied"

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

# A missing split point is a FAILURE, not a shrug.
#
# This detection is by CONTENT, so renaming the column or rewriting the
# migration makes it miss — and if a miss is allowed to fall through, this
# whole phase stops running and the script still ends in `echo OK`. A gate
# that can be renamed into silence is not a gate. The same shape above (the
# void-balance detection) already refuses in this situation; this one now does
# too, for the same reason: the phase exists precisely because a from-zero
# replay applies the split migration to an empty table, so its backfill
# updates zero rows and a broken backfill is invisible.
if [ -z "$split" ]; then
  echo "FAIL: no migration introduces agreed_vehicle_price_pence — the backfill phase has nothing to test"
  exit 1
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

  # ── The ledger backfill is idempotent ─────────────────────────────────────
  # Migration 0086 restores the ledger for the invoices and payments that
  # already exist. It is replayed by this harness, by the portability proof
  # and by any operator who runs it by hand, so a second run that added a
  # SECOND set of journal lines would double the business's revenue while
  # every individual posting still looked correct.
  #
  # It is found by CONTENT, not by number, for the same reason the split
  # point above is: the history grows, and renumbering a migration is not a
  # reason for this guard to stop guarding.
  echo "== the GL backfill is idempotent =="
  gl_migration=""
  for f in $(ls -1 supabase/migrations/*.sql | sort); do
    if grep -q 'accounting.ensure_period' "$f"; then
      gl_migration=$(basename "$f")
      break
    fi
  done

  # Same rule as above, and the same reason: this is the guard that stops a
  # second run of the backfill from adding a SECOND set of journal lines and
  # doubling the business's revenue while every individual posting still
  # looks correct. If the detection misses, the guard has to stop the run —
  # a guard that cannot be found must not read as a guard that passed.
  if [ -z "$gl_migration" ]; then
    echo "FAIL: no migration creates accounting.ensure_period — the GL backfill is not there to test"
    exit 1
  else
    echo "the GL backfill is $gl_migration"

    gl_counts() {
      docker exec -u postgres "$cid" psql -U postgres -d backfill -tAc \
        'select count(*) from accounting.journal_entries' | tr -d '\r'
      docker exec -u postgres "$cid" psql -U postgres -d backfill -tAc \
        'select count(*) from accounting.journal_lines' | tr -d '\r'
      docker exec -u postgres "$cid" psql -U postgres -d backfill -tAc \
        'select count(*) from accounting.audit_log' | tr -d '\r'
    }

    before="$(gl_counts | tr '\n' '/')"
    docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -d backfill -f "/tmp/migrations/$gl_migration"
    after="$(gl_counts | tr '\n' '/')"

    if [ "$before" != "$after" ]; then
      echo "FAIL: a second run of $gl_migration changed the ledger"
      echo "  before: $before"
      echo "  after : $after"
      exit 1
    fi
    echo "ok: a second run of $gl_migration changed nothing ($after)"
  fi
fi

# ── Phase 3: the migration runner is idempotent ──────────────────────────────
# The runner keeps a ledger of what it has applied — public.schema_migrations —
# so running it a second time applies nothing. That is the property the hosted
# bootstrap depends on: it is a systemd oneshot, it runs on every boot, and
# before the ledger it died on migration 0001, which creates the `user_role`
# enum without a guard.
#
# A second database in the same cluster, because the ledger has to be built by
# the runner itself. The database in phase 1 was migrated by hand, so it has
# the schema but no ledger — which is exactly the state the baseline option
# exists for, and hosted/tests/hosted-bootstrap-idempotency.sh covers that.
echo "== phase 3: the migration runner applies everything once, then nothing =="

docker exec -u postgres "$cid" psql -v ON_ERROR_STOP=1 -c 'create database runner'

runner_psql=(docker exec -i -u postgres "$cid" psql -U postgres -d runner)

set +e
first_run=$(bash "$ROOT/standalone/scripts/apply-migrations.sh" "${runner_psql[@]}" 2>&1)
first_status=$?
set -e
if [ "$first_status" -ne 0 ]; then
  echo "FAIL: the first run of the migration runner failed"
  echo "$first_run" | tail -20
  exit 1
fi
echo "ok: the first run applied the whole history"

set +e
second_run=$(bash "$ROOT/standalone/scripts/apply-migrations.sh" "${runner_psql[@]}" 2>&1)
second_status=$?
set -e
if [ "$second_status" -ne 0 ]; then
  echo "FAIL: the second run of the migration runner failed"
  echo "$second_run" | tail -20
  exit 1
fi
if echo "$second_run" | grep -q 'applied 0 migrations'; then
  echo "ok: the second run applied 0 migrations"
else
  echo "FAIL: the second run applied something it should not have"
  echo "$second_run" | tail -20
  exit 1
fi

ledger_rows=$(docker exec -u postgres "$cid" psql -U postgres -d runner -tAc \
  "select count(*) from public.schema_migrations")
expected_rows=$(( $(ls -1 "$ROOT"/supabase/migrations/*.sql | wc -l) + 1 ))
if [ "$ledger_rows" = "$expected_rows" ]; then
  echo "ok: the ledger holds $ledger_rows rows"
else
  echo "FAIL: the ledger holds $ledger_rows rows, expected $expected_rows"
  exit 1
fi

echo OK

