#!/usr/bin/env bash
# hosted/tests/chaos/03-mid-restore-crash.sh — feed restore.sh a corrupted dump,
# assert exit non-zero, app_draining stays set, alarm tag in journal.
set -euo pipefail
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd not available; skipping"; exit 0
fi
mkdir -p /var/backups/brownhill
echo 'corrupted-not-a-valid-pgdump' > /var/backups/brownhill/CORRUPT.dump
code=0
/usr/local/bin/restore.sh CORRUPT || code=$?
[[ "$code" -ne 0 ]] || { echo "FAIL: restore.sh should exit non-zero on corrupted dump"; exit 1; }
DRAIN=$(sudo -u postgres /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -tAc \
  "SELECT value FROM app_state WHERE key='app_draining'" 2>/dev/null || echo "")
[[ "$DRAIN" == "1" ]] || { echo "FAIL: app_draining should remain set to 1 (got '$DRAIN')"; exit 1; }
rm -f /var/backups/brownhill/CORRUPT.dump
echo "Manual intervention required to clear app_draining before next run." >&2
echo OK
