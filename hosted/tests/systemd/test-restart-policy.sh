#!/usr/bin/env bash
set -euo pipefail
fail=0
for u in hosted/systemd/postgresql.service \
         hosted/systemd/postgrest.service \
         hosted/systemd/brownhill-next.service \
         hosted/systemd/brownhill-bootstrap.service \
         hosted/systemd/brownhill-backup.service \
         hosted/systemd/brownhill-backup-verify.service \
         hosted/systemd/brownhill-cron@.service \
         hosted/systemd/brownhill-cron-complete-agreements.timer \
         hosted/systemd/brownhill-cron-device-health.timer \
         hosted/systemd/brownhill-cron-escalations.timer \
         hosted/systemd/brownhill-cron-generate-rent.timer \
         hosted/systemd/brownhill-cron-owner-reports.timer \
         hosted/systemd/brownhill-cron-send-reminders.timer \
         hosted/systemd/brownhill-cron-sweep-obligations.timer \
         hosted/systemd/brownhill-cron-vat-snapshot.timer; do
  if ! systemd-analyze verify "$u"; then
    echo "FAIL: $u does not pass systemd-analyze verify"
    fail=1
  fi
done
exit "$fail"
