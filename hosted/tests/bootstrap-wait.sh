#!/usr/bin/env bash
# hosted/tests/bootstrap-wait.sh — the CI step that waits for the stack's
# bootstrap has to be able to SEE the bootstrap.
#
# WHY THIS TEST EXISTS
# --------------------
# The bootstrap service in hosted/dev/docker-compose.yml is a oneshot: it
# applies the shim, every migration and the app_state table, then exits.
# The hosted-smoke workflow waited for it like this:
#
#   cid=$(docker compose ps -q bootstrap)
#   state=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo missing)
#
# `docker compose ps` lists only the project's RUNNING containers. A oneshot
# that has exited is not among them. The command returns an empty string,
# `docker inspect` then fails on an empty object id, and the step concludes
# that the bootstrap "did not finish in time" — after it had in fact applied
# all 81 migrations and exited cleanly.
#
# That is not a hypothesis. It is what happened on 2026-10-31, on the first
# run this job ever reached a runner: the run failed with the bootstrap's
# own successful output ("==> applied 81 migrations") sitting in the log
# beside the failure. The step was blind to a bootstrap that had succeeded,
# and its teardown killed it.
#
# So this gate proves five things:
#
#   1. The defect is REAL: `docker compose ps -q <service>` cannot see a
#      container that has exited. If this stops being true the bug cannot
#      come back, and the gate says so rather than going quiet.
#   2. The wait script sees an ALREADY-EXITED bootstrap and reports success.
#      This is the exact CI scenario: the container finished before the step
#      looked for it.
#   3. The wait script reports a FAILED bootstrap, with the service's own
#      log, so the reason is in front of the operator and not in a container
#      they have to go and find.
#   4. The wait script waits for a bootstrap that is STILL RUNNING and
#      reports its exit code when it finishes.
#   5. The workflow calls the script, and the blind `ps -q` lookup is gone
#      from it.
#
# It is a real gate: it builds a real compose project with a real oneshot
# and runs the real script against it.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

WAITER="$REPO/hosted/scripts/wait-for-bootstrap.sh"
WORKFLOW="$REPO/.github/workflows/hosted-smoke.yml"

# ── a throwaway compose project ────────────────────────────────────────────

WORK="$(mktemp -d)"
PROJECT="bwprobe"

# Docker's CLI on Windows is a Windows program: it cannot open a Git Bash
# /tmp/... path. `pwd -W` prints the path it understands.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) WORK_NATIVE="$(cd "$WORK" && pwd -W)" ;;
  *) WORK_NATIVE="$WORK" ;;
esac
COMPOSE="$WORK_NATIVE/compose.yml"

cleanup() {
  docker compose -f "$COMPOSE" -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Writes a compose project whose `bootstrap` service runs the given shell command,
# and brings it up. The oneshot is expected to exit on its own.
#
# $1 the command; $2 "nowait" to return while the oneshot is still running.
bring_up() {
  local command="$1" mode="${2:-wait}"
  cat > "$WORK/compose.yml" <<YAML
services:
  bootstrap:
    image: postgres:16
    entrypoint: ["/bin/sh", "-c", "$command"]
YAML
  if [ "$mode" = "nowait" ]; then
    docker compose -f "$COMPOSE" -p "$PROJECT" up -d >/dev/null 2>&1 || true
  else
    docker compose -f "$COMPOSE" -p "$PROJECT" up -d --wait >/dev/null 2>&1 || true
  fi
}

# ── 1: the defect is real ─────────────────────────────────────────────────

echo "== 1: a compose oneshot that has exited is invisible to 'ps -q' =="
bring_up "exit 0"
sleep 1

blind=$(docker compose -f "$COMPOSE" -p "$PROJECT" ps -q bootstrap)
if [ -z "$blind" ]; then
  ok "docker compose ps -q bootstrap returns nothing for a container that has exited"
else
  bad "docker compose ps -q bootstrap returned '$blind' — the defect this gate guards against is gone, and the workflow's blind lookup would no longer be blind (update the gate)"
fi

seen=$(docker compose -f "$COMPOSE" -p "$PROJECT" ps -q --all bootstrap)
if [ -n "$seen" ]; then
  ok "docker compose ps -q --all bootstrap finds it"
else
  bad "docker compose ps -q --all bootstrap found nothing"
fi

# ── 2: the script sees an already-exited bootstrap ────────────────────────

echo "== 2: the wait script sees a bootstrap that finished before it looked =="
if [ ! -x "$WAITER" ]; then
  bad "hosted/scripts/wait-for-bootstrap.sh is missing or is not executable"
else
  out=$("$WAITER" --compose-file "$COMPOSE" --project-name "$PROJECT" --timeout 30 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "the wait script exited 0 for a bootstrap that exited 0"
  else
    bad "the wait script exited $rc for a bootstrap that exited 0"
    echo "$out" | sed 's/^/       /'
  fi
  if echo "$out" | grep -q 'finished cleanly'; then
    ok "it says the bootstrap finished cleanly"
  else
    bad "it did not say the bootstrap finished cleanly"
    echo "$out" | sed 's/^/       /'
  fi
fi

# ── 3: a failed bootstrap is reported, with its log ───────────────────────

echo "== 3: a failed bootstrap is reported, with the service's own log =="
bring_up "echo 'the migration blew up' >&2; exit 3"
sleep 1

if [ -x "$WAITER" ]; then
  out=$("$WAITER" --compose-file "$COMPOSE" --project-name "$PROJECT" --timeout 30 2>&1) && rc=0 || rc=$?
  if [ "$rc" -ne 0 ]; then
    ok "the wait script exits non-zero for a bootstrap that exited 3"
  else
    bad "the wait script exited 0 for a bootstrap that exited 3"
  fi
  if echo "$out" | grep -q 'the migration blew up'; then
    ok "the bootstrap's own log is in the output"
  else
    bad "the bootstrap's log was not dumped"
    echo "$out" | sed 's/^/       /'
  fi
  if echo "$out" | grep -qi 'exit 3\|exited 3'; then
    ok "the output names the exit code"
  else
    bad "the output does not name the exit code"
    echo "$out" | sed 's/^/       /'
  fi
fi

# ── 4: a bootstrap that is still running is waited for ────────────────────

echo "== 4: a bootstrap that is still running is waited for =="
bring_up "sleep 4; exit 0" nowait

if [ -x "$WAITER" ]; then
  started=$(date +%s)
  out=$("$WAITER" --compose-file "$COMPOSE" --project-name "$PROJECT" --timeout 30 2>&1) && rc=0 || rc=$?
  elapsed=$(( $(date +%s) - started ))
  if [ "$rc" -eq 0 ]; then
    ok "the wait script exited 0 for a bootstrap that finished while it waited"
  else
    bad "the wait script exited $rc for a bootstrap that finished while it waited"
    echo "$out" | sed 's/^/       /'
  fi
  if [ "$elapsed" -ge 3 ]; then
    ok "it waited for the bootstrap rather than declaring success at once ($elapsed s)"
  else
    bad "it returned after $elapsed s — it did not actually wait"
  fi
fi

# ── 5: the workflow uses the script ────────────────────────────────────────

echo "== 5: the workflow calls the script, and the blind lookup is gone =="
if grep -q 'wait-for-bootstrap.sh' "$WORKFLOW"; then
  ok "the workflow calls hosted/scripts/wait-for-bootstrap.sh"
else
  bad "the workflow does not call hosted/scripts/wait-for-bootstrap.sh"
fi

if grep -nE 'ps -q bootstrap' "$WORKFLOW" | grep -v -- '--all' | grep -q .; then
  bad "the workflow still looks the bootstrap up with a blind 'ps -q bootstrap'"
  grep -nE 'ps -q bootstrap' "$WORKFLOW" | sed 's/^/       /'
else
  ok "the workflow has no blind 'ps -q bootstrap' lookup"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "Result: $PASS passed, 0 failed"
  exit 0
fi
echo "Result: $PASS passed, $FAIL failed"
exit 1
