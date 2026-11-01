#!/usr/bin/env bash
# hosted/tests/chaos/03-corrupt-dump-rejected.sh
#
# Feed the restore script a dump that is not a pg_dump archive, and prove the
# box refuses it SAFELY: the live database is not touched, the application is
# not stopped, and the drain flag the restore set is released again.
#
# This drill used to be called 03-mid-restore-crash.sh, and it did not do what
# its name said. It passed the id `CORRUPT` to the script, which is not a
# backup id at all — so the script rejected the ID before it ever looked at
# the file, and the "corrupted dump" was never read. It then asserted that
# app_draining stayed set to 1, which is the opposite of the contract: a
# restore that changes nothing must release the drain, or the box stays
# closed for a restore that never happened.
#
# It is still a non-destructive drill, and that is deliberate. A drill that
# half-replays the live database would destroy the customer's data, which is
# not something to run monthly. The mid-restore failure — where the replay
# starts and then dies, leaving the database in an unknown state and the
# application deliberately stopped — is a different drill, and a destructive
# one; it belongs in a window where the operator has a known-good dump and
# the agreement to put it back.
#
# Run as root. It needs: systemd, the installed restore script, and a
# reachable Postgres.
set -uo pipefail

PSQL="/opt/brownhill/pgsql/bin/psql"
PSQL_ARGS=(-h 127.0.0.1 -p 55432 -U postgres -d postgres -tAc)
DUMP_DIR=/var/backups/brownhill
RECORD=/var/lib/brownhill/restore-last.json
# A well-formed backup id — the id is what the script checks first, and a
# drill that only ever exercises the id check is not a drill.
BACKUP_ID="2026-01-01T00-00-00Z"
DUMP="$DUMP_DIR/$BACKUP_ID.dump"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "FAIL: this drill must run as root — it stops nothing, but it reads the box's own state"; exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd not available; skipping"; exit 0
fi
if [[ ! -x /usr/local/bin/restore.sh ]]; then
  echo "FAIL: /usr/local/bin/restore.sh is not installed"; exit 1
fi
if [[ ! -x "$PSQL" ]]; then
  echo "FAIL: $PSQL is not present"; exit 1
fi

fail() { echo "FAIL: $*"; exit 1; }

drain_value() {
  "$PSQL" "${PSQL_ARGS[@]}" \
    "SELECT value FROM app_state WHERE key='app_draining'" 2>/dev/null | tr -d '[:space:]'
}

set_drain() {
  "$PSQL" "${PSQL_ARGS[@]}" \
    "INSERT INTO app_state(key, value) VALUES ('app_draining', '$1')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null 2>&1
}

# The state the application was in before the drill. The drill must put it
# back, whatever it finds.
was_active="$(systemctl is-active brownhill-next.service 2>/dev/null || echo unknown)"
drain_before="$(drain_value)"

cleanup() {
  rm -f "$DUMP"
  # Put the drain back where it was, so a drill never leaves the customer's
  # box closed.
  set_drain "${drain_before:-0}"
}
trap cleanup EXIT

mkdir -p "$DUMP_DIR"

# A file that is not an archive.
printf 'corrupted-not-a-valid-pgdump' > "$DUMP"

# The application sets this before it starts a restore, and the restore is
# responsible for releasing it. Start from the same state, so the drill can
# see the script doing it.
set_drain 1
if [[ "$(drain_value)" != "1" ]]; then
  fail "could not set app_draining=1 — the drill cannot prove the script releases it"
fi

echo "== a dump that is not an archive =="
code=0
/usr/local/bin/restore.sh "$BACKUP_ID" || code=$?

if [[ "$code" -eq 0 ]]; then
  fail "restore.sh exited 0 on a file that is not a pg_dump archive"
fi
if [[ "$code" -ne 3 ]]; then
  fail "restore.sh exited $code; expected 3 (the dump is not a readable archive)"
fi
echo "  ok: restore.sh exited $code, as the contract says"

# The application must never have been stopped. The script validates the
# archive BEFORE it stops anything, precisely so that a bad file cannot take
# the box down.
now_active="$(systemctl is-active brownhill-next.service 2>/dev/null || echo unknown)"
if [[ "$now_active" != "$was_active" ]]; then
  fail "the application was stopped by a restore that changed nothing (was '$was_active', now '$now_active')"
fi
echo "  ok: the application was not stopped"

# The drain must be released: nothing was restored, so nothing should be
# closed.
if [[ "$(drain_value)" != "0" ]]; then
  fail "app_draining is '$(drain_value)' — the restore changed nothing, so the box must not be left closed"
fi
echo "  ok: the drain was released — the box is not left closed for a restore that never happened"

# The outcome must be on the record, with the code the script exited with.
if [[ ! -f "$RECORD" ]]; then
  fail "no outcome was recorded at $RECORD"
fi
recorded_code="$(sed -n 's/.*"exitCode"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$RECORD" | head -1)"
recorded_state="$(sed -n 's/.*"state"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RECORD" | head -1)"
if [[ "$recorded_code" != "3" ]]; then
  fail "the record carries exit code '$recorded_code', expected 3"
fi
if [[ "$recorded_state" != "failed" ]]; then
  fail "the record says '$recorded_state', expected 'failed'"
fi
echo "  ok: the outcome was recorded as failed, exit code 3"

echo
echo "Drill 03 passed. The box was not touched: nothing was restored, the application was never stopped, and the drain was released."
echo OK
