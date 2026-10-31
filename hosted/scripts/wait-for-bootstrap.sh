#!/usr/bin/env bash
# hosted/scripts/wait-for-bootstrap.sh — wait for the stack's bootstrap
# oneshot to finish, and report what it did.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# The bootstrap service in hosted/dev/docker-compose.yml is a oneshot: it
# applies the shim, every migration and the app_state table, then exits. A
# CI step that wants to REPORT on it has to be able to find it — and the
# obvious way to find it does not work:
#
#   cid=$(docker compose ps -q bootstrap)
#
# `docker compose ps` lists only the project's RUNNING containers. A oneshot
# that has exited is not among them. The command returns an empty string,
# `docker inspect` then fails on an empty object id, and the step concludes
# that the bootstrap "did not finish in time" — after it had in fact applied
# all 81 migrations and exited cleanly.
#
# That is not a hypothesis. It is what happened on 2026-10-31, on the first
# run the hosted-smoke job ever reached a runner: the job failed with the
# bootstrap's own successful output ("==> applied 81 migrations") sitting in
# the log beside the failure.
#
# The fix is one flag — `--all`, which asks compose for the project's
# stopped containers as well as its running ones — and then a wait that is
# bounded by the container's own exit rather than by a guessed number of
# seconds.
#
# USAGE
#   wait-for-bootstrap.sh --compose-file <path>
#                          [--project-name <name>]
#                          [--service <name>]
#                          [--timeout <seconds>]
#
# EXIT STATUS
#   0  the bootstrap container exited 0
#   1  it exited non-zero, or it never appeared, or it did not finish in time
#   2  the arguments were wrong

set -euo pipefail
export LC_ALL=C

COMPOSE_FILE=""
PROJECT=""
SERVICE="bootstrap"
TIMEOUT=900

usage() {
  sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --compose-file) COMPOSE_FILE="${2:-}"; shift 2 ;;
    --project-name) PROJECT="${2:-}"; shift 2 ;;
    --service)      SERVICE="${2:-}"; shift 2 ;;
    --timeout)      TIMEOUT="${2:-}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "wait-for-bootstrap.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$COMPOSE_FILE" ]; then
  echo "wait-for-bootstrap.sh: --compose-file is required" >&2
  usage >&2
  exit 2
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "wait-for-bootstrap.sh: no such compose file: $COMPOSE_FILE" >&2
  exit 2
fi
if ! [ "$TIMEOUT" -gt 0 ] 2>/dev/null; then
  echo "wait-for-bootstrap.sh: --timeout must be a positive number of seconds" >&2
  exit 2
fi

# The compose file path is used EXACTLY as it was given, and is not
# rewritten to an absolute path. On a Windows host the Docker CLI is a
# Windows program: it opens `C:/Users/.../compose.yml` and cannot open the
# MSYS spelling of the same path, and rewriting it here would hand it
# something it cannot read. The caller passes a path the CLI can open.
if ! command -v timeout >/dev/null 2>&1; then
  echo "wait-for-bootstrap.sh: 'timeout' is not on PATH, and this script needs it as a backstop" >&2
  exit 2
fi

compose() {
  if [ -n "$PROJECT" ]; then
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

deadline=$(( $(date +%s) + TIMEOUT ))

# The container's id — the one compose considers current.
#
# `--all` is the whole point of this script: without it, compose hides the
# containers that have exited, and a bootstrap that has already finished is
# exactly what we are looking for. If the project somehow has more than one
# container for the service, the most recently started one is the live one;
# compose removes the previous container when it recreates a service, so
# there is normally exactly one.
latest_cid() {
  local ids id started best="" best_started=""
  ids="$(compose ps -q --all "$SERVICE" 2>/dev/null || true)"
  for id in $ids; do
    started="$(docker inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null || true)"
    [ -n "$started" ] || continue
    if [ -z "$best_started" ] || [ "$started" \> "$best_started" ]; then
      best="$id"
      best_started="$started"
    fi
  done
  printf '%s' "$best"
}

# ── find the container ─────────────────────────────────────────────────────

cid=""
while :; do
  cid="$(latest_cid)"
  [ -n "$cid" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "the bootstrap container was never created" >&2
    compose logs "$SERVICE" 2>&1 || true
    exit 1
  fi
  sleep 2
done

# ── wait for it to stop ────────────────────────────────────────────────────

# `docker wait` blocks until the container stops and then prints its exit
# code — so the wait is as long as the bootstrap takes, and no longer. The
# timeout is a backstop for a bootstrap that hangs: without it a hung
# oneshot would hold the CI job until the job's own ceiling killed it.
remaining=$(( deadline - $(date +%s) ))
if [ "$remaining" -lt 1 ]; then remaining=1; fi

set +e
code="$(timeout "$remaining" docker wait "$cid" 2>/dev/null)"
rc=$?
set -e

if [ "$rc" -eq 124 ] || [ -z "$code" ]; then
  echo "the bootstrap did not finish within ${TIMEOUT}s" >&2
  compose logs "$SERVICE" 2>&1 || true
  exit 1
fi

if [ "$code" != "0" ]; then
  echo "the bootstrap failed (exit $code)" >&2
  compose logs "$SERVICE" 2>&1 || true
  exit 1
fi

echo "the bootstrap finished cleanly"
exit 0
