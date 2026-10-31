#! /usr/bin/env bash
# /usr/local/bin/restore.sh — installed by hosted/bootstrap/install.sh.
#
# Restores a dump onto the live cluster.
#
# It runs as root, because it stops and starts the application and the data
# API around the restore. The restore console (src/app/api/admin/restore/route.ts)
# invokes it through a single narrow sudoers rule; the rule allows only this
# script, and this script accepts only a well-formed backup id.
#
# ── two things this script has to get right ───────────────────────────────
#
# Both of them used to be wrong, and both of them made the operator's button
# take the box down instead of bringing it back.
#
# 1. IT MUST SURVIVE THE APPLICATION BEING STOPPED.
#
#    This script is a child of the application process, so it starts INSIDE
#    brownhill-next.service's control group — and systemd stops a unit by
#    signalling that whole control group. So `systemctl stop
#    brownhill-next.service`, further down, used to kill the restore itself:
#    half way through a pg_restore, with the database dismantled and nothing
#    serving. The operator's button did not restore anything.
#
#    The script now hands itself to a transient unit of its own BEFORE it
#    stops anything. A unit has a control group of its own, and the
#    application's stop can no longer reach into it.
#
# 2. IT MUST OWN THE DRAIN FLAG.
#
#    The application sets app_draining='1' before it starts a restore, and
#    the application is the thing that gets stopped — so it cannot release
#    the drain when the restore finishes. The script releases it, from the
#    one place that knows whether the restore actually worked.
#
# ── who writes the outcome record ─────────────────────────────────────────
#
# Exactly one writer, so the record cannot be half-written by two parties:
#
#   * the WORKER writes the record when the restore has an outcome of its
#     own — which is every case where the application was stopped;
#   * the APPLICATION writes the record when the restore never reached the
#     worker (a bad id, no systemd-run) — which is every case where the
#     application is still alive to write it.
#
# The worker therefore writes its record BEFORE it exits, so the application
# — which sees the child's exit — always reads a record that is already
# final. The application only writes over a record that still says
# 'started'.
#
# The record carries the exit code rather than the wording: the wording
# lives in one place — src/lib/backup/restore.ts — and the application
# derives it from the code, so the two cannot drift apart.
#
# A restore REPLAYS the database, so anything written to app_state before the
# restore is rolled back with it; a file survives.
#
# Exit codes — the contract the application reads:
#
#   0 — the dump was replayed and the services are back up.
#   2 — the id was not a backup id, or there is no such dump.
#   3 — the dump is not a readable pg_dump archive.
#   4 — pg_restore failed part way through. The database is in an unknown
#       state and the application is deliberately left stopped.
#   5 — the restore could not be moved out of the application's control
#       group, so it was refused rather than run where it would kill itself.
set -euo pipefail

BACKUP_ID="${1:?backupId required, e.g. 2026-09-23T02-00-01Z}"

# The path this script was invoked as. The worker re-invokes the SAME file,
# so the sudoers rule — which names /usr/local/bin/restore.sh and nothing
# else — still holds for the second invocation.
SELF="$(readlink -f "$0")"

DUMP_DIR=/var/backups/brownhill
DUMP="$DUMP_DIR/$BACKUP_ID.dump"

PGPORT_NUM=55432
PGHOST_SOCKET=/var/run/postgresql
PG_BIN=/opt/brownhill/pgsql/bin

# Where the outcome is recorded. The restore console and /admin/status read
# it from there.
RECORD=/var/lib/brownhill/restore-last.json

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── the id is a filename ────────────────────────────────────────────────────
# It is pasted into a path, so only the exact shape the backup script produces
# is accepted. A value carrying "/" or ".." must never be able to reach
# outside the dump directory, even though the caller is a signed-in owner.
if [[ ! "$BACKUP_ID" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$ ]]; then
  echo "restore: '$BACKUP_ID' is not a backup id (expected YYYY-MM-DDTHH-MM-SSZ)" >&2
  exit 2
fi

# ── the record ─────────────────────────────────────────────────────────────
#
# Written to a temporary file and renamed, so a reader never sees half a
# record.
write_record() {
  local state="$1" code="$2" finished="$3"
  local dir tmp
  dir="$(dirname "$RECORD")"
  mkdir -p "$dir" 2>/dev/null || true
  tmp="$RECORD.tmp.$$"
  {
    printf '{\n'
    printf '  "backupId": "%s",\n' "$BACKUP_ID"
    printf '  "startedAt": "%s",\n' "$STARTED_AT"
    printf '  "finishedAt": "%s",\n' "$finished"
    printf '  "state": "%s",\n' "$state"
    printf '  "exitCode": %s\n' "$code"
    printf '}\n'
  } >"$tmp" 2>/dev/null || true
  chmod 0644 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$RECORD" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  return 0
}

# The database commands must run as the postgres OS user so that peer
# authentication maps them to the postgres role. The systemd calls around them
# need root, so the script is root and drops to postgres only for the
# database work.
as_postgres() {
  if [[ "$(id -u)" -eq 0 ]]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

# The drain flag is the application's own switch: app_draining='1' means
# everything but /admin/* answers 503. The application sets it before it
# starts a restore; the script owns it from then on, because the application
# is stopped for the duration of the restore.
set_drain() {
  local value="$1"
  as_postgres "$PG_BIN/psql" \
    -h "$PGHOST_SOCKET" -p "$PGPORT_NUM" -U postgres -d postgres -tAc \
    "INSERT INTO app_state(key, value) VALUES ('app_draining', '$value')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null 2>&1
}

# ── hand the work to a unit of its own ─────────────────────────────────────
#
# The restore has to outlive the application's stop, and only a unit of its
# own can arrange that: a unit has a control group of its own, and the
# application's stop cannot reach into it.
#
# systemd-run starts a transient unit and waits for it. The worker is this
# same script, re-invoked with BROWNHILL_RESTORE_IN_UNIT=1 so it does not
# hand off a second time.
if [[ "${BROWNHILL_RESTORE_IN_UNIT:-}" != "1" ]]; then
  if ! command -v systemd-run >/dev/null 2>&1; then
    echo "restore: systemd-run is not available, so the restore cannot be moved" >&2
    echo "         out of the application's control group." >&2
    echo "         Refusing to start: a restore that stops the application" >&2
    echo "         would stop itself half way through." >&2
    echo "         Nothing has been changed." >&2
    exit 5
  fi

  echo "restore: handing the restore to a unit of its own..."
  if systemd-run \
      --unit="brownhill-restore-${BACKUP_ID}" \
      --collect \
      --wait \
      --setenv=BROWNHILL_RESTORE_IN_UNIT=1 \
      "$SELF" "$BACKUP_ID"; then
    handoff_rc=0
  else
    handoff_rc=$?
  fi

  # The worker's own exit code is the restore's exit code, and the worker put
  # it in the record before it exited. The record decides; systemd-run's own
  # status is only a fallback for a handoff that never reached the worker.
  recorded="$(sed -n 's/.*"exitCode"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$RECORD" 2>/dev/null | head -1)"
  if [[ -n "$recorded" ]]; then
    exit "$recorded"
  fi
  exit "$handoff_rc"
fi

# ── the worker ─────────────────────────────────────────────────────────────
#
# This is the part that runs in the transient unit's own control group. The
# application's stop happens below and cannot reach it.

# Every exit from here writes the record, so the operator can always find out
# what happened — including when the application was stopped and could not
# write it down itself.
on_exit() {
  local code=$?
  trap - EXIT
  local state="failed"
  [[ "$code" -eq 0 ]] && state="succeeded"
  write_record "$state" "$code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit "$code"
}
trap on_exit EXIT

# The box is closed from here on. The application has already set the flag
# before it started this script, but the application is about to be stopped
# and cannot be relied on to set it again.
set_drain 1 || true

test -f "$DUMP" || {
  echo "restore: no such dump: $DUMP" >&2
  echo "         Nothing has been changed." >&2
  set_drain 0 || true
  exit 2
}

# ── validate the dump BEFORE stopping anything ─────────────────────────────
# pg_restore --clean drops the existing objects as it goes. If the file turns
# out to be corrupt half way through, the live database has already been
# dismantled and the application is down with nothing to serve. Reading the
# archive's table of contents first is cheap and proves the file is intact
# before anything is stopped.
if ! as_postgres "$PG_BIN/pg_restore" --list "$DUMP" >/dev/null 2>&1; then
  echo "restore: $DUMP is not a readable pg_dump archive." >&2
  echo "         The live database has NOT been touched and the application is" >&2
  echo "         still running." >&2
  set_drain 0 || true
  exit 3
fi

echo "restore: replaying $DUMP onto the live cluster..."

systemctl stop brownhill-next.service
systemctl stop postgrest.service

# pg_restore into the live cluster at 55432.
#
# This is a LOGICAL restore: the database comes back exactly as it was when
# the dump was taken. There is no WAL replay — a pg_dump is a snapshot of the
# data, not a physical copy of the cluster, so the write-ahead log that
# followed it cannot be applied on top of it. Anything that happened after
# the dump was taken is lost, which is why the restore console shows the
# timestamp of each dump before you choose one.
if ! as_postgres "$PG_BIN/pg_restore" \
      -h "$PGHOST_SOCKET" -p "$PGPORT_NUM" -U postgres -d postgres \
      -j 4 --clean --if-exists "$DUMP"; then
  echo >&2
  echo "restore: pg_restore failed." >&2
  echo "         The database is in an unknown state and the application has" >&2
  echo "         been left stopped on purpose — starting it against a partly" >&2
  echo "         restored database would be worse than leaving it down." >&2
  echo "         See the journal: journalctl -u brownhill-next -n 100" >&2
  # The drain stays set: the database may be in an unknown state, and the
  # application must not be opened against it.
  set_drain 1 || true
  exit 4
fi

systemctl start postgrest.service

# The drain is released BEFORE the application comes back, so the operator
# does not meet a closed box that never opens. The replay brought back
# whatever the dump held — usually '0' already — and this makes it certain.
if ! set_drain 0; then
  echo "restore: warning — the drain flag could not be cleared." >&2
  echo "         The application is coming back up. If it answers 503 for" >&2
  echo "         everything but /admin, the flag is still set." >&2
fi

systemctl start brownhill-next.service
exit 0
