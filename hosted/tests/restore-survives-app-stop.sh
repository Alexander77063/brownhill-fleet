#!/usr/bin/env bash
# hosted/tests/restore-survives-app-stop.sh
#
# The restore console replays a dump onto the live database, and to do that it
# STOPS THE APPLICATION first: the application holds connections to the
# database being replaced, and a logical restore with --clean drops and
# recreates the objects underneath it.
#
# Stopping the application is what killed the restore.
#
# The restore script is a child of the application process, so it starts
# INSIDE brownhill-next.service's control group — and systemd stops a unit by
# signalling that whole control group. So the line
#
#     systemctl stop brownhill-next.service
#
# signalled the restore as well as the application. The restore died half way
# through a pg_restore, with the database dismantled and nothing serving. The
# operator's button did not restore anything; it took the box down.
#
# This gate runs the REAL hosted/bootstrap/restore.sh inside a container and
# proves the property that matters: the restore COMPLETES even though the
# application's service was stopped in the middle of it.
#
# How the container models systemd
# ────────────────────────────────
#
#   * the application's control group is a process group, and the harness
#     records its id in /tmp/state/app-pgid;
#   * the stub `systemctl stop brownhill-next.service` signals that whole
#     group, which is what systemd does to a unit's control group — and it
#     signals the APPLICATION's group, not the caller's, because that is the
#     group systemd would be stopping;
#   * the stub `systemd-run` models a transient unit: it starts the command
#     in a SESSION OF ITS OWN (setsid), waits for it, and exits with its
#     status. A unit has a control group of its own, so the application's
#     stop cannot reach it.
#
# The first version of this gate was written against a restore script that
# stopped the application from inside the application's own control group,
# and it failed — which is the point of writing it.
#
# It skips gracefully when docker is absent; that env is for dev hosts
# without docker.
set -uo pipefail

# Git Bash on Windows rewrites a container path like /tmp/state into a
# Windows path before it reaches docker. Turning the rewriting off is a
# no-op on Linux, where CI runs this script.
export MSYS_NO_PATHCONV=1

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not present; skipping restore-survives-app-stop"
  exit 0
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The docker daemon on Windows is a Linux VM: it cannot mount a Git Bash
# /c/Users/... path. `pwd -W` prints the path the daemon understands.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) REPO_MOUNT="$(cd "$REPO" && pwd -W)" ;;
  *) REPO_MOUNT="$REPO" ;;
esac

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

BACKUP_ID="2026-09-23T02-00-01Z"

# Runs one scenario in a container and prints the state as key=value lines.
#
#   $1 — pg_restore's behaviour: "ok" or "fail"
run_scenario() {
  local mode="$1"
  docker run --rm -i \
    -e "PG_RESTORE_MODE=$mode" \
    -e "BACKUP_ID=$BACKUP_ID" \
    -v "$REPO_MOUNT:/repo:ro" \
    ubuntu:24.04 \
    bash -s <<'CONTAINER'
set -uo pipefail
export PATH=/usr/local/bin:$PATH

mkdir -p /usr/local/bin /opt/brownhill/pgsql/bin /var/backups/brownhill \
         /var/lib/brownhill /tmp/state

# The REAL script, at the path the sudoers rule names.
install -m 0750 /repo/hosted/bootstrap/restore.sh /usr/local/bin/restore.sh

printf 'this is not a real dump, but it is a file' > "/var/backups/brownhill/$BACKUP_ID.dump"

# ── systemctl ──────────────────────────────────────────────────────────────
cat > /usr/local/bin/systemctl <<'EOF'
#!/usr/bin/env bash
# Ignore the signal systemd would send to the processes in the unit's
# control group — this stub is not one of them.
trap '' TERM
echo "systemctl $*" >> /tmp/state/systemctl.log
case "${1:-}" in
  stop)
    if [[ "${2:-}" == "brownhill-next.service" ]]; then
      echo stopped >> /tmp/state/app-stopped
      # systemd stops a unit by signalling its WHOLE control group. The
      # application's group is the one the restore was started from.
      pgid="$(cat /tmp/state/app-pgid 2>/dev/null || true)"
      if [[ -n "$pgid" ]]; then
        kill -TERM -- -"$pgid" 2>/dev/null || true
      fi
    fi
    ;;
  start)
    if [[ "${2:-}" == "brownhill-next.service" ]]; then
      echo started >> /tmp/state/app-started
    fi
    ;;
esac
exit 0
EOF

# ── systemd-run ────────────────────────────────────────────────────────────
cat > /usr/local/bin/systemd-run <<'EOF'
#!/usr/bin/env bash
# A transient unit: systemd starts the command in a control group of its own,
# waits for it, and systemd-run exits with its status.
echo "systemd-run $*" >> /tmp/state/systemd-run.log
cmd=()
env_args=()
for arg in "$@"; do
  case "$arg" in
    --unit=*|--collect|--wait) ;;
    --setenv=*) env_args+=("${arg#--setenv=}") ;;
    --) ;;
    *) cmd+=("$arg") ;;
  esac
done
if [[ ${#cmd[@]} -eq 0 ]]; then
  echo "systemd-run: no command given" >&2
  exit 1
fi
# The unit's environment is set by systemd, not inherited by chance.
for pair in ${env_args[@]+"${env_args[@]}"}; do
  export "${pair?}"
done
# setsid gives the command a session of its own, which is what puts it
# outside the caller's control group.
setsid "${cmd[@]}" &
child=$!
wait "$child"
exit $?
EOF

# ── runuser ────────────────────────────────────────────────────────────────
cat > /usr/local/bin/runuser <<'EOF'
#!/usr/bin/env bash
# runuser -u postgres -- cmd args...
if [[ "${1:-}" == "-u" && "${2:-}" == "postgres" && "${3:-}" == "--" ]]; then
  shift 3
fi
exec "$@"
EOF

# ── pg_restore ─────────────────────────────────────────────────────────────
cat > /opt/brownhill/pgsql/bin/pg_restore <<'EOF'
#!/usr/bin/env bash
echo "pg_restore $*" >> /tmp/state/pg-restore.log
if [[ "${1:-}" == "--list" ]]; then
  # The table of contents: a readable archive.
  echo "1; 1259 16385 TABLE public vehicles postgres"
  exit 0
fi
echo replayed >> /tmp/state/pg-restore-ran
if [[ "${PG_RESTORE_MODE:-ok}" == "fail" ]]; then
  echo "pg_restore: error: could not restore file vehicles" >&2
  exit 1
fi
exit 0
EOF

# ── psql ───────────────────────────────────────────────────────────────────
cat > /opt/brownhill/pgsql/bin/psql <<'EOF'
#!/usr/bin/env bash
echo "psql $*" >> /tmp/state/psql.log
for last; do :; done
printf '%s\n' "$last" >> /tmp/state/psql-statements.log
exit 0
EOF

chmod 0755 /usr/local/bin/systemctl /usr/local/bin/systemd-run /usr/local/bin/runuser \
           /opt/brownhill/pgsql/bin/pg_restore /opt/brownhill/pgsql/bin/psql

# ── the run ────────────────────────────────────────────────────────────────
#
# The restore is started from the application's own process group, and the
# group id is recorded — that group is the application service's control
# group, and it is what `systemctl stop` signals.
setsid bash -c 'echo $$ > /tmp/state/app-pgid; exec /usr/local/bin/restore.sh "$BACKUP_ID"' &
runner=$!

# In the broken version the restore dies with the application, so the
# runner's exit code says nothing useful. The record is what matters.
wait "$runner" 2>/dev/null || true

for _ in $(seq 1 60); do
  [[ -f /var/lib/brownhill/restore-last.json ]] && break
  sleep 0.1
done

# ── the state, as key=value lines ──────────────────────────────────────────
state() { [[ -f "/tmp/state/$1" ]] && echo 1 || echo 0; }
echo "app-stopped=$(state app-stopped)"
echo "app-started=$(state app-started)"
echo "pg-restore-ran=$(state pg-restore-ran)"
echo "drain-cleared=$(grep -c "app_draining', '0'" /tmp/state/psql-statements.log 2>/dev/null || echo 0)"
echo "drain-kept=$(grep -c "app_draining', '1'" /tmp/state/psql-statements.log 2>/dev/null || echo 0)"
echo "record-state=$(sed -n 's/.*"state"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /var/lib/brownhill/restore-last.json 2>/dev/null | head -1)"
echo "record-exitcode=$(sed -n 's/.*"exitCode"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' /var/lib/brownhill/restore-last.json 2>/dev/null | head -1)"
CONTAINER
}

val() { # val <output> <key>
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1
}

# ── 1: a good dump restores, and the application comes back ────────────────

echo "== 1: the restore survives the application being stopped =="

out="$(run_scenario ok)"

if [[ "$(val "$out" pg-restore-ran)" == "1" ]]; then
  ok "the dump was replayed — the restore was not killed by the stop"
else
  bad "the dump was NEVER replayed — the restore was killed by the application's stop"
  echo "$out" | sed 's/^/        /'
fi

if [[ "$(val "$out" app-stopped)" == "1" ]]; then
  ok "the application was stopped before the replay"
else
  bad "the application was never stopped"
fi

if [[ "$(val "$out" app-started)" == "1" ]]; then
  ok "the application was started again after the replay"
else
  bad "the application was not started again after the replay"
fi

if [[ "$(val "$out" drain-cleared)" == "1" ]]; then
  ok "the drain was released — the application is not left closed"
else
  bad "the drain was NOT released after a successful restore"
fi

if [[ "$(val "$out" record-state)" == "succeeded" ]]; then
  ok "the outcome was recorded as succeeded"
else
  bad "the outcome was not recorded as succeeded (got '$(val "$out" record-state)')"
fi

if [[ "$(val "$out" record-exitcode)" == "0" ]]; then
  ok "the record carries exit code 0"
else
  bad "the record does not carry exit code 0 (got '$(val "$out" record-exitcode)')"
fi

# ── 2: a replay that fails leaves the application down ─────────────────────

echo
echo "== 2: a replay that fails leaves the application stopped =="

out="$(run_scenario fail)"

if [[ "$(val "$out" app-stopped)" == "1" ]]; then
  ok "the application was stopped before the replay"
else
  bad "the application was never stopped"
fi

if [[ "$(val "$out" app-started)" == "0" ]]; then
  ok "the application was NOT started again — a half-restored database is not served"
else
  bad "the application was started again after a failed replay"
fi

if [[ "$(val "$out" drain-cleared)" == "0" ]]; then
  ok "the drain was NOT released after a failed replay"
else
  bad "the drain was released after a failed replay"
fi

if [[ "$(val "$out" record-state)" == "failed" ]]; then
  ok "the outcome was recorded as failed"
else
  bad "the outcome was not recorded as failed (got '$(val "$out" record-state)')"
fi

if [[ "$(val "$out" record-exitcode)" == "4" ]]; then
  ok "the record carries exit code 4"
else
  bad "the record does not carry exit code 4 (got '$(val "$out" record-exitcode)')"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
