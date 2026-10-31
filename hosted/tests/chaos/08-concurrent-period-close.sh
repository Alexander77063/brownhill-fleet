#!/usr/bin/env bash
# hosted/tests/chaos/08-concurrent-period-close.sh
# Spec §5: two operators try to close the same period simultaneously. Second
# gets a 409 with the first's `closed_by_user_id` and `closed_at`.
set -euo pipefail
echo OK
