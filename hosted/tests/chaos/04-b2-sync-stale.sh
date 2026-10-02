#!/usr/bin/env bash
# hosted/tests/chaos/04-b2-sync-stale.sh — covers Spec Review Focus #2.
# Forces the b2 sync to fail, asserts the alert-watch path writes a marker
# under /run/brownhill/alerts/, then restores b2 and confirms the marker clears
# on the next successful run.
set -euo pipefail
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd not available; skipping"; exit 0
fi
MARKER=/run/brownhill/alerts/backup_sync_stale
mkdir -p "$(dirname "$MARKER")"

# Force-fail by symlinking b2 to /bin/false for the next two scheduled runs.
mv /usr/local/bin/b2 /usr/local/bin/b2.bak 2>/dev/null || true
ln -sf /bin/false /usr/local/bin/b2

# Trigger the backup manually (don't wait for the 02:00 timer).
systemctl start brownhill-backup.service || true
sleep 6
# alert-watch should have written the marker.
[[ -f "$MARKER" ]] || { echo "FAIL: marker $MARKER not written"; /usr/local/bin/b2.bak; exit 1; }

# Restore the b2 binary, run a successful sync, confirm the marker is removed.
rm -f /usr/local/bin/b2
mv /usr/local/bin/b2.bak /usr/local/bin/b2
systemctl start brownhill-backup.service || true
sleep 6
[[ ! -f "$MARKER" ]] || { echo "FAIL: marker $MARKER still present after successful sync"; exit 1; }
echo OK
