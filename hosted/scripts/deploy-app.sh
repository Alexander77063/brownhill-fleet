#!/usr/bin/env bash
# hosted/scripts/deploy-app.sh — build the hosted app and install it where the
# systemd unit expects it.
#
# The update procedure in hosted/README.md used to be:
#
#   git pull && pnpm install && pnpm build:hosted && systemctl restart brownhill-next
#
# and it deployed nothing. Two things were missing:
#
#   * The build has to be a STANDALONE build. `output: 'standalone'` is what
#     produces the `server.js` the unit runs, and it is also what turns on the
#     `/rest/v1 → PostgREST` rewrite that every `.from()` call in the app
#     reads its data through. A build without it starts happily and then
#     cannot reach its own database.
#
#   * The build output has to be COPIED to /var/lib/brownhill/app, which is the
#     unit's WorkingDirectory. Building in the repository and restarting the
#     service leaves the service running the PREVIOUS build, and the operator
#     is left believing the update took.
#
# The previous build is kept until the new one is in place, so a failure part
# way through cannot leave the box with no application at all.
#
# Usage (operator):  ./hosted/scripts/deploy-app.sh
#
# `systemctl restart` and the ownership fix need root; everything else does
# not, and the script says which parts need it rather than requiring the whole
# thing to run as root.

set -euo pipefail
cd "$(dirname "$0")/../.."
REPO=$(pwd)
APP_DIR=${APP_DIR:-/var/lib/brownhill/app}

# ── build ───────────────────────────────────────────────────────────────────
echo "==> installing dependencies"
pnpm install --frozen-lockfile

echo "==> building the hosted app"
pnpm build:hosted

if [[ ! -f .next/standalone/server.js ]]; then
  echo "FAIL: no standalone output at .next/standalone/server.js." >&2
  echo "      The build did not produce a standalone server, so there is nothing to deploy." >&2
  exit 1
fi

# ── stage ───────────────────────────────────────────────────────────────────
echo "==> staging the build"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/brownhill-deploy.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

cp -a .next/standalone/. "$STAGE/"
mkdir -p "$STAGE/.next"
cp -a .next/static "$STAGE/.next/static"
# public/ is NOT part of the standalone output — without it the app serves
# HTML with no stylesheets and no icons.
if [[ -d public ]]; then
  cp -a public "$STAGE/public"
fi

# ── swap ────────────────────────────────────────────────────────────────────
echo "==> installing into $APP_DIR"
PREV="${APP_DIR}.previous"
rm -rf "$PREV"
if [[ -d "$APP_DIR" ]]; then
  mv "$APP_DIR" "$PREV"
fi
mkdir -p "$(dirname "$APP_DIR")"
mv "$STAGE" "$APP_DIR"
trap - EXIT

# The unit runs as `brownhill`, so the files have to belong to it.
if ! chown -R brownhill:brownhill "$APP_DIR" 2>/dev/null; then
  echo "note: could not set ownership on $APP_DIR — run: sudo chown -R brownhill:brownhill $APP_DIR"
fi

# ── restart ─────────────────────────────────────────────────────────────────
echo "==> restarting brownhill-next.service"
if ! systemctl restart brownhill-next.service; then
  echo "FAIL: the service did not restart. The previous build is at $PREV" >&2
  echo "      roll back with:  rm -rf $APP_DIR && mv $PREV $APP_DIR && systemctl restart brownhill-next" >&2
  exit 1
fi

systemctl --no-pager --lines=5 status brownhill-next.service || true
echo "==> deployed. The previous build is at $PREV"
