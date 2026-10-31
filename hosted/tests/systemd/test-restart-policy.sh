#!/usr/bin/env bash
set -euo pipefail
fail=0
for u in hosted/systemd/postgresql.service \
         hosted/systemd/postgrest.service \
         hosted/systemd/brownhill-next.service \
         hosted/systemd/brownhill-bootstrap.service \
         hosted/systemd/brownhill-backup.service \
         hosted/systemd/brownhill-backup-verify.service; do
  if ! systemd-analyze verify "$u"; then
    echo "FAIL: $u does not pass systemd-analyze verify"
    fail=1
  fi
done
exit "$fail"
