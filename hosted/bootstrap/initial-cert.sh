#!/usr/bin/env bash
# hosted/bootstrap/initial-cert.sh — obtain a Let's Encrypt cert for the FQDN
# and substitute the placeholder in the nginx config so the prod config
# serves the real hostname.
#
# Usage: initial-cert.sh <fqdn> [email]
#   example: sudo ./hosted/bootstrap/initial-cert.sh brownhill.example.co.uk ops@example.co.uk

set -euo pipefail
fqdn="${1:?fqdn required, e.g. brownhill.example.co.uk}"
email="${2:-ops@brownhill.example.co.uk}"

certbot --nginx -d "$fqdn" --redirect --agree-tos -m "$email" --no-eff-email

# Now that the real cert exists at /etc/letsencrypt/live/<fqdn>/, swap the
# placeholder in our nginx config so the server block serves the real hostname.
"$(dirname "$0")/substitute-fqdn.sh" "$fqdn"

# Reload nginx so the new server_name + cert paths take effect.
systemctl reload nginx
