#!/usr/bin/env bash
# hosted/bootstrap/initial-cert.sh — obtain a Let's Encrypt cert for the FQDN,
# install the nginx configuration that serves the app, and substitute the
# placeholder with the operator's real hostname.
#
# Usage: initial-cert.sh <fqdn> [email]
#   example: sudo ./hosted/bootstrap/initial-cert.sh brownhill.example.co.uk ops@example.co.uk
#
# WHAT IT DOES, IN ORDER
# ----------------------
# 1. `certbot --nginx` issues the certificate. It has to run before our own
#    configuration is installed, because certbot --nginx edits whichever
#    server block nginx is already serving and it needs a working nginx to
#    complete the HTTP-01 challenge.
#
# 2. `substitute-fqdn.sh` replaces the placeholder in
#    `hosted/nginx/brownhill.conf` with the real hostname — in the
#    server_name and in the certificate paths.
#
# 3. THIS SCRIPT INSTALLS that configuration as `/etc/nginx/nginx.conf`.
#
#    It previously did not. The script edited the file in the repository and
#    then reloaded nginx, which kept serving the distribution's default site.
#    The site answered on :443 with a valid certificate and the wrong
#    content: `curl -I https://<fqdn>/` returned 200 — nginx's own welcome
#    page — so the check in the handover document passed while none of the
#    application was reachable. Nothing in the repository ever copied this
#    file into place.
#
# 4. `nginx -t`, and only then the reload. A reload of a broken
#    configuration leaves the previous one running and says nothing, so the
#    test has to come first.

set -euo pipefail
fqdn="${1:?fqdn required, e.g. brownhill.example.co.uk}"
email="${2:-ops@brownhill.example.co.uk}"

here="$(dirname "$0")"
config="$here/../nginx/brownhill.conf"

certbot --nginx -d "$fqdn" --redirect --agree-tos -m "$email" --no-eff-email

# Now that the real cert exists at /etc/letsencrypt/live/<fqdn>/, swap the
# placeholder in our nginx config so the server block serves the real hostname.
"$here/substitute-fqdn.sh" "$fqdn"

# ── install the configuration ────────────────────────────────────────────────
if [[ ! -f "$config" ]]; then
  echo "no nginx configuration at $config" >&2
  exit 1
fi

# Keep what is being replaced, so a rejected configuration is a one-liner to
# undo rather than an afternoon.
if [[ -f /etc/nginx/nginx.conf ]]; then
  cp -a /etc/nginx/nginx.conf /etc/nginx/nginx.conf.brownhill-previous
fi

# The distribution's own site. Our configuration does not include
# sites-enabled, so the default site is inert once ours is in place — but
# leaving it there means anyone who later adds that include back ends up
# with two server blocks claiming the same hostname.
rm -f /etc/nginx/sites-enabled/default

install -m 0644 "$config" /etc/nginx/nginx.conf

if ! nginx -t; then
  echo "nginx rejected $config; restoring the previous configuration." >&2
  if [[ -f /etc/nginx/nginx.conf.brownhill-previous ]]; then
    cp -a /etc/nginx/nginx.conf.brownhill-previous /etc/nginx/nginx.conf
  fi
  exit 1
fi

systemctl reload nginx
echo "nginx is serving $fqdn from $config"
