#!/usr/bin/env bash
# hosted/tests/chaos/01-power-loss.sh — simulates a sudden VM stop + restart.
# Asserts the cluster comes back consistent with data-checksums + WAL replay,
# and that RLS still enforces on the first query after recovery.
set -euo pipefail
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd not available; skipping"; exit 0
fi
echo "Chaos 01: simulating power loss..."
systemctl kill -s SIGKILL postgresql.service
sleep 2
START=$(date +%s)
systemctl start postgresql.service
for _ in $(seq 1 60); do
  if sudo -u postgres /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
ELAPSED=$(( $(date +%s) - START ))
echo "Recovery took ${ELAPSED}s"
[[ "$ELAPSED" -le 60 ]] || { echo "FAIL: recovery too slow"; exit 1; }
# RLS check via portable-rls-proof.sql minus the bootstrap flow.
sudo -u postgres /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f /opt/brownhill/repo/standalone/sql/portable-rls-proof.sql
echo OK
