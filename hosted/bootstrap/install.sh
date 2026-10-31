#!/usr/bin/env bash
set -euo pipefail
# hosted/bootstrap/install.sh — first-time provisioning.
# Idempotent: re-running on a partially-built host must not fail.
#
# WHAT THIS SCRIPT IS RESPONSIBLE FOR
# -----------------------------------
# It puts a box into the state the systemd units expect. Every unit, every
# account and every directory the running system reads from is created here.
#
# The version of this script that shipped in the first handover installed
# three units (postgresql, its override, brownhill-bootstrap) and nothing
# else. On a fresh box that left:
#
#   * no `brownhill` account — the unit that runs the Next app is
#     `User=brownhill`, so systemd refused to start it ("Failed to determine
#     user credentials") and deploy-app.sh's `chown` failed too;
#   * no `postgrest` account — postgrest.service is `User=postgrest`, and
#     nothing in fetch-runtime.sh created it either, so the data API the
#     whole app reads through could never start;
#   * no postgrest.service, so the app had nothing to talk to;
#   * no brownhill-next.service, so the app itself was never launched;
#   * no backup, backup-verify, certbot or alert-watch units, so the nightly
#     dump, the acceptance suite's fifth gate, the TLS renewal and the disk
#     alert did not exist;
#   * no /usr/local/bin/brownhill-backup.sh, brownhill-backup-verify.sh or
#     brownhill-alert-forward.sh, which are what those units execute;
#   * no /usr/local/bin/restore.sh, which the restore console spawns by
#     absolute path, so the operator's "restore this backup" button failed
#     with ENOENT every time;
#   * no database at all — no cluster, no password on the postgres role and
#     no pg_hba.conf — so even a box with everything else in place had no
#     data and the app could not authenticate against it;
#   * a secrets directory only root could read, so every unit with an
#     `EnvironmentFile=` in it failed to load its environment;
#   * and it died on line 61, because `install` does not create the
#     `/etc/systemd/system/postgresql.service.d/` parent directory.
#
# The result was a box that had a database and nothing to serve it.
#
# ORDERING
# --------
# This script expects the runtime to be already installed — Postgres, Node
# and PostgREST under /opt/brownhill. Run hosted/scripts/fetch-runtime.sh
# FIRST; it creates the `postgres` account this script adds to the secrets
# group, and it puts the binaries the units execute where the units look for
# them. If the runtime is missing this script says so and stops rather than
# leaving a half-provisioned box behind.

# ── preflight ────────────────────────────────────────────────────────────────
if [[ ! -x /opt/brownhill/pgsql/bin/postgres ]]; then
  echo "install.sh: /opt/brownhill/pgsql/bin/postgres is missing." >&2
  echo "             Run the runtime installer first:" >&2
  echo "               sudo ./hosted/scripts/fetch-runtime.sh" >&2
  exit 1
fi

cd "$(dirname "$0")/../.."

# ── accounts ─────────────────────────────────────────────────────────────────
#
# Three services read /etc/brownhill/secrets:
#
#   postgres    — pg.env (the superuser password) and backup.env (the B2
#                 credentials), because the backup runs as the postgres user;
#   postgrest   — jwt.env (the JWT signing secret it verifies tokens with)
#                 and /etc/brownhill/postgrest.conf;
#   brownhill   — jwt.env (the same secret, for signing), app.env (the
#                 database URL, the bootstrap token, the PostgREST URL) and
#                 bootstrap.env.
#
# The files live in one directory, so the directory has to be traversable by
# all three and each file readable by the service that needs it. Rather than
# juggling a group per file, all three services share one group and the
# secret files are group-owned by it. The box is single-tenant: every one of
# these services is part of the same application.
getent group brownhill >/dev/null || groupadd --system brownhill
getent group postgrest >/dev/null || groupadd --system postgrest

id -u brownhill >/dev/null 2>&1 || \
  useradd --system --gid brownhill --home-dir /var/lib/brownhill \
          --shell /usr/sbin/nologin brownhill
id -u postgrest >/dev/null 2>&1 || \
  useradd --system --gid postgrest --home-dir /opt/brownhill \
          --shell /usr/sbin/nologin postgrest

for svc_user in postgres postgrest brownhill; do
  if ! id -nG "$svc_user" | tr ' ' '\n' | grep -qx brownhill; then
    usermod -aG brownhill "$svc_user"
  fi
done

# ── directories ──────────────────────────────────────────────────────────────
# The secrets directory is group-owned so the service accounts can traverse
# it; the files inside are 0640 and group-owned by the same group.
install -d -m 0750 -o root -g brownhill /etc/brownhill/secrets

# Where the deployed app lives. brownhill-next.service runs from here as the
# brownhill account, and deploy-app.sh stages the build into it.
install -d -m 0750 -o brownhill -g brownhill /var/lib/brownhill
install -d -m 0750 -o brownhill -g brownhill /var/lib/brownhill/app

# Where the nightly dump lands. brownhill-backup.sh runs as postgres and
# creates its own subdirectories, but it cannot create /var/backups/brownhill
# itself: /var/backups belongs to root.
#
# The group is the shared service group, NOT postgres: the operator status
# page and the restore console run as the `brownhill` account and have to
# read _index.json and _sync.json out of this directory. With the directory
# owned by postgres:postgres 0750 they could not open the file at all, and
# both surfaces reported "no backups" on a box that had them.
install -d -m 0750 -o postgres -g brownhill /var/backups/brownhill
# `install -d` does not restate the ownership of a directory that already
# exists, and a box installed before this fix still has the old group.
chown postgres:brownhill /var/backups/brownhill
chmod 0750 /var/backups/brownhill

# ── secrets ──────────────────────────────────────────────────────────────────
# Only written if absent, so a pre-generated value always wins.
write_secret() {
  local path="$1"
  shift
  if [[ ! -f "$path" ]]; then
    printf '%s\n' "$@" > "$path"
  fi
  chown root:brownhill "$path"
  chmod 0640 "$path"
}

if [[ ! -f /etc/brownhill/secrets/pg.env ]]; then
  pg_pw=$(openssl rand -hex 32)
  write_secret /etc/brownhill/secrets/pg.env "PG_SUPERUSER_PASSWORD=$pg_pw"
fi
if [[ ! -f /etc/brownhill/secrets/jwt.env ]]; then
  jwt=$(openssl rand -hex 64)
  write_secret /etc/brownhill/secrets/jwt.env "JWT_SHARED_SECRET=$jwt"
fi
if [[ ! -f /etc/brownhill/secrets/bootstrap.env ]]; then
  bs=$(openssl rand -hex 32)
  write_secret /etc/brownhill/secrets/bootstrap.env "BOOTSTRAP_TOKEN=$bs"
fi

# The app's own environment.
#
# The systemd unit for the Next app loads this file, and it carries the three
# values the app needs at run time that live in no other secret file:
#
#   DATABASE_URL     — the app opens its own connection to Postgres for
#                      sign-in, the operator status surface, the restore
#                      console and the first-run setup. Without it every one of
#                      those paths throws "DATABASE_URL is not set", which
#                      on a freshly installed box means nobody can sign in at
#                      all.
#   BOOTSTRAP_TOKEN  — the HMAC key for /api/v1/bootstrap. Without it the
#                      owner cannot create their first account, because no
#                      signature can ever verify.
#   POSTGREST_URL    — where PostgREST listens on this host.
#
# It is rewritten on every run, so a rotated database password takes effect on
# the next install rather than needing a hand edit.
pg_pw=$(grep '^PG_SUPERUSER_PASSWORD=' /etc/brownhill/secrets/pg.env | cut -d= -f2-)
bs=$(grep '^BOOTSTRAP_TOKEN=' /etc/brownhill/secrets/bootstrap.env | cut -d= -f2-)
write_secret /etc/brownhill/secrets/app.env \
  "DATABASE_URL=postgresql://postgres:${pg_pw}@127.0.0.1:55432/postgres" \
  "BOOTSTRAP_TOKEN=${bs}" \
  "POSTGREST_URL=http://127.0.0.1:55430"

# The B2 credentials are the operator's to supply — they cannot be generated.
# If they are missing the nightly job still runs and still writes a local
# dump; only the off-host copy is skipped. The placeholders make that an
# obvious, greppable failure rather than a silent one.
if [[ ! -f /etc/brownhill/secrets/backup.env ]]; then
  write_secret /etc/brownhill/secrets/backup.env \
    "BACKBLAZE_B2_KEY_ID=REPLACE_WITH_B2_KEY_ID" \
    "BACKBLAZE_B2_APPLICATION_KEY=REPLACE_WITH_B2_APPLICATION_KEY" \
    "BACKBLAZE_B2_BUCKET=brownhill-fleet-prod" \
    "BROWNHILL_FQDN=brownhill.example.co.uk"
  echo "WARNING: /etc/brownhill/secrets/backup.env was created with placeholder" >&2
  echo "         values. The nightly dump will stay on the box until you fill" >&2
  echo "         in the Backblaze B2 credentials and restart the timer." >&2
fi

# A box provisioned before the FQDN variable was renamed still carries the old
# key in backup.env, and the block above only writes that file when it is
# absent. Rename the key in place so the operator's value is kept and the box
# matches the documentation. The backup script still reads the old name as a
# fallback, so this is a tidy-up rather than a repair — but without it a box
# that installs once and then only updates the app keeps the old name, and
# the nightly job warns about it every night.
legacy_backup_key='BROWNILL_FQDN'   # legacy-env-var: the pre-correction key
if grep -q "^${legacy_backup_key}=" /etc/brownhill/secrets/backup.env 2>/dev/null; then
  sed -i "s/^${legacy_backup_key}=/BROWNHILL_FQDN=/" /etc/brownhill/secrets/backup.env
  chown root:brownhill /etc/brownhill/secrets/backup.env
  chmod 0640 /etc/brownhill/secrets/backup.env
  echo "brownhill: renamed the FQDN variable in backup.env to BROWNHILL_FQDN."
fi

# ── systemd units ────────────────────────────────────────────────────────────
install -d /etc/systemd/system/postgresql.service.d
install -d /etc/systemd/system/postgrest.service.d

install -m 0644 hosted/systemd/postgresql.service            /etc/systemd/system/
install -m 0644 hosted/systemd/postgresql.service.d/override.conf \
  /etc/systemd/system/postgresql.service.d/
install -m 0644 hosted/systemd/postgrest.service             /etc/systemd/system/
install -m 0644 hosted/systemd/postgrest.service.d/override.conf \
  /etc/systemd/system/postgrest.service.d/
install -m 0644 hosted/systemd/brownhill-bootstrap.service    /etc/systemd/system/
install -m 0644 hosted/systemd/brownhill-next.service         /etc/systemd/system/
install -m 0644 hosted/systemd/brownhill-backup.service       /etc/systemd/system/
install -m 0644 hosted/systemd/brownhill-backup.timer         /etc/systemd/system/
install -m 0644 hosted/systemd/brownhill-backup-verify.service /etc/systemd/system/
install -m 0644 hosted/systemd/brownhill-backup-verify.timer   /etc/systemd/system/
install -m 0644 hosted/systemd/brownhill-certbot-renew.service /etc/systemd/system/
install -m 0644 hosted/systemd/brownhill-certbot-renew.timer   /etc/systemd/system/
install -m 0644 hosted/systemd/alert-watch.service             /etc/systemd/system/
install -m 0644 hosted/systemd/alert-watch.path                /etc/systemd/system/

# ── scripts the units execute ────────────────────────────────────────────────
# The units call these by absolute path from /usr/local/bin. Without them
# every one of those units fails with "ExecStart= ... No such file".
#
# The group is postgres because three of these units run as postgres
# (brownhill-bootstrap.service, brownhill-backup.service,
# brownhill-backup-verify.service). They were installed root:root 0750, which
# postgres cannot execute: the unit failed with "Permission denied" and the
# schema was never applied by the service that exists to apply it. The
# operator could still run the script by hand as root, which is why the box
# has a schema at all — and why the failure was invisible until a reboot.
install -m 0750 -o root -g postgres hosted/bootstrap/brownhill-bootstrap.sh      /usr/local/bin/
install -m 0750 -o root -g postgres hosted/bootstrap/brownhill-backup.sh         /usr/local/bin/
install -m 0750 -o root -g postgres hosted/bootstrap/brownhill-backup-verify.sh  /usr/local/bin/
install -m 0750 hosted/bootstrap/brownhill-alert-forward.sh  /usr/local/bin/

# The migration ledger: the record of which migrations a database has applied,
# and the thing that makes the bootstrap safe to run on every boot. The
# bootstrap script sources it, so it has to be where the script can find it
# whether the repository is checked out or not. It is not a secret — it is
# shell and SQL — so it is world-readable.
install -d -m 0755 /usr/local/lib/brownhill
install -m 0644 standalone/scripts/schema-ledger.sh /usr/local/lib/brownhill/schema-ledger.sh

# restore.sh is NOT called by a unit — it is spawned by absolute path from the
# restore console (src/app/admin/restore/route.ts), and exercised by
# hosted/tests/chaos/03-mid-restore-crash.sh. It was missing from this list,
# so the operator's "restore this backup" button failed with ENOENT every
# single time, and the chaos drill failed before it began.
install -m 0750 hosted/bootstrap/restore.sh                   /usr/local/bin/

# The portability suite's gate 16b calls /usr/local/bin/verify-restore.sh.
# That is the same script as the weekly verify timer — one implementation,
# installed under both names, so the drill and the timer can never drift.
install -m 0750 -o root -g postgres hosted/bootstrap/brownhill-backup-verify.sh  /usr/local/bin/verify-restore.sh

# The restore console runs restore.sh as root, because the restore stops and
# starts the application and the data API around itself. This is the only
# thing the application account may run as root, and only this one script —
# the script itself accepts only a well-formed backup id and refuses to touch
# the database until it has proved the dump is readable.
install -m 0440 /dev/stdin /etc/sudoers.d/brownhill-restore <<'SUDOERS'
# Managed by hosted/bootstrap/install.sh. The restore console runs
# /usr/local/bin/restore.sh as root; nothing else may.
brownhill ALL=(root) NOPASSWD: /usr/local/bin/restore.sh *
SUDOERS
visudo -c -f /etc/sudoers.d/brownhill-restore >/dev/null

# ── the alert-marker directory ──────────────────────────────────────────────
# /run is a tmpfs, so the directory is empty after every reboot. The path
# unit cannot watch a directory that does not exist, and the nightly backup
# runs as postgres and cannot create one under /run — /run belongs to root.
# systemd-tmpfiles creates it at every boot.
install -m 0644 hosted/systemd/brownhill-alerts-tmpfiles.conf \
  /etc/tmpfiles.d/brownhill-alerts.conf
systemctl-tmpfiles --create /etc/tmpfiles.d/brownhill-alerts.conf

# ── the database ─────────────────────────────────────────────────────────────
# A box with no database is a box with no application, and this script used
# to leave it exactly that way. It created no cluster, applied no password to
# the postgres role and wrote no pg_hba.conf, while the app's DATABASE_URL
# carries a password that nothing had ever set. The very first sign-in on a
# freshly installed box failed with "password authentication failed" for a
# reason that had nothing to do with the operator.
PGDATA=/var/lib/postgresql/16/main
PGPORT_NUM=55432

if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  echo "==> creating the Postgres cluster at $PGDATA"
  install -d -m 0700 -o postgres -g postgres "$PGDATA"
  # --data-checksums is an initdb flag: it records `data_checksums = on` in the
  # cluster's own configuration, which is where the server reads it from.
  runuser -u postgres -- /opt/brownhill/pgsql/bin/initdb \
    -D "$PGDATA" \
    --username=postgres \
    --auth-local=peer \
    --auth-host=scram-sha-256 \
    --data-checksums
fi

# Start it, so the superuser password can be applied to a live role.
systemctl enable --now postgresql.service
for _ in $(seq 1 30); do
  if runuser -u postgres -- /opt/brownhill/pgsql/bin/pg_isready \
       -h /var/run/postgresql -p "$PGPORT_NUM" -q; then
    break
  fi
  sleep 1
done

# Apply the superuser password. PG_SUPERUSER_PASSWORD in pg.env is a
# convention this project invented; Postgres has never heard of it, so
# nothing set the role's password and every password-authenticated
# connection was refused.
pg_pw=$(grep '^PG_SUPERUSER_PASSWORD=' /etc/brownhill/secrets/pg.env | cut -d= -f2-)
runuser -u postgres -- /opt/brownhill/pgsql/bin/psql -v ON_ERROR_STOP=1 -v pw="$pg_pw" <<'SQL'
ALTER ROLE postgres PASSWORD :'pw';
SQL

# ── PostgREST configuration ──────────────────────────────────────────────────
# Renders the config from the secrets just written above. The file is owned by
# the group the postgrest account is in, because postgrest.service runs as
# that account and the account needs to read it.
hosted/bootstrap/install-postgrest-conf.sh
chown root:brownhill /etc/brownhill/postgrest.conf
chmod 0640 /etc/brownhill/postgrest.conf

# ── enable ───────────────────────────────────────────────────────────────────
systemctl daemon-reload

# The database and the one-shot schema bootstrap. The database was already
# enabled and started above, where its cluster was created and its superuser
# password applied.
systemctl enable postgresql.service
systemctl enable brownhill-bootstrap.service

# The data API. Started after Postgres, so it waits for the socket.
systemctl enable postgrest.service

# The app itself. It is enabled, not started: there is no build at
# /var/lib/brownhill/app until hosted/scripts/deploy-app.sh has run, and a
# unit whose ExecStart path does not exist just restart-loops.
systemctl enable brownhill-next.service

# The timers.
systemctl enable --now brownhill-backup.timer
systemctl enable --now brownhill-backup-verify.timer
systemctl enable --now brownhill-certbot-renew.timer

# The disk-space alert. A .path unit watches for a marker file; the marker is
# written by the backup script when /var/backups fills up.
systemctl enable --now alert-watch.path

echo "=== Brownhill provisioning complete."
echo "=== Next: deploy the app with hosted/scripts/deploy-app.sh,"
echo "===       then issue the certificate with hosted/bootstrap/initial-cert.sh."
