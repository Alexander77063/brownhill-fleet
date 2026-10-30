#! /usr/bin/env bash
# /usr/local/bin/brownhill-backup.sh — installed by hosted/bootstrap/install.sh.
set -euo pipefail
DUMP_DIR=/var/backups/brownhill
mkdir -p "$DUMP_DIR/wal"
TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
/opt/brownhill/pgsql/bin/pg_dump --format=custom --jobs=4 --file="$DUMP_DIR/$TS.dump"
/opt/brownhill/pgsql/bin/psql -c 'SELECT pg_switch_wal();'
# archive_command in postgresql.conf copies WALs into $DUMP_DIR/wal/.
# Sync to B2 via the project's managed adapter.
PATH=/var/lib/brownhill/app/node_modules/.bin:$PATH \
  node --eval "import('/var/lib/brownhill/app/.next/server/chunks/backup-managed.js').then(m => m.backblazeB2.push('$DUMP_DIR/', 'brownhill/' + (process.env.BROWNILL_FQDN || 'unset')))" \
  || { echo "b2 sync failed (non-fatal: local dump retained)" ; }
/usr/bin/find "$DUMP_DIR" -name '*.dump' -mtime +7 -delete
# Emit a simple machine-readable index for the restore-from-UI endpoint.
{
  echo '{"backups":['
  find "$DUMP_DIR" -maxdepth 1 -name '*.dump' -printf '{"ts":"%TY-%Tm-%TdT%TH:%TM:%TS","path":"%p","size":%s},' \
    | sed 's/,$//'
  echo ']}'
} > "$DUMP_DIR/_index.json"
