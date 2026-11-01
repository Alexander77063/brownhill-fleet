# Heap snapshots from brownhill-next

This directory holds `node --heapsnapshot-signal` snapshots from
`/var/lib/brownhill/app/server.js` — the running Next.js standalone host.

## Why this exists

On 2026-10-14 the customer at info@brown-hillchauffeurs.co.uk could not log in. The Next process held the listen socket on `127.0.0.1:55431` but never accepted connections — event-loop wedge. Heap usage rises from ~21 MiB at start to ~73 of 75 MiB (97%) within seconds of process startup, with PM2 `active_handles` stuck.

The PM2 ecosystem (`/root/.pm2/ecosystem.config.cjs`) starts Node with
`--heapsnapshot-signal=SIGUSR2`, so a future engineer can grab a snapshot on demand:

```bash
pid=$(pm2 jlist | grep -oE '"pid":[0-9]+' | head -1 | cut -d: -f2)
kill -SIGUSR2 "$pid"
ls -la /var/lib/brownhill/app/Heap.*.heapsnapshot
```

Move fresh snapshots in here with `cp` so they survive the next redeploy
(`/var/lib/brownhill/app/` is rebuilt by `pnpm build:hosted` + the
`cp -a .next/standalone/. /var/lib/brownhill/app/` step in HANDOFF §4 D).

## Files

| File | Captured | Notes |
|---|---|---|
| Heap.20261014.132300.969147.0.001.heapsnapshot | 2026-10-14 13:23 UTC, during the active outage | 66 MiB; taken before the PM2 reconfigure. Compare against a healthy-build snapshot to identify the leak. |

## What to do with it

Open in Chrome DevTools ("Memory" tab → "Load heap snapshot"). Look for:

- Top-level retainers that grow on request (search "Retained Size" desc).
- Server Components / route handlers retaining module-scope caches.
- Closures inside auth routes (`src/app/api/auth/local/`).

The leak is referenced upstream as **SaaS issue #125** ("next.js event-loop wedge"). The same commit message that landed the brownhill 7301b26 patch notes the wedge began on/around Oct 9-13.

Do **not** delete files in this directory without a backup; the snapshots are not regenerated automatically and they are the only artifact of the live wedge.
