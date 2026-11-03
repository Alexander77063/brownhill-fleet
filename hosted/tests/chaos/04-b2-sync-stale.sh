#!/usr/bin/env bash
# hosted/tests/chaos/04-b2-sync-stale.sh — covers Spec Review Focus #2.
# Forces the b2 sync to fail, asserts the alert-watch path writes a marker
# under /run/brownhill/alerts/, then restores b2 and confirms the marker clears
# on the next successful run.
#
# WHY IT ASKS FIRST
# ------------------
# The drill breaks the box on purpose: it moves the b2 CLI aside and puts a
# stub in its place, so the backup fails, so the marker is raised, so the
# drill can prove the marker clears when the backup works again.
#
# Every part of that needs something the box may not have, and this drill
# used to assume all of it:
#
#   * The b2 CLI. The move was allowed to fail silently, and a symlink to
#     /bin/false was put in its place. On a box where b2 had never been
#     installed the symlink was the only "b2" that had ever existed, so the
#     drill went on to "prove" that a program that had never been on the
#     box could not sync. If the drill was interrupted before it could put
#     the original back, the stub stayed on the box.
#
#   * Real Backblaze credentials. The backup refuses to copy off-host while
#     they are the installer's placeholders. The drill ran anyway, so its
#     first half passed for the wrong reason — the marker was raised
#     because the credentials were placeholders, not because the drill had
#     broken anything — and the drill was reporting on a box that had never
#     had an off-host copy at all.
#
#   * A real remote prefix. The dump is filed under the deployment's
#     hostname inside the bucket. The installer writes the placeholder
#     brownhill.example.co.uk, so a copy filed under that name is filed
#     where nobody looks, and proving that IT goes stale proves nothing
#     about the backup the operator would actually restore from.
#
# So the drill asks hosted/tests/chaos/lib/box-preconditions.sh before it
# touches anything, and skips OUT LOUD when the answer is no. A drill that
# did not run is not a pass, and it says so where the operator will see it.
#
# It needs the box: root, systemd, the backup unit, the b2 CLI and real
# credentials. It is not part of the CI chaos run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/box-preconditions.sh
source "$HERE/lib/box-preconditions.sh"

# ── the preconditions ───────────────────────────────────────────────────────
#
# Nothing below this point has touched the box yet, and nothing below this
# point runs at all when one of these says no.

if ! command -v systemctl >/dev/null 2>&1; then
  echo "SKIP: systemd is not installed on this machine, so the backup unit cannot be run."
  echo "      The drill did not run."
  exit 0
fi

if ! systemctl cat "$BACKUP_UNIT" >/dev/null 2>&1; then
  echo "SKIP: the $BACKUP_UNIT unit is not installed on this box, so there is no"
  echo "      backup to break. The drill did not run."
  exit 0
fi

if ! blocker="$(backup_drill_blocker)"; then
  echo "SKIP: $blocker."
  echo "      The drill did not run."
  exit 0
fi

# ── the drill ───────────────────────────────────────────────────────────────

MARKER="$BACKUP_STALE_MARKER"
B2_BAK=""

# Put the box back the way it was, whether the drill finishes or not. A drill
# that leaves a stub where the b2 CLI was has broken the very thing it was
# sent to prove.
restore_b2() {
  if [ -n "$B2_BAK" ] && [ -e "$B2_BAK" ]; then
    rm -f "$B2_CLI"
    mv "$B2_BAK" "$B2_CLI"
    B2_BAK=""
  fi
}
trap restore_b2 EXIT

mkdir -p "$(dirname "$MARKER")"

# Force-fail by replacing the b2 CLI with something that cannot sync, for the
# next scheduled run.
B2_BAK="${B2_CLI}.bak"
mv "$B2_CLI" "$B2_BAK"
ln -sf /bin/false "$B2_CLI"

# Trigger the backup manually (don't wait for the 02:00 timer).
systemctl start "$BACKUP_UNIT" || true
sleep 6
# alert-watch should have written the marker.
if [ ! -f "$MARKER" ]; then
  echo "FAIL: marker $MARKER not written"
  exit 1
fi

# Restore the b2 binary, run a successful sync, confirm the marker is removed.
restore_b2
systemctl start "$BACKUP_UNIT" || true
sleep 6
if [ -f "$MARKER" ]; then
  echo "FAIL: marker $MARKER still present after successful sync"
  exit 1
fi
echo OK
