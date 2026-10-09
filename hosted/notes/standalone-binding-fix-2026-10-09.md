# Standalone binding fix (2026-10-09)

When deployed to a Linux host with nginx in front of Next.js, the
brownhill-next service unit should bind to **127.0.0.1** so the app is
not reachable directly on its port. Without this, users who learn
the box's IP can hit the dev server on port 55431, see
`0.0.0.0:55431` in absolute URLs, and get 500s on /sign-out and other
actions that re-generate URLs from the request host.

## The unit change

The `hosted/systemd/brownhill-next.service` template in this repo now
includes `Environment=HOSTNAME=127.0.0.1`. After copying the file to
`/etc/systemd/system/brownhill-next.service` on the host, restart
with:

```bash
systemctl daemon-reload
systemctl restart brownhill-next
ss -tlnp | grep 55431   # expect: 127.0.0.1:55431  (not 0.0.0.0:55431)
```

## Firewall (defense in depth)

```bash
iptables -I INPUT 1 -p tcp --dport 55431 -s 127.0.0.1 -j ACCEPT
iptables -I INPUT 1 -p tcp --dport 55431 -j DROP
ip6tables -I INPUT 1 -p tcp --dport 55431 -j DROP 2>/dev/null || true
apt-get install -y iptables-persistent
netfilter-persistent save
```

## Why this lives in a note, not just the unit file

The unit file ships with the right default, but operators may have
local customisations. The iptables rules and the unit-file edit
should be applied by the deploy script on each new host.

## Found during
Brownhill standalone deploy on Namecheap Pulsar Quasar, 2026-10-09.
Customer hit the box's IP directly and saw `0.0.0.0:55431` in the
browser URL bar. Sign-out and other redirect-producing server actions
broke because the absolute URL base was the dev-server bind address.
