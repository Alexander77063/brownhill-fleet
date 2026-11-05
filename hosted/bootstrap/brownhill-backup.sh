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
# The copy is now made by off-host-copy.mjs, and its outcome is recorded both
# as an alert marker that the operator's own paging reads and as a state file
# the operator's status page shows. A failed copy is a loud, non-zero exit,
# not a line in a log nobody reads.
set -euo pipefail

# The directories are overridable so the job can be exercised without a box.
# The defaults are the real ones.
DUMP_DIR="${DUMP_DIR:-/var/backups/brownhill}"
ALERT_DIR="${ALERT_DIR:-/run/brownhill/alerts}"
STALE_MARKER="$ALERT_DIR/backup_sync_stale"
SYNC_STATE="$DUMP_DIR/_sync.json"

# The hostname the copy was filed under, filled in by sync_off_host. It is a
# global because the caller reports it — and it has to be the value the copy
# ACTUALLY used, not the environment variable read again, or a box that is
# still on the pre-correction name reports its target as "unset" while
# copying to a real path.
SYNC_FQDN=""

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

# ── the off-host copy ───────────────────────────────────────────────────────
# The copy is made by off-host-copy.mjs: ONE implementation, shared by the
# nightly job here and by anything else that needs to put a dump somewhere
# else. It resolves the destination from the deployment's settings, makes the
# copy, checks that the bytes arrived, and records the outcome in _sync.json —
# the file the operator's status page reads.
#
# The settings live in /etc/brownhill/secrets/backup.env, which is this unit's
# EnvironmentFile. They are named here as well, so the contract with that
# file is visible in the job that runs nightly and not only in the helper it
# calls.
#
# An unconfigured box is not a failure of the backup — the dump is still
# written — but it IS the state the operator needs to see, so it raises the
# same marker and says so plainly.
sync_off_host() {
  local helper output status

  helper="$(off_host_helper)"
  if [[ ! -f "$helper" ]]; then
    echo "WARNING: the off-host helper is not installed ($helper), so the dump was" >&2
    echo "         NOT copied off this box. Install it with:" >&2
    echo "           sudo ./hosted/scripts/install-hosted.sh" >&2
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "WARNING: node is not on this job's PATH, so the dump was NOT copied off" >&2
    echo "         this box. The pinned runtime lives in /opt/brownhill/node/bin." >&2
    return 1
  fi

  output="$(node "$helper" --source "$DUMP_DIR" \
             --target "${BROWNHILL_OFFHOST_TARGET:-}" \
             --dir "${BROWNHILL_OFFHOST_DIR:-}" 2>&1)" && status=0 || status=$?
  printf '%s\n' "$output" >&2
  SYNC_FQDN="$(printf '%s\n' "$output" | sed -n 's/^FQDN=//p' | head -n 1)"
  return "$status"
}

# Where the copy helper lives.
#
# The installed box has it in /usr/local/lib/brownhill, beside the other
# helpers the installer ships. In the repository it sits beside this script,
# so the tests drive the real thing rather than a copy of it.
off_host_helper() {
  if [[ -f /usr/local/lib/brownhill/off-host-copy.mjs ]]; then
    printf '%s\n' /usr/local/lib/brownhill/off-host-copy.mjs
    return 0
  fi
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || return 1
  printf '%s\n' "$here/../scripts/off-host-copy.mjs"
}

# ── the nightly job ─────────────────────────────────────────────────────────
# Everything above this line is a definition; everything inside this function
# is the job. It is wrapped in a function so that the off-host copy can be
# exercised on its own: the test sources this file and calls sync_off_host
# directly, and a file that is read must not take a dump as a side effect.
run_backup() {
  # ── the local dump ────────────────────────────────────────────────────────
  mkdir -p "$DUMP_DIR/wal"
  pick_connection

  TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
  DUMP="$DUMP_DIR/$TS.dump"
  /opt/brownhill/pgsql/bin/pg_dump --format=custom --jobs=4 --file="$DUMP"
  /opt/brownhill/pgsql/bin/psql -c 'SELECT pg_switch_wal();'
  # archive_command in postgresql.conf copies WALs into $DUMP_DIR/wal/.

  # Retain a week of dumps.
  /usr/bin/find "$DUMP_DIR" -maxdepth 1 -name '*.dump' -mtime +7 -delete

  # ── the index the restore console reads ───────────────────────────────────
  # Newest first. The id is the dump's filename without the .dump suffix, and
  # it is the exact argument restore.sh expects — so the two cannot drift.
  #
  # The timestamp is written in UTC with an explicit Z. It used to be written
  # in the box's local time with no zone marker, which the status page then
  # parsed as local time on a possibly different box; on a UTC server the two
  # agreed by accident, and anywhere else they did not.
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

  # ── the copy that leaves the box ──────────────────────────────────────────
  #
  # The helper writes the state itself — whether the copy worked or not — so
  # that the status page and the alert marker can never disagree about what
  # happened. The start time is kept so that a state left over from an
  # earlier run can be recognised as stale: if the helper never ran at all
  # (node missing, the helper not installed), the state on disk still says
  # "Copied" from last night, and the operator must not be shown that.
  local started
  started=$(date +%s)

  if sync_off_host; then
    echo "off-host copy complete"
    clear_stale
    exit 0
  fi

  echo "off-host copy did not complete — the local dump is retained at $DUMP" >&2
  raise_stale
  if [[ ! -f "$SYNC_STATE" ]] || [[ "$(stat -c %Y "$SYNC_STATE")" -lt "$started" ]]; then
    printf '{"ok":false,"at":"%s","target":null,"targetKind":null,"verified":false,"detail":"the off-host helper did not run"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SYNC_STATE"
  fi
  exit 1
}

# The job runs when this file is EXECUTED, and not when it is sourced. The
# systemd unit executes it; the test sources it.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  run_backup
fi
