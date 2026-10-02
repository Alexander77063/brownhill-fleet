#!/usr/bin/env bash
set -euo pipefail
# hosted/bootstrap/install.sh — first-time provisioning.
# Idempotent: re-running on a partially-built host must not fail.

mkdir -p /etc/brownhill/secrets
chmod 0750 /etc/brownhill/secrets

# secrets — only write if absent
if [[ ! -f /etc/brownhill/secrets/pg.env ]]; then
  pg_pw=$(openssl rand -hex 32)
  cat > /etc/brownhill/secrets/pg.env <<EOF
PG_SUPERUSER_PASSWORD=$pg_pw
EOF
  chmod 0640 /etc/brownhill/secrets/pg.env
fi
if [[ ! -f /etc/brownhill/secrets/jwt.env ]]; then
  jwt=$(openssl rand -hex 64)
  cat > /etc/brownhill/secrets/jwt.env <<EOF
JWT_SHARED_SECRET=$jwt
EOF
  chmod 0640 /etc/brownhill/secrets/jwt.env
fi
if [[ ! -f /etc/brownhill/secrets/bootstrap.env ]]; then
  bs=$(openssl rand -hex 32)
  cat > /etc/brownhill/secrets/bootstrap.env <<EOF
BOOTSTRAP_TOKEN=$bs
EOF
  chmod 0640 /etc/brownhill/secrets/bootstrap.env
fi

# copy units
install -m 0644 hosted/systemd/postgresql.service           /etc/systemd/system/
install -m 0644 hosted/systemd/postgresql.service.d/override.conf /etc/systemd/system/postgresql.service.d/
install -m 0644 hosted/systemd/brownhill-bootstrap.service   /etc/systemd/system/

# install the production bootstrap script (Task 3 creates the script body;
# this is what the systemd unit Brownhill-bootstrap.service runs).
install -m 0750 hosted/bootstrap/brownhill-bootstrap.sh /usr/local/bin/

# render the PostgREST configuration (closes deviation 4).
# Uses envsubst + the secrets just written above.
hosted/bootstrap/install-postgrest-conf.sh

systemctl daemon-reload
systemctl enable --now postgresql
# bootstrap.service starts after postgresql is up via After=; just enable here.
systemctl enable brownhill-bootstrap.service
