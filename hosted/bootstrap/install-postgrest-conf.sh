#!/usr/bin/env bash
# hosted/bootstrap/install-postgrest-conf.sh — render postgrest.conf.template
# into /etc/brownhill/postgrest.conf using the secrets written by install.sh.
# Idempotent: re-running regenerates the file from the same secrets.
#
# Usage: sudo hosted/bootstrap/install-postgrest-conf.sh

set -euo pipefail
cd "$(dirname "$0")/../.."

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1"; exit 1; }; }
require envsubst

# load secrets
. /etc/brownhill/secrets/pg.env
. /etc/brownhill/secrets/jwt.env

template=hosted/bootstrap/postgrest.conf.template
target=/etc/brownhill/postgrest.conf

[[ -f "$template" ]] || { echo "no $template"; exit 1; }

install -d /etc/brownhill
envsubst < "$template" > "$target.new"
chmod 0640 "$target.new"
# Owned by the shared `brownhill` group rather than by the postgrest account:
# postgrest.service runs as that account, and the account is a member of the
# group. install.sh creates the group and the membership before calling this
# script, so the chown cannot fail.
chown root:brownhill "$target.new" 2>/dev/null || true
mv "$target.new" "$target"
echo "wrote $target"
