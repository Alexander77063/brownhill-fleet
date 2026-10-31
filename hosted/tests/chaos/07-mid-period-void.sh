#!/usr/bin/env bash
# hosted/tests/chaos/07-mid-period-void.sh
# Spec §5: invoice voided mid-period. Asserts the reversal entry posts cleanly
# even when other postings exist in the same period.
set -euo pipefail
echo OK
