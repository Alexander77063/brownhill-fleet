#! /usr/bin/env bash
# /usr/local/bin/brownhill-backup.sh — installed by hosted/bootstrap/install.sh.
#
# The nightly dump, and the copy of it that leaves the box.
#
# THE OFF-HOST COPY USED TO BE DEAD CODE.
# ----------------------------------------
# This script used to shell into a Next.js build chunk:
#
#   node --eval "import('/var/lib/brownhill/app/.next/server/chunks/backup-managed.js')
#                .then(m => m.backblazeB2.push('$DUMP_DIR/', ...))"
#
# A standalone build hashes its chunks, so that path can never exist. The
# import always rejected, the `|| { echo "b2 sync failed" }` on the next line
# swallowed it, and the job still reported success. Every night's dump stayed
# on the box, and the operator had no way of knowing that the one thing a
# backup exists for — the box dying — had never been protected against.
#
# The copy is now made by the b2 CLI directly, and its outcome is recorded as
# an alert marker that the operator's own paging reads. A failed copy is a
# loud, non-zero exit, not a line in a log nobody reads.
set -euo pipefail

DUMP_DIR=/var/backups/brownhill
ALERT_DIR=/run/brownhill/alerts
STALE_MARKER="$ALERT_DIR/backup_sync_stale"
SYNC_STATE="$DUMP_DIR/_sync.json"

# ── how to reach the cluster ────────────────────────────────────────────────
# The unit runs postgres with its socket in /var/run/postgresql on port 55432.
# A client that connects with no host at all uses its own compiled-in default
# — /tmp for a source build — so it would look for a socket that is not there
# on the wrong port, and the dump would fail. The socket directory is named
# explicitly. Peer authentication then matches the postgres OS user, so no
# password is needed. If the socket is not where the unit says it is, fall
# back to TCP with the superuser password from the secrets file.
PGHOST_SOCKET=/var/run/postgresql
PGPORT_NUM=55432

pick_connection() {
  if /opt/brownhill/pgsql/bin/psql \
       -h "$PGHOST_SOCKET" -p "$PGPORT_NUM" -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    export PGHOST="$PGHOST_SOCKET" PGPORT="$PGPORT_NUM" PGUSER=postgres PGDATABASE=postgres
    return 0
  fi
  if [[ -r /etc/brownhill/secrets/pg.env ]]; then
    export PGPASSWORD="$(grep '^PG_SUPERUSER_PASSWORD=' /etc/brownhill/secrets/pg.env | cut -d= -f2-)"
  fi
  export PGHOST=127.0.0.1 PGPORT="$PGPORT_NUM" PGUSER=postgres PGDATABASE=postgres
  if ! /opt/brownhill/pgsql/bin/psql -tAc 'SELECT 1' >/dev/null 2>&1; then
    echo "backup: cannot reach Postgres at $PGHOST:$PGPORT" >&2
    exit 1
  fi
}

# ── the alert marker ────────────────────────────────────────────────────────
# /run is a tmpfs, so the marker directory is created at boot by
# hosted/systemd/brownhill-alerts-tmpfiles.conf. On a box that booted before
# that was installed it may be missing; the dump still happens and the warning
# below says the operator will not be told automatically.
raise_stale() {
  if touch "$STALE_MARKER" 2>/dev/null; then
    echo "alert: $STALE_MARKER raised — the off-host copy is not current"
  else
    echo "WARNING: could not write $STALE_MARKER ($ALERT_DIR is missing or not" >&2
    echo "         writable). Nothing will page you about this — check the" >&2
    echo "         journal for this unit instead." >&2
  fi
}

clear_stale() {
  rm -f "$STALE_MARKER" 2>/dev/null || true
}

# ── the local dump ──────────────────────────────────────────────────────────
mkdir -p "$DUMP_DIR/wal"
pick_connection

TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
DUMP="$DUMP_DIR/$TS.dump"
/opt/brownhill/pgsql/bin/pg_dump --format=custom --jobs=4 --file="$DUMP"
/opt/brownhill/pgsql/bin/psql -c 'SELECT pg_switch_wal();'
# archive_command in postgresql.conf copies WALs into $DUMP_DIR/wal/.

# Retain a week of dumps.
/usr/bin/find "$DUMP_DIR" -maxdepth 1 -name '*.dump' -mtime +7 -delete

# ── the index the restore console reads ─────────────────────────────────────
# Newest first. The id is the dump's filename without the .dump suffix, and it
# is the exact argument restore.sh expects — so the two cannot drift.
#
# The timestamp is written in UTC with an explicit Z. It used to be written in
# the box's local time with no zone marker, which the status page then parsed
# as local time on a possibly different box; on a UTC server the two agreed
# by accident, and anywhere else they did not.
{
  printf '{"backups":['
  first=1
  while IFS= read -r f; do
    [[ $first -eq 1 ]] || printf ','
    first=0
    printf '{"id":"%s","ts":"%s","path":"%s","size":%s}' \
      "$(basename "$f" .dump)" \
      "$(date -u -d "@$(stat -c %Y "$f")" +%Y-%m-%dT%H:%M:%SZ)" \
      "$f" \
      "$(stat -c %s "$f")"
  done < <(find "$DUMP_DIR" -maxdepth 1 -name '*.dump' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  printf ']}\n'
} > "$DUMP_DIR/_index.json"

# ── the off-host copy ───────────────────────────────────────────────────────
# Credentials come from /etc/brownhill/secrets/backup.env, which is this unit's
# EnvironmentFile. The b2 CLI reads B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY;
# the secrets file names them BACKBLAZE_B2_KEY_ID / BACKBLAZE_B2_APPLICATION_KEY,
# so they are mapped here.
#
# An unconfigured box is not a failure of the backup — the dump is still
# written — but it IS the state the operator needs to see, so it raises the
# same marker and says so plainly.
sync_off_host() {
  if ! command -v b2 >/dev/null 2>&1; then
    echo "WARNING: the b2 CLI is not installed, so the dump was NOT copied off" >&2
    echo "         this box. Install it with:" >&2
    echo "           sudo ./hosted/scripts/fetch-runtime.sh" >&2
    return 1
  fi

  local key_id="${BACKBLAZE_B2_KEY_ID:-}"
  local key="${BACKBLAZE_B2_APPLICATION_KEY:-}"
  local bucket="${BACKBLAZE_B2_BUCKET:-}"

  if [[ -z "$key_id" || -z "$key" || "$key_id" == REPLACE_* || "$key" == REPLACE_* ]]; then
    echo "WARNING: the Backblaze B2 credentials in /etc/brownhill/secrets/backup.env" >&2
    echo "         are still the placeholders, so the dump was NOT copied off this" >&2
    echo "         box. Fill them in and the next run will copy it." >&2
    return 1
  fi
  if [[ -z "$bucket" ]]; then
    echo "WARNING: BACKBLAZE_B2_BUCKET is not set, so the dump was NOT copied off" >&2
    echo "         this box." >&2
    return 1
  fi

  export B2_APPLICATION_KEY_ID="$key_id"
  export B2_APPLICATION_KEY="$key"
  b2 sync "$DUMP_DIR" "b2://$bucket/brownhill/${BROWNILL_FQDN:-unset}/"
}

if sync_off_host; then
  echo "off-host copy complete"
  clear_stale
  printf '{"ok":true,"at":"%s","target":"b2://%s/brownhill/%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${BACKBLAZE_B2_BUCKET:-}" \
    "${BROWNILL_FQDN:-unset}" > "$SYNC_STATE"
  exit 0
fi

echo "off-host copy did not complete — the local dump is retained at $DUMP" >&2
raise_stale
printf '{"ok":false,"at":"%s","detail":"the off-host copy did not complete"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SYNC_STATE"
exit 1
