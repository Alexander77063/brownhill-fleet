#! /usr/bin/env bash
# /usr/local/bin/restore.sh — installed by hosted/bootstrap/install.sh.
#
# Restores a dump onto the live cluster.
#
# It runs as root, because it stops and starts the application and the data
# API around the restore. The restore console (src/app/admin/restore/route.ts)
# invokes it through a single narrow sudoers rule; the rule allows only this
# script, and this script accepts only a well-formed backup id.
set -euo pipefail

BACKUP_ID="${1:?backupId required, e.g. 2026-09-23T02-00-01Z}"

# ── the id is a filename ────────────────────────────────────────────────────
# It is pasted into a path, so only the exact shape the backup script produces
# is accepted. A value carrying "/" or ".." must never be able to reach
# outside the dump directory, even though the caller is a signed-in owner.
if [[ ! "$BACKUP_ID" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$ ]]; then
  echo "restore: '$BACKUP_ID' is not a backup id (expected YYYY-MM-DDTHH-MM-SSZ)" >&2
  exit 2
fi

DUMP_DIR=/var/backups/brownhill
DUMP="$DUMP_DIR/$BACKUP_ID.dump"
test -f "$DUMP" || { echo "restore: no such dump: $DUMP" >&2; exit 2; }

PGPORT_NUM=55432
PGHOST_SOCKET=/var/run/postgresql

# The database commands must run as the postgres OS user so that peer
# authentication maps them to the postgres role. The systemd calls around them
# need root, so the script is root and drops to postgres only for the database
# work.
as_postgres() {
  if [[ "$(id -u)" -eq 0 ]]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

# ── validate the dump BEFORE stopping anything ──────────────────────────────
# pg_restore --clean drops the existing objects as it goes. If the file turns
# out to be corrupt half way through, the live database has already been
# dismantled and the application is down with nothing to serve. Reading the
# archive's table of contents first is cheap and proves the file is intact
# before anything is stopped.
if ! as_postgres /opt/brownhill/pgsql/bin/pg_restore --list "$DUMP" >/dev/null 2>&1; then
  echo "restore: $DUMP is not a readable pg_dump archive." >&2
  echo "         The live database has NOT been touched and the application is" >&2
  echo "         still running." >&2
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
if ! as_postgres /opt/brownhill/pgsql/bin/pg_restore \
      -h "$PGHOST_SOCKET" -p "$PGPORT_NUM" -U postgres -d postgres \
      -j 4 --clean --if-exists "$DUMP"; then
  echo >&2
  echo "restore: pg_restore failed." >&2
  echo "         The database is in an unknown state and the application has" >&2
  echo "         been left stopped on purpose — starting it against a partly" >&2
  echo "         restored database would be worse than leaving it down." >&2
  echo "         See the journal: journalctl -u brownhill-next -n 100" >&2
  exit 4
fi

systemctl start postgrest.service
systemctl start brownhill-next.service
# leave drain unchanged on success — the route clears it
exit 0
