#!/usr/bin/env bash
# hosted/tests/deploy-applies-migrations.sh — the deployment applies the
# migrations, or it does not deploy.
#
# WHY THIS TEST EXISTS
# --------------------
# The documented update path was:
#
#     cd /opt/brownhill/repo && git pull origin main && ./hosted/scripts/deploy-app.sh
#
# and it shipped code against a schema the database did not have. The deploy
# built the application, copied it into place and restarted the service, and
# never applied a migration. The first anyone heard of it was the first
# person who used the feature the new migration belonged to: migration 0088
# added the table the self-service password reset writes its throttle to,
# and the deployment of that feature answered
#
#     ERROR: relation "password_reset_requests" does not exist
#
# to the one screen that exists so a locked-out person can get back in.
#
# A deploy that does not move the schema is not a slow deploy. It is a
# deploy that moves the code and leaves the schema behind, and the two only
# disagree at the moment somebody uses the new code — which is the worst
# moment to find out.
#
# WHAT IS RUN, AND WHAT IS STUBBED
# --------------------------------
# The REAL deploy script, the REAL bootstrap, the REAL ledger library and the
# REAL migrations, against a REAL postgres:16. Nothing here re-implements
# the thing under test.
#
# Three things are stubbed, and each one is stubbed because it is not the
# thing under test:
#
#   pnpm       — the build. Whether Next.js can compile is not what this gate
#                is about, and the real build takes minutes.
#   systemctl  — there is no systemd in a test, and the unit has gates of
#                its own.
#   psql       — a forwarder. The REAL psql runs, inside the REAL postgres
#                container: the shim forwards its arguments and its standard
#                input to `docker exec -i`, so the SQL that reaches the
#                database is byte for byte the SQL the ledger wrote, applied
#                by the real client against the real server.
#
# `node` is NOT stubbed: the deploy's self-contained-tree check is the real
# script, run by the real node, over the real staged tree.
#
# THE FOUR CLAIMS
# ----------------
#   1. The deploy applies the pending migrations. The table migration 0088
#      creates is in the database afterwards, and the ledger records every
#      migration.
#   2. A second deploy applies nothing. The ledger is what makes the step
#      safe to run on every deploy.
#   3. A migration that fails STOPS the deploy, and the previous build is
#      left in place. A deploy that swapped the build and then failed to
#      apply the migrations would leave the new code running against the old
#      schema — the exact failure this step exists to prevent.
#   4. A deploy from an OLDER commit applies nothing new and undoes
#      nothing. Rolling the code back is not rolling the schema back, and
#      the launch plan says so; this phase is where that claim is proved
#      rather than asserted.
#
# It skips loudly when docker is absent: that is for dev hosts without
# docker. CI always has it, and the workflow step that runs this gate is
# wired so that a skip in CI is a failure rather than a green tick.
#
# hosted/tests/deploy-applies-migrations-negative.sh breaks the migration
# step on purpose, in a copy of the tree, and requires this gate to notice.

set -uo pipefail

# Git Bash on Windows rewrites a container path before it reaches docker.
# Turning the rewriting off is a no-op on Linux, where CI runs this script.
export MSYS_NO_PATHCONV=1

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not present; skipping deploy-applies-migrations"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not present; skipping deploy-applies-migrations"
  exit 0
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The one rule for waiting on a containerised postgres. See the file for why
# the socket is a trap and TCP is not.
# shellcheck source=scripts/lib/postgres-container.sh
source "$REPO/scripts/lib/postgres-container.sh"

# The one description of the tree a deploy reads.
# shellcheck source=hosted/tests/lib/deploy-tree.sh
source "$REPO/hosted/tests/lib/deploy-tree.sh"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# The tree the deploy runs against is built below, from the shared
# description of what a deploy reads — or copied from the tree the negative
# control points this at.

WORK="$(mktemp -d "${TMPDIR:-/tmp}/brownhill-deploy-gate.XXXXXX")"
cids=()
cleanup() {
  for c in "${cids[@]:-}"; do
    [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── the tree ────────────────────────────────────────────────────────────────
#
# A copy of the parts of the repository the deploy reads. It is a copy and
# not the repository itself for two reasons: the deploy's build writes into
# the tree it runs in, and the gate has to be able to add a migration that
# cannot apply.
#
# What is in the copy is described once, in hosted/tests/lib/deploy-tree.sh,
# so that this gate and its negative control cannot drift apart.

# ── the stubs ───────────────────────────────────────────────────────────────
#
# pnpm stands in for the build. The build's own product is what the deploy
# checks for — a standalone output with a server.js in it — and the stub
# produces exactly that, with no symlinks in it, so the deploy's
# self-contained-tree check runs over a tree it can pass.
#
# The stub writes into the tree the deploy runs in, because that is where a
# real build writes.
make_stubs() {
  local bin="$1"
  mkdir -p "$bin"

  cat >"$bin/pnpm" <<'STUB'
#!/usr/bin/env bash
# A stand-in for pnpm: the gate is about the schema, not about Next.js.
set -uo pipefail
case "${1:-}" in
  build:hosted)
    mkdir -p .next/standalone .next/static
    printf '// stand-in for the real standalone server\n' > .next/standalone/server.js
    printf '{}\n' > .next/static/build-manifest.json
    ;;
  *) : ;;
esac
exit 0
STUB

  cat >"$bin/systemctl" <<'STUB'
#!/usr/bin/env bash
# A stand-in for systemctl: there is no systemd in a test.
case "${1:-}" in
  restart) echo "stub: restarted brownhill-next.service" ;;
  status)  echo "stub: brownhill-next.service — active (running)" ;;
  *) : ;;
esac
exit 0
STUB

  cat >"$bin/psql" <<'STUB'
#!/usr/bin/env bash
# A stand-in for psql: the real psql, inside the real postgres container.
#
# The arguments and the standard input are forwarded unchanged, so the SQL
# that reaches the server is the SQL the ledger wrote, and the transaction
# the ledger asked for is the transaction it gets.
exec docker exec -i -e PGHOST=127.0.0.1 -e PGPORT=5432 \
  "$DEPLOY_GATE_PG_CID" psql -U postgres -d postgres "$@"
STUB

  chmod +x "$bin/pnpm" "$bin/systemctl" "$bin/psql"
}

# ── the database ────────────────────────────────────────────────────────────

PG_CID=""
start_pg() {
  local cid
  cid=$(docker run -d --rm -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16) || return 1
  cids+=("$cid")
  PG_CID="$cid"
  export DEPLOY_GATE_PG_CID="$cid"
  if ! wait_for_container_postgres "$cid" 60; then
    echo "postgres did not come up" >&2
    docker logs --tail 30 "$cid" >&2 || true
    return 1
  fi
  return 0
}

# Ask the database something. An empty answer means the question could not be
# asked — the caller says so, rather than treating it as "no".
#
# The standard input is closed, because these are all `-c` queries and a
# psql that inherits a terminal would sit there waiting for one that is
# never coming.
db() { "$STUB_BIN/psql" -tAc "$1" 2>/dev/null </dev/null || printf ''; }

# The shape of the schema, which a second deploy must not change by one.
schema_fingerprint() {
  db "select
      (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema')),
      (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace
        where t.typtype='e' and n.nspname not in ('pg_catalog','information_schema')),
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname not in ('pg_catalog','information_schema'))"
}

# Does a relation of this name exist in the public schema?
relation_exists() {
  local n
  n=$(db "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where c.relname = '$1' and n.nspname = 'public'")
  [ "$n" = "1" ]
}

ledger_rows() { db 'select count(*) from public.schema_migrations'; }

ledger_holds() {
  local n
  n=$(db "select count(*) from public.schema_migrations where filename = '$1'")
  [ "$n" = "1" ]
}

# ── the deploy ──────────────────────────────────────────────────────────────
#
# The REAL deploy script, with the stubs on the PATH and the app directory
# pointed at a temporary one. Its output and its exit code are both kept:
# the exit code says whether it worked, and the output says why.
DEPLOY_OUT=""
DEPLOY_STATUS=0
run_deploy() {
  local tree="$1" app="$2"
  DEPLOY_OUT="$(cd "$tree" && PATH="$STUB_BIN:$PATH" APP_DIR="$app" \
    bash "$tree/hosted/scripts/deploy-app.sh" 2>&1)" && DEPLOY_STATUS=0 || DEPLOY_STATUS=$?
}

STUB_BIN="$WORK/bin"
APP_DIR="$WORK/app"
make_stubs "$STUB_BIN"

if [ -n "${DEPLOY_GATE_TREE:-}" ]; then
  # The negative control points this at a tree whose deploy has had the
  # migration step taken out. It is COPIED, so the tree the control made is
  # never the tree the gate works on — the gate adds a migration to it, and
  # the control's tree has to survive that.
  TREE="$WORK/tree"
  cp -a "$DEPLOY_GATE_TREE" "$TREE"
else
  TREE="$WORK/tree"
  make_deploy_tree "$TREE" "$REPO"
fi

# The number of migrations the tree ships. The ledger must hold one row per
# migration plus one for the shim.
expected_ledger_rows=$(( $(ls -1 "$TREE"/supabase/migrations/*.sql | wc -l) + 1 ))

if ! start_pg; then
  echo "FAIL: could not start a postgres to deploy against" >&2
  exit 1
fi

# ── 1. the deploy applies the pending migrations ────────────────────────────

echo "== 1: the deploy applies the pending migrations =="

run_deploy "$TREE" "$APP_DIR"

if [ "$DEPLOY_STATUS" -eq 0 ]; then
  ok "the deploy exited 0"
else
  bad "the deploy exited $DEPLOY_STATUS"
  echo "$DEPLOY_OUT" | tail -25 | sed 's/^/      /'
fi

if [ -n "$(db 'select count(*) from pg_class')" ]; then
  ok "the database is reachable"
else
  bad "the database could not be reached — every check below would be meaningless"
fi

# THE CENTRAL ASSERTION. Migration 0088 creates the table the self-service
# password reset writes its throttle to. Before the deploy applied the
# migrations, this table was not there, and the reset answered
# `relation "password_reset_requests" does not exist` to the one person who
# needed it.
if relation_exists password_reset_requests; then
  ok "migration 0088's table is in the database"
else
  bad "the deploy did not apply the pending migrations — password_reset_requests is not in the database"
fi

rows=$(ledger_rows)
if [ "$rows" = "$expected_ledger_rows" ]; then
  ok "the ledger holds $rows rows (one per migration, plus the shim)"
else
  bad "the ledger holds $rows rows, expected $expected_ledger_rows"
  echo "$DEPLOY_OUT" | tail -25 | sed 's/^/      /'
fi

if [ -f "$APP_DIR/server.js" ]; then
  ok "the build was installed"
else
  bad "the build was not installed — the deploy did not get as far as the swap"
fi

# ── 2. a second deploy applies nothing ─────────────────────────────────────

echo
echo "== 2: a second deploy applies nothing =="

before_fingerprint=$(schema_fingerprint)
before_rows=$(ledger_rows)

run_deploy "$TREE" "$APP_DIR"

if [ "$DEPLOY_STATUS" -eq 0 ]; then
  ok "the second deploy exited 0"
else
  bad "the second deploy exited $DEPLOY_STATUS"
  echo "$DEPLOY_OUT" | tail -25 | sed 's/^/      /'
fi

if echo "$DEPLOY_OUT" | grep -q 'applied 0 migrations'; then
  ok "the second deploy applied 0 migrations"
else
  bad "the second deploy did not report 'applied 0 migrations'"
  echo "$DEPLOY_OUT" | tail -25 | sed 's/^/      /'
fi

after_fingerprint=$(schema_fingerprint)
if [ "$before_fingerprint" = "$after_fingerprint" ]; then
  ok "the schema is unchanged by the second deploy ($before_fingerprint)"
else
  bad "the second deploy changed the schema: $before_fingerprint -> $after_fingerprint"
fi

after_rows=$(ledger_rows)
if [ "$after_rows" = "$before_rows" ]; then
  ok "the ledger did not grow ($after_rows rows)"
else
  bad "the ledger grew from $before_rows to $after_rows rows"
fi

# ── 3. a migration that fails stops the deploy ─────────────────────────────

echo
echo "== 3: a migration that cannot apply stops the deploy =="

# A marker in the build that is currently installed. The deploy replaces the
# whole directory, so a marker that survives a deploy is a deploy that did
# NOT replace the build. That is the proof this phase needs.
#
# It is written AFTER the second deploy, because the second deploy replaced
# the build — a marker written before it would be gone before phase 3 began,
# and the check would pass for the wrong reason.
printf 'the build that was serving\n' > "$APP_DIR/BUILD-MARKER"

# The migration creates a table and then fails. Both halves matter: the
# failure proves the deploy stops, and the table proves the migration was
# ROLLED BACK rather than half-applied. The ledger applies a migration and
# records it in ONE transaction, so a failure takes the table with it.
cat >"$TREE/supabase/migrations/9999_gate_broken.sql" <<'BROKEN'
-- A migration that cannot apply. It creates a table first, so that the
-- rollback can be seen: if the table survives, the transaction did not roll
-- back, and the database was left half-migrated.
create table if not exists a_table_the_failed_migration_must_not_leave_behind (
  id integer primary key
);
this is not valid sql;
BROKEN

run_deploy "$TREE" "$APP_DIR"

if [ "$DEPLOY_STATUS" -ne 0 ]; then
  ok "the deploy stopped (exit $DEPLOY_STATUS)"
else
  bad "the deploy exited 0 with a migration that cannot apply — it shipped code against a schema that does not exist"
  echo "$DEPLOY_OUT" | tail -25 | sed 's/^/      /'
fi

if [ -f "$APP_DIR/BUILD-MARKER" ]; then
  ok "the previous build is still in place"
else
  bad "the previous build was replaced — the swap happened even though the migrations failed"
fi

if ledger_holds 9999_gate_broken.sql; then
  bad "the ledger records the migration that failed — the transaction did not roll back"
else
  ok "the ledger does not record the migration that failed"
fi

if relation_exists a_table_the_failed_migration_must_not_leave_behind; then
  bad "the failed migration's table is in the database — the migration was half-applied"
else
  ok "the failed migration was rolled back with its ledger row"
fi

if echo "$DEPLOY_OUT" | grep -q 'the deploy stops here'; then
  ok "the deploy says why it stopped"
else
  bad "the deploy stopped without saying why"
  echo "$DEPLOY_OUT" | tail -25 | sed 's/^/      /'
fi

# ── 4. a deploy from an older commit changes nothing ───────────────────────

echo
echo "== 4: a deploy from an older commit applies nothing and undoes nothing =="

# A tree as it was before migrations 0088 and 0089 existed: the same
# deployment scripts, an older set of migrations. This is what `git checkout`
# leaves on the box when the operator rolls the code back.
#
# It is a COPY of the tree this gate is working on, not a fresh build of it
# from the repository. That matters when the gate has been pointed at a tree
# whose deploy is broken — which is exactly what the negative control does:
# this phase has to keep measuring THAT deploy, or the gate would be
# measuring a different deploy than the one it was asked about, and the
# broken run would quietly apply the whole history through a deploy the
# control never broke.
#
# The migration phase 3 broke is taken out too: a deploy from an older
# commit has to be measured against a commit that could actually be
# deployed.
OLD_TREE="$WORK/old-tree"
cp -a "$TREE" "$OLD_TREE"
rm -f "$OLD_TREE"/supabase/migrations/0088_password_reset.sql \
      "$OLD_TREE"/supabase/migrations/0089_audit_system_actor.sql \
      "$OLD_TREE"/supabase/migrations/9999_gate_broken.sql

before_fingerprint=$(schema_fingerprint)
before_rows=$(ledger_rows)

run_deploy "$OLD_TREE" "$APP_DIR"

if [ "$DEPLOY_STATUS" -eq 0 ]; then
  ok "the deploy from the older commit exited 0"
else
  bad "the deploy from the older commit exited $DEPLOY_STATUS"
  echo "$DEPLOY_OUT" | tail -25 | sed 's/^/      /'
fi

if echo "$DEPLOY_OUT" | grep -q 'applied 0 migrations'; then
  ok "it applied 0 migrations"
else
  bad "it did not report 'applied 0 migrations'"
  echo "$DEPLOY_OUT" | tail -25 | sed 's/^/      /'
fi

after_fingerprint=$(schema_fingerprint)
if [ "$before_fingerprint" = "$after_fingerprint" ]; then
  ok "the schema is unchanged ($after_fingerprint)"
else
  bad "the schema changed: $before_fingerprint -> $after_fingerprint"
fi

# The heart of it. The older commit does not carry migration 0088, and the
# table that migration created is STILL THERE. Rolling the code back did not
# roll the schema back, and there is no down-migration that could have.
if relation_exists password_reset_requests; then
  ok "the newer migration's table is still there — the code rollback did not undo the schema"
else
  bad "the older commit's deploy REMOVED a table — rolling the code back must not roll the schema back"
fi

after_rows=$(ledger_rows)
if [ "$after_rows" = "$before_rows" ]; then
  ok "the ledger still holds $after_rows rows — it did not forget the migrations the older tree does not carry"
else
  bad "the ledger holds $after_rows rows, expected $before_rows"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
