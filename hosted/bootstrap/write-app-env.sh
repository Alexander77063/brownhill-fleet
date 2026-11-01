#!/usr/bin/env bash
# hosted/bootstrap/write-app-env.sh — write the application's environment file.
#
# Usage: write-app-env.sh [secrets-dir] [fqdn]
#
#   secrets-dir  where the secret files live. Default /etc/brownhill/secrets.
#   fqdn         the deployment's hostname. Default: BROWNHILL_FQDN in
#                <secrets-dir>/backup.env, and then brownhill.example.co.uk.
#
# WHAT IT WRITES
# --------------
# <secrets-dir>/app.env, holding the four settings the application needs at
# run time and that live in no other file:
#
#   DATABASE_URL        — the app's own connection to Postgres, for sign-in,
#                         the operator surfaces, the restore console and the
#                         first-run setup.
#   BOOTSTRAP_TOKEN     — the HMAC key for /api/v1/bootstrap.
#   POSTGREST_URL       — where PostgREST listens on this host.
#   NEXT_PUBLIC_APP_URL — the deployment's own address. The application puts
#                         it in the links it sends, and HMRC's OAuth redirect
#                         is built from it: with it missing, the redirect
#                         pointed at http://localhost:3000, which exists on the
#                         build machine and nowhere else.
#
# WHY IT IS A SCRIPT AND NOT A BLOCK INSIDE install.sh
# -----------------------------------------------------
# Two different moments have to write this file:
#
#   install.sh          — the box is provisioned, and the file must reflect
#                         the secrets as they are now.
#   substitute-fqdn.sh  — the deployment is given its real hostname, and the
#                         address in the file must follow it.
#
# When both wrote it, they wrote it differently, and the second one to run
# silently undid the first. One implementation, called by both, cannot drift.
#
# WHY IT REWRITES THE FILE EVERY TIME
# ------------------------------------
# install.sh's own comment used to promise that app.env "is rewritten on
# every run, so a rotated database password takes effect on the next install
# rather than needing a hand edit". The function it used wrote only when the
# file was absent, so the promise was false: a rotated Postgres password
# never reached the application, and the next sign-in failed with
# "password authentication failed" for a reason that had nothing to do with
# the rotation.
#
# The values that are the OPERATOR'S — the HMRC client id and secret, the
# B2 credentials — are NOT rewritten. They live in their own files, which
# this script never touches. Only the values it can derive are written here.
set -euo pipefail

SECRETS_DIR="${1:-/etc/brownhill/secrets}"
FQDN="${2:-}"

# The one place the fallback hostname is written down. It is the placeholder
# the nginx configuration ships with, so a box that has not been given a real
# hostname yet says the same thing in both places.
PLACEHOLDER_FQDN="brownhill.example.co.uk"

read_value() {
  local file="$1" key="$2" value
  [[ -f "$file" ]] || return 1
  value="$(grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

# ── the values it can derive ────────────────────────────────────────────────
pg_pw="$(read_value "$SECRETS_DIR/pg.env" PG_SUPERUSER_PASSWORD || true)"
bootstrap_token="$(read_value "$SECRETS_DIR/bootstrap.env" BOOTSTRAP_TOKEN || true)"

if [[ -z "$pg_pw" ]]; then
  echo "write-app-env.sh: $SECRETS_DIR/pg.env does not carry PG_SUPERUSER_PASSWORD." >&2
  echo "                  The database password is needed to build the app's own" >&2
  echo "                  connection string; nothing was written." >&2
  exit 1
fi

if [[ -z "$bootstrap_token" ]]; then
  echo "write-app-env.sh: $SECRETS_DIR/bootstrap.env does not carry BOOTSTRAP_TOKEN." >&2
  echo "                  The token is needed for the first-run setup endpoint;" >&2
  echo "                  nothing was written." >&2
  exit 1
fi

# The deployment's hostname. An explicit one wins — it is what
# substitute-fqdn.sh was given — and is recorded in backup.env so that the
# address in app.env and the FQDN the backup uses for its off-host path
# prefix cannot drift apart.
if [[ -n "$FQDN" ]]; then
  fqdn="$FQDN"
  backup_env="$SECRETS_DIR/backup.env"
  if [[ -f "$backup_env" ]]; then
    if grep -q '^BROWNHILL_FQDN=' "$backup_env"; then
      sed -i "s|^BROWNHILL_FQDN=.*|BROWNHILL_FQDN=${fqdn}|" "$backup_env"
    else
      printf 'BROWNHILL_FQDN=%s\n' "$fqdn" >> "$backup_env"
    fi
  fi
else
  fqdn="$(read_value "$SECRETS_DIR/backup.env" BROWNHILL_FQDN || true)"
  fqdn="${fqdn:-$PLACEHOLDER_FQDN}"
fi

# ── write it ────────────────────────────────────────────────────────────────
target="$SECRETS_DIR/app.env"

# The file holds the database password and the bootstrap token, so it must
# never be readable by anybody else — not even for the moment it takes to
# write it.
#
# Writing straight to the target creates it with the process umask, which
# is 0644 on most systems: world-readable, until a chmod narrows it
# afterwards. For the length of that window the database password was
# readable by every account on the box.
#
# So the contents go into a temporary file that is created with restrictive
# permissions, and that file is MOVED into place. A rename is atomic, so
# the target path only ever holds a file that already has the permissions
# it should have. The file is REPLACED rather than rewritten in place,
# which also means a reader never sees a half-written file.
#
# The temporary file is created in the secrets directory itself, so the
# move is a rename within one file system. That means this script needs
# write permission on the DIRECTORY, not just on the file — which is what
# it needs anyway to put a file there.
umask 077
tmp="$(mktemp "$SECRETS_DIR/.app.env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

# The connection string is built first, and the file is printed from it. It
# reads the same either way; what changes is that the URL is one value in
# one place, with the password substituted into it, rather than a format
# string with a hole in the middle of a connection string.
db_url="postgresql://postgres:${pg_pw}@127.0.0.1:55432/postgres"

{
  printf 'DATABASE_URL=%s\n' "$db_url"
  printf 'BOOTSTRAP_TOKEN=%s\n' "$bootstrap_token"
  printf 'POSTGREST_URL=http://127.0.0.1:55430\n'
  printf 'NEXT_PUBLIC_APP_URL=https://%s\n' "$fqdn"
} > "$tmp"

# The file is group-readable by the services that need it and unreadable by
# anybody else. The owner is root because the operator edits it with root
# and the application only reads it.
if [[ "$(id -u)" -eq 0 ]] && getent group brownhill >/dev/null 2>&1; then
  chown root:brownhill "$tmp"
fi
chmod 0640 "$tmp"

mv -f -- "$tmp" "$target"
trap - EXIT

echo "wrote $target"
