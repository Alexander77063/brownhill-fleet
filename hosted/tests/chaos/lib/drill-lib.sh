#!/usr/bin/env bash
# hosted/tests/chaos/lib/drill-lib.sh
#
# The machinery the chaos drills share.
#
# It was once called `mtd-drill-lib.sh`, because drills 05 and 09 — the two
# HMRC drills — were its first users. Drills 06 and 08 (the period close) use
# it too, and a library named after two of its four callers is a trap for the
# next person. The name is now what it is.
#
# WHY A SHARED LIBRARY
# --------------------
# Drill 05 (a refusal) and drill 09 (an expired token) assert the same
# property from two sides: a return HMRC did not accept must not be settled in
# the ledger. The parts that build the world — the throwaway tenant, the
# OAuth round trip, the application pointed at a stub — are identical, and two
# copies of them would drift apart exactly the way the drills drifted apart
# from the code in the first place.
#
# What is shared, and what is not:
#
#   * SHARED  — which deployment this is (compose or the box), where the
#               database is, how a session is minted, the throwaway tenant,
#               the HTTP helpers, the pass/fail counters.
#   * LOCAL   — the stub HMRC, the OAuth round trip and the VRN. Those are
#               the HMRC drills' own; drills 06 and 08 never call them.
#
# WHAT A DRILL HAS TO PROVE
# -------------------------
# The bug these drills exist for was invisible to every other test, because
# every other test either stubbed the function that lied or never reached it:
#
#     async function callHmrcSubmit(payload: object): Promise<SubmitResult> {
#       void payload;
#       return { status: 'submitted', hmtrCorrelationId: 'HMRC-' + Date.now() };
#     }
#
# It never called HMRC. It always answered "submitted". So the only proof
# that a submission is REALLY filed — and that a refusal REALLY leaves the
# books alone — is to point the DEPLOYED application at an HMRC that answers
# the way the drill needs and watch what the application does with the answer.
#
# That is what this library sets up:
#
#   1. a stub HMRC (hosted/tests/chaos/lib/stub-hmrc.mjs)
#   2. the application pointed at it
#   3. a throwaway tenant carrying a VAT-bearing invoice, so "no journal entry"
#      is a fact about the refusal and not an accident of an empty period
#   4. a real session, minted with the application's own signer
#   5. the OAuth round trip, driven through the application's own route
#
# NOTHING HERE TOUCHES THE CUSTOMER'S DATA. The fixture is its own tenant,
# with its own uuid, and it is deleted on the way out — including when the
# drill fails half way through.
#
# THE TWO WAYS THE APPLICATION CAN BE POINTED AT A STUB
# -----------------------------------------------------
#   compose  The CI stack. The application is recreated with HMRC_MTD_BASE_URL
#            pointing at the compose service `stub-hmrc`. The drill then
#            recreates it again, without the setting, to put it back.
#
#   systemd  The deployed box. A drop-in unit file adds an EnvironmentFile=
#            whose contents override the main unit's mtd.env — a later
#            EnvironmentFile wins, and a drop-in is always read after the main
#            unit. The drill removes the drop-in and restarts the service.
#
# Both are self-verifying: after the application is pointed at the stub, the
# drill reads the running application's own environment and refuses to go on
# unless the stub's address is really in it. A drill that silently tested the
# wrong deployment would be worse than no drill at all.

# ── where things are ────────────────────────────────────────────────────────

DRILL_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The stamp. It is a rule about uniqueness, and rules that four files have
# to agree about live in one place — so it is its own file, with no side
# effects, and the gate that proves it reads it from here too.
#
# shellcheck source=stamp.sh
source "$DRILL_LIB_DIR/stamp.sh"

# The repository root. The library lives at <repo>/hosted/tests/chaos/lib, so
# it is four levels up — lib → chaos → tests → hosted → repo.
#
# It was three, which pointed at <repo>/hosted, and every path built from it
# (`$DRILL_REPO/hosted/dev/docker-compose.yml`) did not exist. The drill then
# reported "neither the compose stack nor the brownhill-next unit is here",
# which is a confusing way to say "I looked in the wrong directory".
DRILL_REPO="$(cd "$DRILL_LIB_DIR/../../../.." && pwd)"

DRILL_COMPOSE_FILE="${DRILL_COMPOSE_FILE:-$DRILL_REPO/hosted/dev/docker-compose.yml}"
DRILL_PERIOD="${DRILL_PERIOD:-2026-03}"
DRILL_VRN="${DRILL_VRN:-123456789}"
DRILL_CLIENT_ID="${DRILL_CLIENT_ID:-chaos-drill-client}"
DRILL_CLIENT_SECRET="${DRILL_CLIENT_SECRET:-chaos-drill-secret}"
DRILL_NODE="${DRILL_NODE:-node}"

# The stub's port inside the compose network and on the host. The compose
# service publishes 8099, so the drill drives it there.
DRILL_STUB_PORT="${DRILL_STUB_PORT:-8099}"

DRILL_TMP="$(mktemp -d)"
DRILL_PASS=0
DRILL_FAIL=0
# The queries that failed during this drill. Empty means none did.
DRILL_SQL_ERRORS="$DRILL_TMP/sql-errors"

# ── output ──────────────────────────────────────────────────────────────────

ok()  { echo "  ok: $*"; DRILL_PASS=$((DRILL_PASS + 1)); }
bad() { echo "  FAIL: $*"; DRILL_FAIL=$((DRILL_FAIL + 1)); }
fail() { echo "FAIL: $*"; exit 1; }
note() { echo "  · $*"; }

# ── the tools ───────────────────────────────────────────────────────────────

need() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || fail "this drill needs $tool, and it is not installed"
  done
}

# ── the database ────────────────────────────────────────────────────────────

# The psql command, as an array. It is derived rather than configured because
# the two places a drill runs differ: the box has its own psql, and the CI
# stack has the postgres container.
DRILL_PSQL_CMD=()

# Where query failures are recorded. A query that fails must not read back as
# an empty value — that is how a drill ends up asserting that a number is
# "nothing" when the truth is that the query never ran.
DRILL_SQL_ERRORS=""

# sql [sql ...]
#
# With arguments: the SQL is passed with `-c`. WITHOUT them: the SQL arrives
# on stdin, which is how the fixture's heredocs work.
#
# The `-c` is not optional. psql takes only a database name and a user name
# as positional arguments — anything else is reported as
#
#     psql: warning: extra command-line argument "select 1" ignored
#
# and the query is never run. The drill does not run under `set -e`, so that
# warning was invisible: every lookup came back empty, every assertion that
# read a number read "nothing", and the drill went on to its next step. The
# fix is to hand psql the query the way psql wants it.
sql() {
  if [[ "${#DRILL_PSQL_CMD[@]}" -eq 0 ]]; then
    fail "the database client was never set up — call drill_setup first"
  fi
  if [[ "$#" -gt 0 ]]; then
    "${DRILL_PSQL_CMD[@]}" -c "$*"
  else
    "${DRILL_PSQL_CMD[@]}"
  fi
}

# A SQL FILE, through the same client.
#
# The RLS proof is a script, not a query: it opens its own transaction,
# switches role, and ends in ROLLBACK. It cannot be sent with `-c`.
sql_file() {
  local file="$1"
  [[ -r "$file" ]] || fail "the SQL file $file is not readable"
  if [[ "${#DRILL_PSQL_CMD[@]}" -eq 0 ]]; then
    fail "the database client was never set up — call drill_setup first"
  fi
  "${DRILL_PSQL_CMD[@]}" <"$file"
}

# The RLS proof, wherever this deployment keeps it.
#
# On the box it is staged next to the rest of the SQL by
# hosted/scripts/fetch-runtime.sh. It used to be read out of the operator's
# git working copy at /opt/brownhill/repo, which does not exist on a box
# deployed from a tarball — so the drill that exists to prove the policies
# still hold could not find the proof.
rls_proof_path() {
  local candidate
  for candidate in \
    "$DRILL_REPO/standalone/sql/portable-rls-proof.sql" \
    "/opt/brownhill/sql/portable-rls-proof.sql" \
    "/opt/brownhill/repo/standalone/sql/portable-rls-proof.sql"; do
    if [[ -r "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# One value, whitespace stripped.
#
# A failing query is recorded and reported, rather than swallowed. The value
# still comes back empty — a caller that checks it will complain — but the
# drill says WHY it was empty at the end, instead of leaving a reader to
# wonder whether the answer was honest.
sql_scalar() {
  local out rc
  out="$(sql "$@" 2>"$DRILL_TMP/sql.err")"
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    printf 'query failed (exit %s): %s\n' "$rc" "$*" >>"$DRILL_SQL_ERRORS"
    sed 's/^/    /' "$DRILL_TMP/sql.err" >>"$DRILL_SQL_ERRORS"
    echo "  · the database refused a query: $*" >&2
    sed 's/^/    /' "$DRILL_TMP/sql.err" >&2
  fi
  printf '%s' "$out" | tr -d '[:space:]'
}

# Text, exactly as the database holds it.
#
# `sql_scalar` strips EVERY space, which is right for a number and ruinous
# for a sentence: the operator's reason on a void is "raised against the
# wrong vehicle", and read through `sql_scalar` it comes back as
# "raisedagainstthewrongvehicle" — which then never matches the text the
# drill was comparing it against, and the drill reports a product fault that
# is not there.
#
# This keeps the text: only the trailing newline psql adds is gone, and
# `$( )` has already removed it.
sql_text() {
  local out rc
  out="$(sql "$@" 2>"$DRILL_TMP/sql.err")"
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    printf 'query failed (exit %s): %s\n' "$rc" "$*" >>"$DRILL_SQL_ERRORS"
    sed 's/^/    /' "$DRILL_TMP/sql.err" >>"$DRILL_SQL_ERRORS"
    echo "  · the database refused a query: $*" >&2
    sed 's/^/    /' "$DRILL_TMP/sql.err" >&2
  fi
  printf '%s' "$out"
}

# The result of a drill: the counters, and the queries that failed.
#
# Every drill ends with this, so a broken query is reported even when the
# assertions it fed happened to pass.
drill_result() {
  echo
  if [[ -n "$DRILL_SQL_ERRORS" && -s "$DRILL_SQL_ERRORS" ]]; then
    local n
    n="$(grep -c '' "$DRILL_SQL_ERRORS")"
    bad "$n database query/queries failed during this drill — the answers it read were empty for the wrong reason"
    sed 's/^/    /' "$DRILL_SQL_ERRORS"
  fi
  echo "Result: $DRILL_PASS passed, $DRILL_FAIL failed"
  [[ "$DRILL_FAIL" -eq 0 ]] || exit 1
}

# ── uuid ────────────────────────────────────────────────────────────────────

new_uuid() {
  "$DRILL_NODE" -e 'console.log(crypto.randomUUID())'
}

# ── the application ─────────────────────────────────────────────────────────

# DRILL_APP_CONTROL is compose | systemd.
# DRILL_APP_URL is where the drill reaches the application.
# DRILL_PSQL_CMD is the database client.
# DRILL_JWT_SECRET is the secret the application signs its sessions with.
DRILL_APP_CONTROL=""
DRILL_APP_URL=""
DRILL_JWT_SECRET=""
DRILL_NEXT_CID=""
DRILL_PG_CID=""

# Which deployment is this drill driving?
detect_app_control() {
  if [[ -n "${DRILL_APP_CONTROL_OVERRIDE:-}" ]]; then
    echo "$DRILL_APP_CONTROL_OVERRIDE"
    return
  fi
  if need_docker && docker compose -f "$DRILL_COMPOSE_FILE" ps -q next 2>/dev/null | grep -q .; then
    echo compose
    return
  fi
  if command -v systemctl >/dev/null 2>&1 && \
     systemctl cat brownhill-next.service >/dev/null 2>&1; then
    echo systemd
    return
  fi
  echo none
}

need_docker() { command -v docker >/dev/null 2>&1; }

# Set up everything that depends on WHICH deployment this is.
drill_setup() {
  need curl "$DRILL_NODE"

  DRILL_APP_CONTROL="$(detect_app_control)"
  case "$DRILL_APP_CONTROL" in
    compose) setup_compose ;;
    systemd) setup_systemd ;;
    none)
      fail "this drill needs a running deployment: neither the compose stack nor the brownhill-next unit is here"
      ;;
    *) fail "unknown DRILL_APP_CONTROL: $DRILL_APP_CONTROL" ;;
  esac

  # Sweep FIRST. A drill that was killed outright — SIGKILL, a closed
  # terminal, a machine that lost power — never runs its cleanup, and its
  # fixture stays in the customer's database. The next drill is the one that
  # has to clear it away.
  drill_sweep_leftovers || fail "the drill could not sweep the leftovers of an earlier run"
}

setup_compose() {
  need docker
  DRILL_PG_CID="$(docker compose -f "$DRILL_COMPOSE_FILE" ps -q postgres 2>/dev/null || true)"
  DRILL_NEXT_CID="$(docker compose -f "$DRILL_COMPOSE_FILE" ps -q next 2>/dev/null || true)"
  [[ -n "$DRILL_PG_CID" ]] || fail "the compose stack's postgres container is not running"
  [[ -n "$DRILL_NEXT_CID" ]] || fail "the compose stack's next container is not running"

  # `-tAq`, not `-tAqc`.
  #
  # The trailing `c` was read as "the next argument is the command", so psql
  # was handed `-c` with nothing after it and refused to start — while the
  # drill carried on, because it does not run under `set -e`. The flags are
  # `-t` (tuples only), `-A` (unaligned) and `-q` (quiet). The SQL itself
  # arrives either as the single argument after them, or on stdin for the
  # heredocs the fixture uses.
  #
  # `-v ON_ERROR_STOP=1` is the flag that makes a failed statement a failed
  # COMMAND. Without it, psql answers 0 when a statement in a script fails:
  #
  #     $ printf 'select 1 from no_such_table;\nselect 42;\n' | psql -tAq
  #     ERROR:  relation "no_such_table" does not exist
  #     42
  #     $ echo $?
  #     0
  #
  # So the fixture's inserts and the cleanup's deletes could all fail — the
  # database refusing the rows, the foreign keys refusing the deletes — and
  # the drill carried on and reported success. The error text was on stderr
  # and nobody was reading it. With the flag, the same script answers 3 and
  # stops at the failure.
  DRILL_PSQL_CMD=(docker exec -i "$DRILL_PG_CID" psql -U postgres -d postgres -tAq -v ON_ERROR_STOP=1)
  DRILL_APP_URL="${DRILL_APP_URL:-http://127.0.0.1:55431}"

  # The secret the RUNNING application signs with, read from the container.
  # Reading it from the environment instead would let the drill and the
  # application disagree — and a token signed with the wrong secret looks
  # exactly like an application that refuses every request.
  DRILL_JWT_SECRET="$(docker inspect "$DRILL_NEXT_CID" \
    --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | sed -n 's/^\(JWT_SHARED_SECRET\|LOCAL_JWT_SECRET\)=//p' | head -1)"
  [[ -n "$DRILL_JWT_SECRET" ]] || fail "the running application has no JWT signing secret"

  note "driving the compose stack (app: $DRILL_APP_URL)"
}

# The box's database password.
#
# The cluster is created with `--auth-host=scram-sha-256`, so every
# connection over TCP needs the superuser's password — and the drill
# connects over TCP. Without this the drill's first query answered
#
#     password authentication failed for user postgres
#
# on a perfectly healthy box, and every box-only drill died there, before it
# had tested the thing it exists to test. A drill that fails for a reason
# that has nothing to do with the fault is worse than no drill.
#
# The password is the box's own: PG_SUPERUSER_PASSWORD in
# /etc/brownhill/secrets/pg.env — the same file the backup and the
# bootstrap read it from.
box_pg_password() {
  local file="/etc/brownhill/secrets/pg.env"
  [[ -r "$file" ]] \
    || fail "the box has no readable $file, so the drill cannot authenticate to the database"
  local pw
  # The whole rest of the line is the password: it may contain '='.
  pw="$(sed -n 's/^PG_SUPERUSER_PASSWORD=//p' "$file" | head -1)"
  [[ -n "$pw" ]] || fail "$file carries no PG_SUPERUSER_PASSWORD"
  export PGPASSWORD="$pw"
}

setup_systemd() {
  [[ "$(id -u)" -eq 0 ]] || fail "driving the deployed box needs root — it restarts the service"
  need systemctl
  DRILL_PSQL_CMD=(/opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -tAq -v ON_ERROR_STOP=1)
  [[ -x /opt/brownhill/pgsql/bin/psql ]] || fail "/opt/brownhill/pgsql/bin/psql is not present"
  box_pg_password
  DRILL_APP_URL="${DRILL_APP_URL:-https://127.0.0.1}"

  # The secret the unit gives the application. The unit reads it from a file
  # the operator owns; the drill reads the same file rather than a copy.
  local secret_file=""
  for candidate in /etc/brownhill/secrets/jwt.env /etc/brownhill/secrets/app.env; do
    if [[ -f "$candidate" ]] && grep -qE '^(JWT_SHARED_SECRET|LOCAL_JWT_SECRET)=' "$candidate"; then
      secret_file="$candidate"
      break
    fi
  done
  [[ -n "$secret_file" ]] || fail "no jwt.env or app.env carries the application's signing secret"
  DRILL_JWT_SECRET="$(sed -n 's/^\(JWT_SHARED_SECRET\|LOCAL_JWT_SECRET\)=\(.*\)$/\2/p' "$secret_file" | head -1)"
  [[ -n "$DRILL_JWT_SECRET" ]] || fail "the secret file carries no signing secret"

  note "driving the deployed box (app: $DRILL_APP_URL)"
}

# ── the database, under the drill's hand ────────────────────────────────────
#
# A drill that kills the database has to be able to bring it back, and it
# has to bring it back the way THIS deployment starts it: the compose
# stack's container, or the box's systemd unit. Both paths exist because
# both deployments exist — and a drill that can only be run on one of them
# is a drill that is only ever run on one of them.
#
# The compose path is not decoration. It is what lets these two drills run
# in CI, and a monthly exercise that only happens when the customer
# remembers to run it is a monthly exercise that has not happened.
db_kill_hard() {
  case "$DRILL_APP_CONTROL" in
    compose)
      docker compose -f "$DRILL_COMPOSE_FILE" kill -s SIGKILL postgres >/dev/null 2>&1
      ;;
    systemd)
      systemctl kill -s SIGKILL postgresql.service
      ;;
    *)
      fail "there is no database here to kill"
      ;;
  esac
}

db_start() {
  case "$DRILL_APP_CONTROL" in
    compose)
      docker compose -f "$DRILL_COMPOSE_FILE" up -d --no-deps postgres >/dev/null 2>&1
      ;;
    systemd)
      systemctl start postgresql.service
      ;;
    *)
      fail "there is no database here to start"
      ;;
  esac
  # The container's id is looked up again: a container that was killed and
  # started again can come back under a different id, and the drill holds
  # the old one in DRILL_PG_CID.
  if [[ "$DRILL_APP_CONTROL" == "compose" ]]; then
    DRILL_PG_CID="$(docker compose -f "$DRILL_COMPOSE_FILE" ps -q postgres 2>/dev/null || true)"
  fi
}

db_restart() {
  case "$DRILL_APP_CONTROL" in
    compose)
      docker compose -f "$DRILL_COMPOSE_FILE" restart postgres >/dev/null 2>&1
      ;;
    systemd)
      systemctl restart postgresql.service
      ;;
    *)
      fail "there is no database here to restart"
      ;;
  esac
  if [[ "$DRILL_APP_CONTROL" == "compose" ]]; then
    DRILL_PG_CID="$(docker compose -f "$DRILL_COMPOSE_FILE" ps -q postgres 2>/dev/null || true)"
  fi
}

# Is the database answering? This asks the DATABASE, and it deliberately
# records nothing on failure: the drill expects the database to be gone for
# a moment, and a recorded error would turn the outage the drill caused
# into the failure the drill reports.
db_answers() {
  sql "select 1" >/dev/null 2>&1
}

# ── the stub HMRC ───────────────────────────────────────────────────────────

# Where the drill reaches the stub.
DRILL_STUB_URL=""
# Where the APPLICATION reaches the stub.
DRILL_STUB_URL_FOR_APP=""
DRILL_STUB_PID=""

stub_start() {
  local mode="$1"

  if [[ "$DRILL_APP_CONTROL" == compose ]]; then
    # The compose service. Recreated so the mode takes effect.
    #
    # `docker compose up -d` answers 0 as soon as the container has been
    # STARTED, not as soon as it is HEALTHY — and a container whose command
    # dies on startup still counts as started. So this cannot be the only
    # check; the wait below is the real one, and it is the one that reports
    # the container's log when it fails.
    if ! STUB_MODE="$mode" docker compose -f "$DRILL_COMPOSE_FILE" \
      up -d --force-recreate --no-deps stub-hmrc >/dev/null; then
      echo "  · docker could not start the stub service at all" >&2
      fail "the stub HMRC could not be started — mode $mode"
    fi
    DRILL_STUB_URL="http://127.0.0.1:${DRILL_STUB_PORT}"
    DRILL_STUB_URL_FOR_APP="http://stub-hmrc:${DRILL_STUB_PORT}"
  else
    # On the box the stub runs on the same host as the application, so both
    # addresses are the same.
    STUB_MODE="$mode" STUB_PORT="$DRILL_STUB_PORT" \
      "$DRILL_NODE" "$DRILL_REPO/hosted/tests/chaos/lib/stub-hmrc.mjs" \
      >"$DRILL_TMP/stub.log" 2>&1 &
    DRILL_STUB_PID=$!
    DRILL_STUB_URL="http://127.0.0.1:${DRILL_STUB_PORT}"
    DRILL_STUB_URL_FOR_APP="$DRILL_STUB_URL"
  fi

  # Wait for it to answer, rather than sleeping and hoping.
  local waited=0
  while [[ "$waited" -lt 100 ]]; do
    if curl -sS -f -m 2 "${DRILL_STUB_URL}/_stub/health" >/dev/null 2>&1; then
      ok "the stub HMRC is up (mode: $mode)"
      return
    fi
    sleep 0.2
    waited=$((waited + 1))
  done

  # Say WHY it did not come up.
  #
  # "The stub HMRC never came up" is true and useless on its own. The usual
  # cause is that the container died on startup — a missing script, a bad
  # mount, a mode it does not know — and the reason is in its log, not in
  # the drill. A drill that does not show the log sends the next person
  # hunting for it.
  echo "  · the stub HMRC did not answer. Its own log says:" >&2
  if [[ "$DRILL_APP_CONTROL" == compose ]]; then
    docker compose -f "$DRILL_COMPOSE_FILE" logs --tail 30 --no-color stub-hmrc 2>&1 \
      | sed 's/^/    /' >&2
  else
    sed 's/^/    /' "$DRILL_TMP/stub.log" 2>/dev/null >&2
  fi
  fail "the stub HMRC never came up — mode $mode"
}

stub_stop() {
  if [[ "$DRILL_APP_CONTROL" == compose ]]; then
    docker compose -f "$DRILL_COMPOSE_FILE" stop stub-hmrc >/dev/null 2>&1 || true
    docker compose -f "$DRILL_COMPOSE_FILE" rm -f stub-hmrc >/dev/null 2>&1 || true
  fi
  if [[ -n "$DRILL_STUB_PID" ]]; then
    kill "$DRILL_STUB_PID" >/dev/null 2>&1 || true
    wait "$DRILL_STUB_PID" 2>/dev/null || true
  fi
}

# The stub's counters, as JSON.
stub_stats() {
  curl -sS -f -m 5 "${DRILL_STUB_URL}/_stub/stats" 2>/dev/null || echo '{}'
}

# One counter out of that JSON. Deliberately not `jq`: the box does not have
# it, and a drill that needs a tool the box does not carry is a drill that
# cannot run where it is supposed to.
stub_stat() {
  echo "$1" | sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p" | head -1
}

# ── pointing the application at the stub ────────────────────────────────────

# Whether the application is currently pointed at the stub. The cleanup uses
# it to decide whether there is anything to put back.
DRILL_APP_POINTED_AT_STUB=0

# The HMRC settings the application is given. The VRN is deliberately NOT
# among them: the drill sets the tenant's own number through the API, which
# is the path an operator uses, and a fixture that took the install-level
# fallback would not prove that the tenant's number is the one filed against.
hmrc_settings() {
  printf '%s\n' \
    "HMRC_MTD_CLIENT_ID=$DRILL_CLIENT_ID" \
    "HMRC_MTD_CLIENT_SECRET=$DRILL_CLIENT_SECRET" \
    "HMRC_MTD_REDIRECT_URI=${DRILL_APP_URL}/api/v1/accounting/mtd/callback" \
    "HMRC_MTD_BASE_URL=$DRILL_STUB_URL_FOR_APP"
}

app_point_at_stub() {
  if [[ "$DRILL_APP_CONTROL" == compose ]]; then
    export HMRC_MTD_CLIENT_ID="$DRILL_CLIENT_ID"
    export HMRC_MTD_CLIENT_SECRET="$DRILL_CLIENT_SECRET"
    export HMRC_MTD_REDIRECT_URI="${DRILL_APP_URL}/api/v1/accounting/mtd/callback"
    export HMRC_MTD_BASE_URL="$DRILL_STUB_URL_FOR_APP"
    docker compose -f "$DRILL_COMPOSE_FILE" up -d --force-recreate --no-deps next >/dev/null
    unset HMRC_MTD_CLIENT_ID HMRC_MTD_CLIENT_SECRET HMRC_MTD_REDIRECT_URI HMRC_MTD_BASE_URL
  else
    install_systemd_drop_in
  fi
  DRILL_APP_POINTED_AT_STUB=1
  wait_for_app
  assert_app_points_at_stub
}

# The box's drop-in. An EnvironmentFile=, not an Environment= — the unit's own
# EnvironmentFile= would otherwise be read after it and win.
install_systemd_drop_in() {
  local dir=/etc/systemd/system/brownhill-next.service.d
  local file="$dir/zz-chaos-hmrc.conf"
  local env=/etc/brownhill/secrets/mtd-chaos.env

  mkdir -p "$dir"
  hmrc_settings >"$env"
  chmod 0600 "$env"
  printf '[Service]\nEnvironmentFile=-%s\n' "$env" >"$file"
  systemctl daemon-reload
  systemctl restart brownhill-next.service
}

app_restore() {
  # Nothing to undo if the application was never pointed at the stub. The
  # period-close drills never point it at anything, and recreating the
  # container for them would restart the application for no reason — and,
  # on the box, restart the customer's service for no reason.
  [[ "$DRILL_APP_POINTED_AT_STUB" == "1" ]] || return 0

  if [[ "$DRILL_APP_CONTROL" == compose ]]; then
    unset HMRC_MTD_CLIENT_ID HMRC_MTD_CLIENT_SECRET HMRC_MTD_REDIRECT_URI HMRC_MTD_BASE_URL
    docker compose -f "$DRILL_COMPOSE_FILE" up -d --force-recreate --no-deps next >/dev/null || true
  else
    rm -f /etc/systemd/system/brownhill-next.service.d/zz-chaos-hmrc.conf
    rm -f /etc/brownhill/secrets/mtd-chaos.env
    systemctl daemon-reload || true
    systemctl restart brownhill-next.service || true
  fi
  DRILL_APP_POINTED_AT_STUB=0
}

# Wait for the application to answer at all.
#
# The probe is the sign-in page, because it is the one URL that answers 200
# without a session. An API route would answer 401 or 500 to an
# unauthenticated request, and a drill that waited for a 2xx there would spin
# for half a minute and then carry on as though the application were ready.
wait_for_app() {
  local waited=0
  while [[ "$waited" -lt 150 ]]; do
    if curl -sS -k -f -m 3 -o /dev/null "$DRILL_APP_URL/login" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
    waited=$((waited + 1))
  done
  return 1
}

# Is the RUNNING application really pointed at the stub?
#
# Without this check a drill could pass against an application that was never
# repointed — and it would be testing HMRC's sandbox, or nothing at all.
assert_app_points_at_stub() {
  local found=""
  if [[ "$DRILL_APP_CONTROL" == compose ]]; then
    # The container was RECREATED to give it the stub's address, so the id
    # captured during setup is gone. Refresh it FIRST.
    #
    # The refresh used to happen after the inspect, which made this check
    # inspect a container that no longer existed. `docker inspect` answered
    # "no such object", the pipeline produced nothing, and the check then
    # reported that the application pointed at nothing — a true statement
    # about a dead container and a false one about the application.
    DRILL_NEXT_CID="$(docker compose -f "$DRILL_COMPOSE_FILE" ps -q next 2>/dev/null || true)"
    [[ -n "$DRILL_NEXT_CID" ]] || \
      fail "the application's container is gone — the drill cannot tell whether it is pointed at the stub"
    found="$(docker inspect "$DRILL_NEXT_CID" \
      --format '{{range .Config.Env}}{{println .}}{{end}}' \
      | sed -n 's/^HMRC_MTD_BASE_URL=//p' | head -1)"
  else
    local pid
    pid="$(systemctl show -p MainPID --value brownhill-next.service 2>/dev/null || echo 0)"
    if [[ "$pid" != "0" && -r "/proc/$pid/environ" ]]; then
      found="$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^HMRC_MTD_BASE_URL=//p' | head -1)"
    fi
  fi

  if [[ "$found" != "$DRILL_STUB_URL_FOR_APP" ]]; then
    fail "the running application points at '${found:-nothing}', not the stub ('$DRILL_STUB_URL_FOR_APP') — the drill would be testing the wrong deployment"
  fi
  ok "the running application is pointed at the stub"
}

# ── the fixture ─────────────────────────────────────────────────────────────

DRILL_TENANT_ID=""
DRILL_USER_ID=""
DRILL_SESSION=""

fixture_create() {
  local periods=("$@")
  [[ "${#periods[@]}" -gt 0 ]] || periods=("$DRILL_PERIOD")

  local stamp
  DRILL_TENANT_ID="$(new_uuid)"
  DRILL_USER_ID="$(new_uuid)"

  # The stamp names THIS tenant, so it is derived from this tenant's own
  # id — the primary key of the row it is about to become. Two fixtures
  # therefore cannot share a stamp unless they share a primary key, which
  # is a promise the clock could never keep. See hosted/tests/chaos/lib/
  # stamp.sh for how the old stamp broke it.
  stamp="$(new_stamp "$DRILL_TENANT_ID")"

  local vat_code_id
  vat_code_id="$(sql_scalar "select id from accounting.vat_codes where code = 'T1' and tenant_id is null")"
  [[ -n "$vat_code_id" ]] || fail "the chart of VAT codes has no global T1 row — the drill cannot build a VAT-bearing invoice"

  # One invoice, one period, per period the drill is going to file for. Each
  # period needs its own invoice, because the return's figures come from the
  # invoices issued in that period — a second filing in the same month would
  # settle the same figures twice.
  local invoices="" periods_sql="" n=0
  for period in "${periods[@]}"; do
    local year="${period%%-*}" month="${period##*-}"
    n=$((n + 1))
    invoices="$invoices
insert into public.invoices
  (agreement_id, number, issued_on, due_on, gross_pence, net_pence, vat_pence,
   status, tenant_id, vat_code_id)
select a.id, 'CHAOS-INV-$stamp-$n', make_date($year::int, $month::int, 1),
       make_date($year::int, $month::int, 1), 12000, 10000, 2000,
       'open', '$DRILL_TENANT_ID', '$vat_code_id'
  from public.agreements a
 where a.tenant_id = '$DRILL_TENANT_ID';"
    periods_sql="$periods_sql
insert into accounting.periods (tenant_id, year, month)
values ('$DRILL_TENANT_ID', $year, $month);"
  done

  # One transaction. The fixture is a world: a tenant without its owner, or
  # an owner without the membership that lets them see the tenant, is not a
  # half-built fixture the drill can work with — it is debris. The
  # transaction makes it all or nothing.
  #
  # The `begin`/`commit` are here for the same reason ON_ERROR_STOP is: a
  # statement that fails inside a transaction takes the whole transaction
  # with it, so the drill cannot leave half a tenant behind.
  if ! sql >/dev/null <<SQL
begin;

insert into public.tenants (id, name, slug)
values ('$DRILL_TENANT_ID', 'Chaos Drill', 'chaos-drill-$stamp');

insert into auth.users (id, email, raw_user_meta_data)
values ('$DRILL_USER_ID', 'chaos-drill-$stamp@chaos.invalid',
        '{"role":"owner","full_name":"Chaos Drill"}'::jsonb);

insert into public.tenant_memberships (tenant_id, user_id, role, permissions, status)
values ('$DRILL_TENANT_ID', '$DRILL_USER_ID', 'owner', '{}', 'active');

insert into public.vehicles (id, registration, make, model, list_value_pence, tenant_id)
values (gen_random_uuid(), 'CHAOS-$stamp', 'Chaos', 'Drill', 100000, '$DRILL_TENANT_ID');

insert into public.drivers (id, full_name, tenant_id)
values (gen_random_uuid(), 'Chaos Drill', '$DRILL_TENANT_ID');

insert into public.agreements
  (id, type, vehicle_id, driver_id, status, start_date,
   weekly_gross_pence, weekly_net_pence, weekly_vat_pence, tenant_id)
select gen_random_uuid(), 'standard', v.id, d.id, 'draft', make_date($year::int, $month::int, 1),
       12000, 10000, 2000, '$DRILL_TENANT_ID'
  from public.vehicles v, public.drivers d
 where v.tenant_id = '$DRILL_TENANT_ID'
   and d.tenant_id = '$DRILL_TENANT_ID';
$invoices
$periods_sql

commit;
SQL
  then
    fail "the drill's tenant could not be created"
  fi

  # THE FIXTURE MUST BE ISOLATED FROM EVERY OTHER FIXTURE.
  #
  # This used to join the tenant's vehicle against every driver in the
  # database whose name was 'Chaos Drill' — with no tenant filter. One
  # driver of that name is expected; two is a cross join, and a cross join
  # here means two agreements, and two agreements means two invoices with
  # the SAME number, and `invoices.number` is unique. The fixture then died
  # with "duplicate key value violates unique constraint" — a failure that
  # looks like a database fault and is not one.
  #
  # It is not a hypothetical. The handover journey holds its own fixture
  # open while the accounting gate builds a second one, and that is exactly
  # when it bit: the second fixture saw the first one's driver and made two
  # agreements. Any two drills running at once, or a drill left behind by a
  # killed run, would do the same.
  #
  # So the fixture now asserts its own isolation, here, where the mistake
  # was. A fixture that cannot see that it has been polluted fails loudly at
  # creation instead of failing confusingly three assertions later.
  local made_agreements made_invoices
  made_agreements="$(sql_scalar "select count(*) from public.agreements
                                  where tenant_id = '$DRILL_TENANT_ID'")"
  made_invoices="$(sql_scalar "select count(*) from public.invoices
                                where tenant_id = '$DRILL_TENANT_ID'")"
  [[ "$made_agreements" == "1" ]] \
    || fail "the fixture made $made_agreements agreements, expected 1 — it is not isolated from another fixture"
  [[ "$made_invoices" == "${#periods[@]}" ]] \
    || fail "the fixture made $made_invoices invoices, expected ${#periods[@]} — it is not isolated from another fixture"

  ok "the drill's own tenant exists, with a VAT-bearing invoice for ${periods[*]}"
}

# ── a bank line waiting to be categorised ────────────────────────────────
#
# The period-close drill needs one: a bank line dated in the month that has
# not been categorised is exactly what the close warns about, and it is what
# a posting into a closed month would have been.
#
# The line is dated on the FIFTEENTH of the month, in UTC, because both sides
# of the product count bank lines in UTC: the preflight counts them between
# `make_date(y, m, 1) at time zone 'UTC'` and the same date plus a month,
# and the posting side reads the month out of `posted_at` with
# `getUTCFullYear()` / `getUTCMonth()`. A line dated on the first of the month
# would still work, but the fifteenth cannot be mistaken for a month boundary
# by either side — and a boundary is where an off-by-one would hide.
DRILL_BANK_TX_ID=""
DRILL_BANK_ACCOUNT_ID=""
DRILL_BANK_IMPORT_ID=""

fixture_add_open_bank_line() {
  local period="$1" amount="${2:-12345}"
  local year="${period%%-*}" month="${period##*-}"

  local bank_gl
  bank_gl="$(sql_scalar "select id from accounting.chart_of_accounts
                           where code = '1200' and tenant_id is null")"
  [[ -n "$bank_gl" ]] || fail "the chart of accounts has no global 1200 Bank Account row"

  DRILL_BANK_ACCOUNT_ID="$(new_uuid)"
  DRILL_BANK_IMPORT_ID="$(new_uuid)"
  DRILL_BANK_TX_ID="$(new_uuid)"

  if ! sql >/dev/null <<SQL
begin;

insert into accounting.bank_accounts (id, name, currency, gl_account_id, tenant_id)
values ('$DRILL_BANK_ACCOUNT_ID', 'Chaos Drill Bank', 'GBP', '$bank_gl', '$DRILL_TENANT_ID');

insert into accounting.bank_imports
  (id, bank_account_id, file_name, file_sha256, period_id, tenant_id)
select '$DRILL_BANK_IMPORT_ID', '$DRILL_BANK_ACCOUNT_ID', 'chaos-drill.csv',
       digest('chaos-drill-$DRILL_BANK_IMPORT_ID', 'sha256'),
       p.id, '$DRILL_TENANT_ID'
  from accounting.periods p
 where p.tenant_id = '$DRILL_TENANT_ID'
   and p.year = $year and p.month = $month;

insert into accounting.bank_transactions
  (id, bank_import_id, bank_account_id, posted_at, amount_pence, description, status, tenant_id)
values ('$DRILL_BANK_TX_ID', '$DRILL_BANK_IMPORT_ID', '$DRILL_BANK_ACCOUNT_ID',
        (make_date($year::int, $month::int, 15)::timestamp at time zone 'UTC'),
        $amount, 'CHAOS DRILL OPEN BANK LINE', 'unmatched', '$DRILL_TENANT_ID');

commit;
SQL
  then
    fail "the open bank line could not be inserted"
  fi

  ok "an open bank line of $amount pence is waiting to be categorised in $period"
}

# ── a second operator ─────────────────────────────────────────────────────
#
# The concurrent-close drill needs two DIFFERENT people. The point of the
# refusal is that it names who won — and that can only be shown when the two
# operators are not the same user.
DRILL_EXTRA_USER_IDS=""

fixture_add_operator() {
  local label="${1:-Second}"
  local stamp id
  id="$(new_uuid)"
  # Derived from this user's own id, for the same reason the fixture's
  # stamp is derived from the tenant's: `auth.users.email` is unique, and
  # two drills built in the same second must not collide on it.
  stamp="$(new_stamp "$id")"

  # This function is called in a command substitution, so `fail` here would
  # only end the subshell. The caller checks that an id came back.
  if ! sql >/dev/null <<SQL
begin;

insert into auth.users (id, email, raw_user_meta_data)
values ('$id', 'chaos-drill-$label-$stamp@chaos.invalid',
        '{"role":"owner","full_name":"Chaos Drill $label"}'::jsonb);

insert into public.tenant_memberships (tenant_id, user_id, role, permissions, status)
values ('$DRILL_TENANT_ID', '$id', 'owner', '{}', 'active');

commit;
SQL
  then
    echo "the $label operator could not be created" >&2
    return 1
  fi

  # The id goes in a FILE, not in a variable. This function runs inside a
  # command substitution, so a variable it sets would be lost with the
  # subshell — and the extra operator's row would survive the drill, in the
  # customer's database, because nothing remembered to delete it.
  echo "$id" >>"$DRILL_TMP/extra-users"
  echo "$id"
}

fixture_destroy() {
  [[ -n "$DRILL_TENANT_ID" ]] || return 0

  # THE ORDER MATTERS, and getting it wrong is how the drill used to leave a
  # tenant, its periods, its journal entry and its user behind in the
  # customer's database — while reporting that it had passed.
  #
  # The old order deleted `journal_entries` BEFORE `vat_submissions`, and
  # `vat_submissions.posted_journal_id` references `journal_entries`. The
  # delete was refused, and because psql was running without
  # ON_ERROR_STOP the refusal did not stop the script or change its exit
  # code: psql answered 0 and the drill went on to its next statement. That
  # one refusal then cascaded — `periods` could not go because
  # `journal_entries` still referenced it, `tenants` could not go because
  # `periods` still referenced it, and `auth.users` could not go because
  # `journal_entries.posted_by_user_id` still referenced it. Four refusals,
  # one invisible, and a pile of debris.
  #
  # So: children before parents, in the order the foreign keys demand.
  #   vat_submissions  → journal_entries, periods
  #   journal_lines    → journal_entries
  #   bank_transactions→ journal_entries, bank_accounts, bank_imports, invoices
  #   journal_entries  → periods, tenants, auth.users
  #   bank_imports     → periods, tenants, auth.users, bank_accounts
  #   tenant_accounting_settings → bank_accounts
  #   bank_accounts    → tenants, chart_of_accounts
  #   periods          → tenants, auth.users
  #   audit_log        → tenants, auth.users
  #   payment_allocations → payments, invoices
  #   payments         → tenants, agreements, drivers, bank_accounts
  #   invoices         → tenants, agreements, vat_codes
  #   agreements       → tenants, drivers, vehicles
  #   tenant_memberships → tenants, profiles
  #   tenants, auth.users → everything above
  #
  # One transaction, so the cleanup is all or nothing: a partial teardown
  # is debris, and debris is what this is here to avoid.
  if ! sql >/dev/null 2>"$DRILL_TMP/cleanup.err" <<SQL
begin;

delete from accounting.vat_return_lines
 where vat_submission_id in (select id from accounting.vat_submissions where tenant_id = '$DRILL_TENANT_ID');
delete from accounting.filing_artifacts
 where vat_submission_id in (select id from accounting.vat_submissions where tenant_id = '$DRILL_TENANT_ID');
delete from accounting.vat_submissions where tenant_id = '$DRILL_TENANT_ID';

delete from accounting.journal_lines
 where journal_id in (select id from accounting.journal_entries where tenant_id = '$DRILL_TENANT_ID');

delete from accounting.bank_transactions where tenant_id = '$DRILL_TENANT_ID';

delete from accounting.journal_entries where tenant_id = '$DRILL_TENANT_ID';

delete from accounting.bank_imports where tenant_id = '$DRILL_TENANT_ID';
delete from accounting.tenant_accounting_settings where tenant_id = '$DRILL_TENANT_ID';
delete from accounting.bank_accounts where tenant_id = '$DRILL_TENANT_ID';

delete from accounting.periods where tenant_id = '$DRILL_TENANT_ID';
delete from accounting.audit_log where tenant_id = '$DRILL_TENANT_ID';
delete from accounting.firs_credentials where tenant_id = '$DRILL_TENANT_ID';

delete from public.payment_allocations where tenant_id = '$DRILL_TENANT_ID';
delete from public.payments where tenant_id = '$DRILL_TENANT_ID';
delete from public.invoices where tenant_id = '$DRILL_TENANT_ID';
delete from public.agreements where tenant_id = '$DRILL_TENANT_ID';
delete from public.drivers where tenant_id = '$DRILL_TENANT_ID';
delete from public.vehicles where tenant_id = '$DRILL_TENANT_ID';
delete from public.tenant_memberships where tenant_id = '$DRILL_TENANT_ID';

delete from public.tenants where id = '$DRILL_TENANT_ID';
delete from auth.users where id = '$DRILL_USER_ID';

commit;
SQL
  then
    echo "  · the drill could not delete its own rows — the database refused:" >&2
    sed 's/^/    /' "$DRILL_TMP/cleanup.err" >&2
    return 1
  fi

  # The extra operators, one by one — they are not in the list above.
  local extra
  if [[ -f "$DRILL_TMP/extra-users" ]]; then
    while IFS= read -r extra; do
      [[ -n "$extra" ]] || continue
      if ! sql "delete from auth.users where id = '$extra'" >/dev/null 2>"$DRILL_TMP/cleanup.err"; then
        echo "  · the drill could not delete the extra operator $extra:" >&2
        sed 's/^/    /' "$DRILL_TMP/cleanup.err" >&2
        return 1
      fi
    done <"$DRILL_TMP/extra-users"
  fi
  DRILL_EXTRA_USER_IDS=""
  DRILL_TENANT_ID=""
  return 0
}

# ── sweeping up after a drill that was killed ──────────────────────────────
#
# The cleanup trap runs when the drill exits. It does NOT run when the drill
# is killed outright — SIGKILL, a closed terminal, a machine that lost
# power — and then the fixture stays behind.
#
# A drill that leaves a tenant, its periods and its journal entries in the
# customer's database has broken the promise its header makes. So every
# drill sweeps first.
#
# Only tenants the drills could have made are swept: the name is 'Chaos
# Drill' and the slug starts with 'chaos-drill-'. Nothing else is touched.
#
# And only OLD ones. A sweep that ran while another drill was mid-flight
# would delete the other drill's fixture, so anything younger than two hours
# is left alone. A drill takes minutes; two hours is long enough that a
# live drill is never in danger, and short enough that debris does not
# linger.
#
# The sweep reports what it removed. A silent sweep would hide the fact that
# a drill had been killed.
drill_sweep_leftovers() {
  local stale_tenants stale_users
  stale_tenants="$(sql_scalar "select count(*) from public.tenants
                                 where name = 'Chaos Drill'
                                   and slug like 'chaos-drill-%'
                                   and created_at < now() - interval '2 hours'")"
  stale_users="$(sql_scalar "select count(*) from auth.users
                              where email like 'chaos-drill-%@chaos.invalid'
                                and created_at < now() - interval '2 hours'")"

  # The assertion is UNCONDITIONAL, and that is the point.
  #
  # Both branches assert the same invariant: no debris from an earlier, killed
  # drill survives into this one. The branch that had something to remove says
  # so; the branch that found nothing says that too. What it must NOT do is
  # stay silent, because a silent branch makes the drill's assertion COUNT
  # depend on the state the database happened to be in when the drill started
  # — 69 on a clean run, 70 on the run after a killed drill — and a number
  # that moves on its own is a number the handover cannot publish.
  #
  # So the count is the same on every run, and what the run proves is the
  # same on every run: the debris is gone.
  if [[ "${stale_tenants:-0}" -eq 0 && "${stale_users:-0}" -eq 0 ]]; then
    ok "there were no leftovers of earlier, killed drills"
    return 0
  fi

  note "sweeping $stale_tenants leftover drill tenant(s) and $stale_users leftover drill user(s)"

  if ! sql >/dev/null 2>"$DRILL_TMP/sweep.err" <<SQL
begin;

-- The stale drill tenants, NAMED ONCE.
--
-- Every delete below joins on this table. It used to spell the predicate out
-- again in each statement — sixteen copies of the same four lines — and the
-- copies drifted: two of them needed two closing parentheses (the
-- `vat_submission_id` selects nest a second `in (select ...)` inside the
-- first) and the other fourteen needed one, but all sixteen were written
-- with two. Postgres read the extra parenthesis as "syntax error at or near
-- ')'" and the whole sweep aborted.
--
-- The bug was LATENT, which is the worst way for it to be: the sweep only
-- reaches this SQL when there ARE leftovers, so it passed on every run where
-- the previous drill had cleaned up after itself — and then failed on
-- exactly the run it existed for, the one after a drill was killed. Every
-- drill that follows a killed drill died at the sweep, before testing
-- anything, and left its own debris behind for the next one.
--
-- One table, one predicate, and the parentheses are now the only thing left
-- to get right — and a nested `in (select ...)` is easy to count.
create temporary table stale_drill_tenants on commit drop as
  select id from public.tenants
   where name = 'Chaos Drill' and slug like 'chaos-drill-%'
     and created_at < now() - interval '2 hours';

delete from accounting.vat_return_lines
 where vat_submission_id in (select id from accounting.vat_submissions
   where tenant_id in (select id from stale_drill_tenants));
delete from accounting.filing_artifacts
 where vat_submission_id in (select id from accounting.vat_submissions
   where tenant_id in (select id from stale_drill_tenants));
delete from accounting.vat_submissions
 where tenant_id in (select id from stale_drill_tenants);

delete from accounting.journal_lines
 where journal_id in (select id from accounting.journal_entries
   where tenant_id in (select id from stale_drill_tenants));
delete from accounting.bank_transactions
 where tenant_id in (select id from stale_drill_tenants);
delete from accounting.journal_entries
 where tenant_id in (select id from stale_drill_tenants);
delete from accounting.bank_imports
 where tenant_id in (select id from stale_drill_tenants);
delete from accounting.tenant_accounting_settings
 where tenant_id in (select id from stale_drill_tenants);
delete from accounting.bank_accounts
 where tenant_id in (select id from stale_drill_tenants);
delete from accounting.periods
 where tenant_id in (select id from stale_drill_tenants);
delete from accounting.audit_log
 where tenant_id in (select id from stale_drill_tenants);
delete from accounting.firs_credentials
 where tenant_id in (select id from stale_drill_tenants);

delete from public.invoices
 where tenant_id in (select id from stale_drill_tenants);
delete from public.agreements
 where tenant_id in (select id from stale_drill_tenants);
delete from public.drivers
 where tenant_id in (select id from stale_drill_tenants);
delete from public.vehicles
 where tenant_id in (select id from stale_drill_tenants);
delete from public.tenant_memberships
 where tenant_id in (select id from stale_drill_tenants);

delete from public.tenants
 where name = 'Chaos Drill' and slug like 'chaos-drill-%'
   and created_at < now() - interval '2 hours';
delete from auth.users
 where email like 'chaos-drill-%@chaos.invalid'
   and created_at < now() - interval '2 hours';

commit;
SQL
  then
    echo "  · the drill could not sweep its earlier leftovers — the database refused:" >&2
    sed 's/^/    /' "$DRILL_TMP/sweep.err" >&2
    return 1
  fi

  ok "the leftovers of earlier, killed drills are gone"
  return 0
}

# The drill's way out.
#
# The drill's own rows MUST go. A drill that leaves its tenant, its periods
# and its journal entries in the customer's database has broken the promise
# its own header makes — and a drill that reports "passed" while doing that
# is worse than a drill that never ran, because it takes the debris with it
# and says everything is fine.
#
# So a cleanup that fails FAILS the drill, whatever the assertions said.
# The exit status is set here, in the EXIT trap, and it overrides the one
# the drill was heading for.
drill_cleanup() {
  local rc=0
  fixture_destroy || rc=1
  app_restore
  stub_stop
  rm -rf "$DRILL_TMP"
  if [[ "$rc" -ne 0 ]]; then
    echo "FAIL: the drill left data behind. It does not count as a pass." >&2
    exit 1
  fi
}

# ── the session ─────────────────────────────────────────────────────────────

# A signed session token for one user of the drill's tenant, on stdout.
#
# Minted with the application's OWN signer — the same one PostgREST verifies.
# A token hand-rolled here would be a different kind of credential, and a
# drill that authenticates by a different path than the product does is not
# testing the product.
#
# THE SECRET GOES IN THE ENVIRONMENT, NOT IN THE ARGUMENTS.
#
# On the deployed box, DRILL_JWT_SECRET is the deployment's REAL signing
# secret — read out of /etc/brownhill/secrets/ — and a token minted with it
# is a session for any user in any tenant. A command line is the wrong place
# for it: /proc/<pid>/cmdline is world-readable on Linux, so any account on
# the box could read the argument out of the process list while the drill
# was running. /proc/<pid>/environ is readable only by the process's own
# user and by root, so the environment is where a secret belongs.
mint_token_for() {
  local subject="$1" token
  token="$(MINT_JWT_SECRET="$DRILL_JWT_SECRET" "$DRILL_NODE" \
    "$DRILL_REPO/hosted/tests/auth/mint-test-jwt.mjs" \
    "$DRILL_TENANT_ID" "$subject" 2>"$DRILL_TMP/mint.err")" || {
    cat "$DRILL_TMP/mint.err" >&2
    fail "could not mint a session token"
  }
  [[ -n "$token" ]] || fail "the minter produced an empty token"
  echo "$token"
}

mint_session() {
  DRILL_SESSION="$(mint_token_for "$DRILL_USER_ID")"
  ok "a session was minted with the application's own signer"
}

# ── HTTP ────────────────────────────────────────────────────────────────────

DRILL_HTTP_STATUS=""
DRILL_HTTP_LOCATION=""
DRILL_HTTP_BODY=""

# drill_http <method> <url> [extra curl args...]
#
# The answer lands in DRILL_HTTP_STATUS, DRILL_HTTP_LOCATION and
# DRILL_HTTP_BODY. `drill_http_as` is the same thing with a name, so two
# requests can be in flight at once without overwriting each other's
# answers — which is what the concurrent-close drill needs.
drill_http() {
  local method="$1" url="$2"
  shift 2
  DRILL_HTTP_STATUS="$(drill_http_as http "$method" "$url" "$@")"
  DRILL_HTTP_LOCATION="$(tr -d '\r' <"$DRILL_TMP/http-head" \
    | sed -n 's/^[Ll]ocation:[[:space:]]*//p' | head -1)"
  DRILL_HTTP_BODY="$(cat "$DRILL_TMP/http-body" 2>/dev/null || true)"
}

# drill_http_as <prefix> <method> <url> [extra curl args...]
# The status code goes to stdout; the headers and the body to files.
drill_http_as() {
  local prefix="$1" method="$2" url="$3"
  shift 3
  local head="$DRILL_TMP/$prefix-head" body="$DRILL_TMP/$prefix-body"
  local status
  status="$(curl -sS -k -o "$body" -D "$head" -w '%{http_code}' \
    -X "$method" "$@" "$url")" || status="000"
  echo "$status"
}

# The address of a route.
#
# A full URL is left exactly as it is. The application's own routes are
# relative to the application's address, but the OAuth callback comes back
# from the stub as a full URL — and prepending the base to a full URL gives
# curl `http://127.0.0.1:55431http://127.0.0.1:55431/...`, which it rejects
# with "port number was not a decimal number" rather than a status code. That
# is how the callback round trip broke: the drill was told the application
# answered 000, which said nothing about the application.
app_url() {
  case "$1" in
    http://*|https://*) printf '%s' "$1" ;;
    *) printf '%s%s' "$DRILL_APP_URL" "$1" ;;
  esac
}

# The application's own answer, with the session cookie attached.
drill_app() {
  local method="$1" url="$2"
  shift 2
  drill_http "$method" "$(app_url "$url")" \
    -H "Cookie: bf_session=$DRILL_SESSION" "$@"
}

# drill_app_as <prefix> <session> <method> <url> [extra curl args...]
# The same, with a named answer and a named session.
drill_app_as() {
  local prefix="$1" session="$2" method="$3" url="$4"
  shift 4
  drill_http_as "$prefix" "$method" "$(app_url "$url")" \
    -H "Cookie: bf_session=$session" "$@"
}

# The body of a named request, read back from the file it wrote.
drill_as_body() { cat "$DRILL_TMP/$1-body" 2>/dev/null || true; }

# ── the OAuth round trip ────────────────────────────────────────────────────

# Connect the tenant to the stub HMRC, through the application's own route.
#
# The drill does not shortcut this by writing a credential row: the whole
# point is that the application's own OAuth path — the authorize URL, the
# signed state, the code exchange, the token storage — works. A drill that
# wrote the row itself would pass even if every bit of that were broken.
connect_hmrc() {
  drill_app GET "/api/v1/accounting/mtd/connect"
  if [[ "$DRILL_HTTP_STATUS" != "303" && "$DRILL_HTTP_STATUS" != "302" ]]; then
    fail "the application's connect route answered $DRILL_HTTP_STATUS, not a redirect: $DRILL_HTTP_BODY"
  fi
  local authorize="$DRILL_HTTP_LOCATION"
  [[ -n "$authorize" ]] || fail "the connect route redirected nowhere"

  # The application's address for the stub is the one the application can
  # reach; the drill's is the one the drill can reach. They are the same
  # service, so the drill swaps the prefix rather than the whole URL.
  #
  # On the box the two addresses are the same — the stub runs on the same
  # host as the application — so there is nothing to swap, and requiring the
  # swap to have happened would refuse a drill that was pointing at the stub
  # perfectly well.
  local drill_authorize="$authorize"
  if [[ "$DRILL_STUB_URL_FOR_APP" != "$DRILL_STUB_URL" ]]; then
    drill_authorize="${authorize/$DRILL_STUB_URL_FOR_APP/$DRILL_STUB_URL}"
    [[ "$drill_authorize" != "$authorize" ]] || \
      fail "the connect route did not point at the stub ($authorize)"
  fi

  drill_http GET "$drill_authorize"
  if [[ "$DRILL_HTTP_STATUS" != "302" && "$DRILL_HTTP_STATUS" != "303" ]]; then
    fail "the stub's authorize endpoint answered $DRILL_HTTP_STATUS, not a redirect"
  fi
  local callback="$DRILL_HTTP_LOCATION"
  [[ -n "$callback" ]] || fail "the stub redirected nowhere"

  drill_app GET "$callback"
  if [[ "$DRILL_HTTP_STATUS" != "303" && "$DRILL_HTTP_STATUS" != "302" ]]; then
    fail "the application's callback route answered $DRILL_HTTP_STATUS: $DRILL_HTTP_BODY"
  fi
  case "$DRILL_HTTP_LOCATION" in
    *status=connected*) ok "the HMRC connection was made through the application's own OAuth route" ;;
    *) fail "the callback did not report a connection: ${DRILL_HTTP_LOCATION:-no redirect}" ;;
  esac
}

# Set the tenant's VAT registration number, through the form the operator
# uses.
set_vrn() {
  drill_app POST "/api/v1/accounting/mtd/vrn" \
    --data-urlencode "vrn=$DRILL_VRN" \
    --data-urlencode "returnTo=/accounts/accounting/mtd"
  if [[ "$DRILL_HTTP_LOCATION" != *"status=vrn-set"* ]]; then
    fail "the VRN was not saved: ${DRILL_HTTP_LOCATION:-no redirect} $DRILL_HTTP_BODY"
  fi
  ok "the tenant's VAT registration number ($DRILL_VRN) was saved"
}

# File a return. The answer is in DRILL_HTTP_STATUS and DRILL_HTTP_BODY.
submit_return() {
  drill_app POST "/api/v1/accounting/mtd/submit?period=$DRILL_PERIOD"
}

# ── the database assertions ─────────────────────────────────────────────────

# The submission row, as one line: status|posted_journal_id|response_payload.
submission_row() {
  sql_scalar "select status || '|' || coalesce(posted_journal_id::text, 'NULL') || '|' ||
                     coalesce(response_payload::text, 'NULL')
                from accounting.vat_submissions
               where tenant_id = '$DRILL_TENANT_ID'"
}

# How many VAT-submission journal entries the tenant has.
vat_journal_count() {
  sql_scalar "select count(*) from accounting.journal_entries
               where tenant_id = '$DRILL_TENANT_ID'
                 and source_type = 'vat_submission'"
}

# How many there are for ONE period.
vat_journal_count_for() {
  local period="$1"
  sql_scalar "select count(*)
                from accounting.journal_entries e
                join accounting.periods p on p.id = e.period_id
               where e.tenant_id = '$DRILL_TENANT_ID'
                 and e.source_type = 'vat_submission'
                 and p.year = ${period%%-*} and p.month = ${period##*-}"
}

# The VAT the drill's invoice produced, as recorded in the submission.
#
# The payload carries HMRC's own names, in pounds: `netVatDue` is HMRC's box
# 7. A non-zero figure is what proves the ledger HAD a posting to make — so
# "no journal entry was posted" is a fact about the refusal, and not an
# accident of an empty period.
submission_net_vat() {
  sql_scalar "select coalesce((return_payload->>'netVatDue'), '0')
                from accounting.vat_submissions
               where tenant_id = '$DRILL_TENANT_ID'"
}

# The submission row for ONE period, as status|posted_journal_id|payload.
submission_row_for() {
  local period="$1"
  sql_scalar "select status || '|' || coalesce(posted_journal_id::text, 'NULL') || '|' ||
                     coalesce(response_payload::text, 'NULL')
                from accounting.vat_submissions s
                join accounting.periods p on p.id = s.period_id
               where s.tenant_id = '$DRILL_TENANT_ID'
                 and p.year = ${period%%-*} and p.month = ${period##*-}"
}

# What HMRC said, as kept on the submission row.
submission_response_body() {
  local period="$1"
  sql_scalar "select coalesce(s.response_payload->>'responseBody', '')
                from accounting.vat_submissions s
                join accounting.periods p on p.id = s.period_id
               where s.tenant_id = '$DRILL_TENANT_ID'
                 and p.year = ${period%%-*} and p.month = ${period##*-}"
}

# ── the period close ──────────────────────────────────────────────────────

# Is the period open, closed or locked?
period_state() {
  local period="$1"
  sql_scalar "select case
                        when locked_at is not null then 'locked'
                        when closed_at is not null then 'closed'
                        else 'open'
                      end
                from accounting.periods
               where tenant_id = '$DRILL_TENANT_ID'
                 and year = ${period%%-*} and month = ${period##*-}"
}

# Who closed the period, and when.
period_closer() {
  local period="$1"
  sql_scalar "select coalesce(closed_by_user_id::text, 'NULL')
                from accounting.periods
               where tenant_id = '$DRILL_TENANT_ID'
                 and year = ${period%%-*} and month = ${period##*-}"
}

# How many journal entries the tenant has in one period. Any source type —
# a drill that wants to know whether a posting happened does not care which
# kind of posting it was.
journal_count_for() {
  local period="$1"
  sql_scalar "select count(*)
                from accounting.journal_entries e
                join accounting.periods p on p.id = e.period_id
               where e.tenant_id = '$DRILL_TENANT_ID'
                 and p.year = ${period%%-*} and p.month = ${period##*-}"
}

# Is the drill's bank line still waiting to be categorised?
bank_tx_status() {
  sql_scalar "select status::text from accounting.bank_transactions
               where id = '$DRILL_BANK_TX_ID'"
}

# ── reading the close preflight ───────────────────────────────────────────
#
# The preflight comes back as JSON, and the box has no `jq`. These two
# helpers read it with `sed`, which is everywhere.
#
# Why not have the drill hard-code the figures it expects to acknowledge?
# Because then the drill would be asserting its own arithmetic rather than
# the product's. The acknowledgement the operator sends is BUILT FROM the
# preflight the operator was shown — that is the whole contract — so the
# drill does the same thing the dialog does.

# One warning's figures, as "count amountPence". Empty when the warning is
# not there.
#
# The line is read out of the JSON by splitting on `{` and picking the piece
# that names the code. The keys come out in the order the product writes
# them — `code`, `count`, `amountPence`, `message` — because that is the
# order the warning object is built in.
preflight_warning_figures() {
  local body="$1" code="$2"
  printf '%s' "$body" \
    | tr '{' '\n' \
    | grep -F "\"code\":\"$code\"," \
    | head -1 \
    | sed -n 's/.*"count":[[:space:]]*\([0-9][0-9]*\).*"amountPence":[[:space:]]*\([0-9][0-9]*\).*/\1 \2/p'
}

# Every warning in the preflight, as the acknowledgement array the confirm
# request carries: [{"code":"…","count":N,"amountPence":M}, …]
#
# This is what the dialog builds. The drill builds it the same way, from the
# same body, so the confirm step proves the product accepts a real operator's
# acknowledgement — and drill 06 proves separately that a WRONG one is
# refused.
preflight_acknowledgements() {
  local body="$1"
  local matches
  matches="$(printf '%s' "$body" \
    | tr '{' '\n' \
    | grep -o '"code":"[a-z_]*","count":[0-9][0-9]*,"amountPence":[0-9][0-9]*')"
  local out="" part
  while IFS= read -r part; do
    [[ -n "$part" ]] || continue
    if [[ -z "$out" ]]; then out="{$part}"; else out="$out,{$part}"; fi
  done <<< "$matches"
  echo "[$out]"
}
