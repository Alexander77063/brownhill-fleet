#!/usr/bin/env bash
# hosted/tests/postgrest-schema-cache.sh — PostgREST's schema cache must
# never be a cache of nothing.
#
# WHY THIS TEST EXISTS
# --------------------
# PostgREST reads the database schema ONCE, at start-up, and caches it. A
# PostgREST that starts before the migrations have run has a cache with no
# tables in it, and every WRITE through it then fails:
#
#   * an INSERT answers 404 with an empty body,
#   * an RPC answers PGRST202 ("Could not find the function ... in the
#     schema cache"),
#   * an embedded relationship answers PGRST200 ("Could not find a
#     relationship between ... in the schema cache").
#
# READS keep working, because PostgREST falls through to the database for a
# table it has never heard of. That is what makes this failure so easy to
# miss: the pages render, the data is there, and the writes are silently
# lost.
#
# That is not hypothetical. The compose stack started PostgREST as soon as
# Postgres was healthy, and the bootstrap oneshot applied the schema
# afterwards. The result was a stack in which the legal acceptance could not
# be recorded — the INSERT failed and the code ignored the error — so every
# operator route redirected to /legal/accept, and the audit page could not
# resolve its relationship.
#
# TWO GUARDS, BECAUSE THERE ARE TWO WAYS TO GET THIS WRONG
# --------------------------------------------------------
#   1. A FRESH stack: PostgREST must not start until the bootstrap oneshot
#      has applied the schema. That is the compose file's dependency
#      graph.
#
#   2. A LIVE stack: PostgREST that is already running when a new migration
#      is applied must be told to reload. That is the bootstrap script's
#      `NOTIFY pgrst, 'reload schema'`. The dependency graph cannot help
#      here — on a deployed box PostgREST is a long-running service and the
#      migrations are applied underneath it.
#
# It is a static check over the repository: no docker, no database, no
# secrets. It runs in about a second.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

COMPOSE=hosted/dev/docker-compose.yml
BOOTSTRAP=hosted/bootstrap/brownhill-bootstrap.sh

# The body of one service block from the compose file.
#
# A service header is two spaces and a name; everything nested under it is
# indented further, so the header is the only line at that depth that can end
# a block.
service_block() {
  awk -v want="$1" '
    /^  [A-Za-z0-9_-]+:/ { inside = ($0 ~ "^  " want ":") }
    inside { print }
  ' "$COMPOSE"
}

echo "== 1: PostgREST starts after the schema exists =="

postgrest_block="$(service_block postgrest)"

if printf '%s' "$postgrest_block" | grep -q 'bootstrap:'; then
  ok "the postgrest service waits for the bootstrap oneshot"
else
  bad "the postgrest service does not wait for the bootstrap oneshot — its schema cache is loaded before the migrations run"
fi

if printf '%s' "$postgrest_block" | grep -q 'service_completed_successfully'; then
  ok "the postgrest service waits for the bootstrap to FINISH, not merely to start"
else
  bad "the postgrest service does not wait for the bootstrap to complete successfully"
fi

if printf '%s' "$postgrest_block" | grep -q 'postgres: { condition: service_healthy }'; then
  bad "the postgrest service still waits on postgres alone — postgres being healthy says nothing about the schema"
else
  ok "the postgrest service no longer treats a healthy postgres as a ready schema"
fi

echo
echo "== 2: the app still waits for the schema =="

next_block="$(service_block next)"

if printf '%s' "$next_block" | grep -q 'bootstrap: { condition: service_completed_successfully }'; then
  ok "the next service waits for the bootstrap oneshot to finish successfully"
else
  bad "the next service does not wait for the bootstrap — the app would start against a half-built schema"
fi

echo
echo "== 3: a running PostgREST is told to reload =="

if grep -q "notify pgrst, 'reload schema'" "$BOOTSTRAP"; then
  ok "the bootstrap script asks PostgREST to reload its schema cache"
else
  bad "the bootstrap script applies migrations without notifying PostgREST — a running PostgREST keeps a stale cache"
fi

apply_line="$(grep -n 'ledger_apply_all' "$BOOTSTRAP" | head -1 | cut -d: -f1 || true)"
notify_line="$(grep -n "notify pgrst, 'reload schema'" "$BOOTSTRAP" | head -1 | cut -d: -f1 || true)"

if [ -n "$apply_line" ] && [ -n "$notify_line" ] && [ "$notify_line" -gt "$apply_line" ]; then
  ok "the reload is sent after the migrations are applied (line $notify_line, after line $apply_line)"
else
  bad "the reload is not sent after the migrations are applied (apply at line ${apply_line:-none}, notify at line ${notify_line:-none})"
fi

echo
echo "== 4: no query embeds across the auth boundary =="

# `audit_log.actor` is a foreign key to `auth.users`, and the `auth` schema
# is not one PostgREST exposes. An embed that crosses that boundary can
# never resolve, whatever the cache says: the page fails with PGRST200 and
# renders nothing.
if grep -v '^[[:space:]]*//' src/lib/queries-audit.ts | grep -q 'profiles!audit_log_actor_fkey'; then
  bad "the audit query embeds profiles through audit_log_actor_fkey — that key points at auth.users, which PostgREST does not expose"
else
  ok "the audit query resolves the actor's email without embedding through auth.users"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
