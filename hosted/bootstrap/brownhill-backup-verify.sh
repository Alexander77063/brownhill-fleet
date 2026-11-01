#! /usr/bin/env bash
# /usr/local/bin/brownhill-backup-verify.sh — installed by hosted/bootstrap/install.sh.
#
# Proves the nightly dump is actually restorable: it restores the newest dump
# into a scratch cluster, checks the rows came back, and replays the RLS
# proof against the restored copy.
#
# A backup that has never been restored is a hypothesis, not a backup. This is
# the weekly drill that turns it into a fact.
set -euo pipefail

DUMP_DIR=/var/backups/brownhill
PG_BIN=/opt/brownhill/pgsql/bin
SCRATCH_PORT=55433

# The RLS proof is staged next to the rest of the SQL by
# hosted/scripts/fetch-runtime.sh. It used to be read out of the operator's
# git working copy at /opt/brownhill/repo, which does not exist on a box
# deployed from a tarball — so this unit failed every Sunday for the wrong
# reason, and a failing verify is a verify nobody reads.
RLS_PROOF=/opt/brownhill/sql/portable-rls-proof.sql
if [[ ! -f "$RLS_PROOF" ]]; then
  RLS_PROOF=/opt/brownhill/repo/standalone/sql/portable-rls-proof.sql
fi
if [[ ! -f "$RLS_PROOF" ]]; then
  echo "verify FAIL: portable-rls-proof.sql not found (looked in /opt/brownhill/sql" >&2
  echo "           and /opt/brownhill/repo/standalone/sql). Run" >&2
  echo "             sudo ./hosted/scripts/fetch-runtime.sh" >&2
  exit 1
fi

TMP=$(mktemp -d)
mkdir -p "$TMP/data"
# --data-checksums here, not a hand-written "data-checksums" line in
# postgresql.conf: the parameter is spelled data_checksums, and initdb is the
# supported way to turn it on. The old line was a typo that made the scratch
# cluster refuse to start.
"$PG_BIN/initdb" -D "$TMP/data" --auth=trust --username=postgres --data-checksums >/dev/null
echo "port = $SCRATCH_PORT" >> "$TMP/data/postgresql.conf"
"$PG_BIN/pg_ctl" -D "$TMP/data" -l "$TMP/pg.log" -o "-p $SCRATCH_PORT" start
trap '"$PG_BIN/pg_ctl" -D "$TMP/data" stop 2>/dev/null; rm -rf "$TMP"' EXIT

# Wait for the cluster to accept queries rather than sleeping a fixed amount.
for _ in $(seq 1 30); do
  if "$PG_BIN/psql" -h 127.0.0.1 -p "$SCRATCH_PORT" -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
"$PG_BIN/psql" -h 127.0.0.1 -p "$SCRATCH_PORT" -U postgres -d postgres -tAc 'SELECT 1' >/dev/null

# newest local dump
DUMP=$(ls -1t "$DUMP_DIR"/*.dump 2>/dev/null | head -1)
test -n "$DUMP" || { echo "verify FAIL: no dumps in $DUMP_DIR"; exit 1; }
"$PG_BIN/pg_restore" -h 127.0.0.1 -p "$SCRATCH_PORT" -U postgres -d postgres -j 4 --clean --if-exists "$DUMP"
ROWS=$("$PG_BIN/psql" -h 127.0.0.1 -p "$SCRATCH_PORT" -U postgres -d postgres -tAc 'SELECT SUM(n_live_tup) FROM pg_stat_user_tables')
echo "Verified restore: $ROWS rows"
test "$ROWS" -ge 1 || { echo "verify FAIL: empty database"; exit 1; }

# Replay the RLS proof against the restored copy — the policies must still
# hold on the data that comes back from a backup, not only on the live one.
"$PG_BIN/psql" -h 127.0.0.1 -p "$SCRATCH_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f "$RLS_PROOF"
echo OK
