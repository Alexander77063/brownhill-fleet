#!/usr/bin/env bash
# hosted/tests/backup/test-verify.sh
# CI integration test for the weekly verification flow. Skips gracefully
# when docker isn't available (dev hosts without docker).
set -euo pipefail
if ! command -v docker >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
  echo "docker/psql not available; skipping backup-verify integration test"
  exit 0
fi
# Real CI would: seed a fake dump, run the verify script against a throwaway
# postgres, assert ROWS ≥ 1. That's a Stage 2 test; Stage 1 confirms the script
# is shape-correct (which bash -n already does).
bash -n hosted/bootstrap/brownhill-backup-verify.sh
echo OK
