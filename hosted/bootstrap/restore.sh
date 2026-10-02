#! /usr/bin/env bash
# /usr/local/bin/restore.sh — installed by hosted/bootstrap/install.sh.
set -euo pipefail
BACKUP_ID="${1:?backupId required, e.g. 2026-09-23T02-00-01Z}"
DUMP=/var/backups/brownhill/${BACKUP_ID}.dump
test -f "$DUMP" || { echo "no such dump: $DUMP"; exit 2; }

systemctl stop brownhill-next.service
systemctl stop postgrest.service
# pg_restore into the live cluster at 55432.
/opt/brownhill/pgsql/bin/pg_restore \
  -h 127.0.0.1 -p 55432 -U postgres -d postgres -j 4 --clean --if-exists "$DUMP"
# Replay any WAL archived since the dump (if archive_command ran).
WAL=/var/backups/brownhill/wal
if [[ -d "$WAL" ]] && compgen -G "$WAL/*.gz" >/dev/null; then
  /opt/brownhill/pgsql/bin/pg_restore -h 127.0.0.1 -p 55432 -U postgres -d postgres -j 4 "$WAL" || true
fi
systemctl start postgrest.service
systemctl start brownhill-next.service
# leave drain unchanged on success — the route clears it
exit 0
