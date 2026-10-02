#! /usr/bin/env bash
# /usr/local/bin/brownhill-alert-forward.sh — installed by hosted/bootstrap/install.sh.
# Reads active alert markers under /run/brownhill/alerts/ and forwards them to
# the page-out channel the operator configures (Pushover / SMS / email — out of
# scope here). The marker is what's tested; this script is the seam where the
# real paging lands in a follow-up.
set -uo pipefail
ALERTS=/run/brownhill/alerts
[[ -d "$ALERTS" ]] || exit 0
for f in "$ALERTS"/*; do
  [[ -f "$f" ]] || continue
  name=$(basename "$f")
  ts=$(date -u +%FT%TZ)
  echo "[$ts] ALERT: brownhill/$name" | logger -t brownhill-alert || true
done
