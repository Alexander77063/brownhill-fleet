# Traccar gateway — one per instance (NG-3)

**Why it exists.** Physical trackers speak binary protocols over TCP; Vercel cannot listen on a socket. Traccar is an
open-source GPS server that understands 200+ tracker protocols and forwards decoded positions and events to an HTTPS
URL. We run one per app instance so that **we** control the endpoint every device points at (growth G-05): a device is
re-pointed by us, never by a vendor. Decision: user, 2026-09-05 (NG-3 spec §1).

Verify every field name below against the Traccar version you deploy: this runbook was written from Traccar's
documentation and its long-stable JSON forwarding shape, not from a live instance. The app's parser is pinned by
fixture tests in `tests/unit/hardware-traccar.test.ts`; if the deployed version differs, change the fixture and the
parser together.

## 1. Host

A small always-on machine per instance — Fly.io is the assumed host (the same platform as the Amana backend), region
`jnb` (Johannesburg) or `ams`, whichever the trackers reach with lower latency in testing. Traccar publishes an official
Docker image (`traccar/traccar`). It needs:

- a persistent volume for its own database (H2 by default is fine for one instance; Postgres for anything past a few
  hundred devices — a Fly Postgres app or a managed one),
- the tracker ports exposed **TCP** publicly (each protocol has its own port; GT06 is 5023, Teltonika 5027 — see
  Traccar's ports list). Only expose the ports for the models you buy,
- the web/API port (8082) reachable **only** from the app (Fly private network, or a public port behind an IP allow
  list), never from the internet.

Steps (one instance):

```bash
fly launch --image traccar/traccar:latest --name traccar-<instance> --region jnb --no-deploy
fly volumes create traccar_data --size 3 --region jnb
# fly.toml: mount the volume at /opt/traccar/data; expose 5023/5027 (tcp) and 8082 (internal only)
fly deploy
```

## 2. `traccar.xml`

Mount a `traccar.xml` with, at minimum:

```xml
<entry key='forward.type'>json</entry>
<entry key='forward.url'>https://INSTANCE_HOST/api/gps/traccar</entry>
<entry key='forward.header'>X-Forward-Secret: FORWARD_SECRET</entry>
<entry key='forward.retry.enable'>true</entry>
<entry key='event.forward.type'>json</entry>
<entry key='event.forward.url'>https://INSTANCE_HOST/api/gps/traccar/events</entry>
<entry key='event.forward.header'>X-Forward-Secret: FORWARD_SECRET</entry>
<!-- the alarms NG-3 turns into service jobs must be enabled as events -->
<entry key='event.enable'>true</entry>
```

`FORWARD_SECRET` is a 256-bit random string (`openssl rand -base64 32`); the same value is `TRACCAR_FORWARD_SECRET` on the
app. Rotate both together.

## 3. API token for the app

Sign in to Traccar's web UI once as the admin, create an API token (Account → Token) with a long expiry, and set on the
app:

| App env | Value |
|---|---|
| `TRACCAR_URL` | `https://traccar-<instance>.internal:8082` (or the allow-listed public URL) |
| `TRACCAR_TOKEN` | the API token; sent as `Authorization: Bearer` |
| `TRACCAR_FORWARD_SECRET` | the shared header value from §2 |

`/platform/settings` → Readiness shows whether the app can reach Traccar (a `GET /api/server` probe) and whether stock
units are registered there.

## 4. Devices

The app registers each stock unit in Traccar when it is added to inventory (`POST /api/devices { name: IMEI,
uniqueId: IMEI }`), so a tracker is recognised the moment it powers up on the bench. Configure the units themselves
(usually by SMS command from the vendor's manual) to report to the Traccar host and the protocol port, with the SIM's
APN. A unit that pings before it is fitted shows as a **bench ping** on its inventory row — the installer's power-on
test, visible from the office.

## 5. What the app receives

Positions: Traccar posts JSON with `device` (`id`, `uniqueId`, `name`, `status`) and `position` (`latitude`,
`longitude`, `speed` in **knots**, `course`, `altitude`, `fixTime`, `deviceTime`, `serverTime`, `valid`, `attributes`:
`ignition`, `power`, `batteryLevel`, `odometer` in metres, `alarm`, …). The app converts speed and odometer, resolves
the IMEI to the fitted device, and ingests through the same path as a token ping.

Events: `event.type` values the app acts on — `commandResult` (immobilise acknowledgement, `attributes.result`),
`alarm` with `attributes.alarm` in `powerCut | tamper | lowBattery | removing` (raises a service job and tells the
customer), `deviceOnline` / `deviceOffline` (timeline only; the hourly sweep owns the owner's offline alert).

## 6. Immobilisation

The app sends `POST /api/commands/send { deviceId, type: 'engineStop' | 'engineResume' }` for a unit whose inventory
row says it has a relay. Traccar answers 200 (sent) or 202 (queued for the next heartbeat) and later forwards a
`commandResult` event. **Policy (user, 2026-09-05):** only a platform on-call admin executes, from
`/platform/assistance`, against an acknowledged emergency request, and the app refuses unless the vehicle's latest
position is recent and at or below the configured speed ceiling. Test both directions on a bench unit with a lamp on
the relay output before any customer vehicle.

## 7. Rotation, upgrades, rollback

- **Forward secret:** change `traccar.xml` and the app env in one change window; forwarded positions between the two
  steps are rejected with 401 and Traccar retries them (`forward.retry.enable`).
- **API token:** create the new token before revoking the old; swap `TRACCAR_TOKEN`; readiness confirms.
- **Traccar upgrade:** snapshot the volume, deploy the new image, watch one position arrive, then one event.
- **Rollback:** redeploy the previous image against the same volume. The app keeps working on the last known
  positions throughout; the only loss is the gap in tracking.

## 8. Costs and limits

One Fly machine (shared CPU, 512 MB–1 GB) plus a small volume per instance — recorded as monetisation cost line C7b.
Traccar handles thousands of devices on that footprint; the limit that bites first is the single `forward.url` per
Traccar, which is why there is one per instance (NG-3 spec §5.5).
