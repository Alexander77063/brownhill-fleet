# Brownhill Fleet — Hosted Operator Handoff

This document is what Brown's IT/dev team needs to take the **Brownhill Fleet hosted** product line — already merged to this repository's `main` branch — and run it on a Namecheap Business VPS Pulsar.

If anything in here is unclear, push back; otherwise step through it in order.

---

## Before you begin — two credentials must be rotated

This repository is **public**. Two credentials were once committed to it, so
both have to be treated as compromised and replaced before the customer uses
the system. Removing them from the working tree did not remove them from the
history, and the history is public — **rotation is the only fix.** Do this
first; everything below works with the rotated values.

| Credential | Where it was published | Rotate it |
| --- | --- | --- |
| The Postgres superuser password | `diag-verify.mjs` and `set-customer-password.mjs`, as a literal fallback for `DATABASE_URL` | Step 1 below |
| The customer's temporary login password | `HANDOFF-APPENDIX-C.md`, in the clear | Step 2 below |

### Step 1 — the database password

`/etc/brownhill/secrets/pg.env` is the source of truth. The password is
embedded in two more places that are rendered from it: `app.env`
(`DATABASE_URL`) and `postgrest.conf` (`db-uri`). The installer rewrites
both, so it does the whole rotation for you.

```bash
# 1. write the new password to the one file everything else is rendered from
NEW_PW="$(openssl rand -hex 32)"
echo "PG_SUPERUSER_PASSWORD=$NEW_PW" | sudo tee /etc/brownhill/secrets/pg.env >/dev/null
sudo chown root:brownhill /etc/brownhill/secrets/pg.env
sudo chmod 0640 /etc/brownhill/secrets/pg.env

# 2. re-run the installer. It is idempotent, and it will NOT regenerate a
#    secret file that already exists — so it picks up the new password and
#    re-renders app.env, postgrest.conf, and the role's password from it.
sudo ./hosted/bootstrap/install.sh

# 3. restart the two services that were holding the old connection string
sudo systemctl restart postgrest.service brownhill-next.service
```

The nightly backup and the boot-time schema bootstrap read the password from
`pg.env` every time they run, so they need no separate step.

Verify:

```bash
set -a; . /etc/brownhill/secrets/app.env; set +a
psql "$DATABASE_URL" -c 'select 1'
```

### Step 2 — the customer's login password

It was printed in `HANDOFF-APPENDIX-C.md`. The appendix says the customer has
no in-app way to change it, so this is very likely still their live
password. Reset it, and hand the new one over out of band.

```bash
# copy the operator scripts to the box — ALL THREE, together. They import
# each other, and the password script fails immediately and loudly if its
# import is missing.
sudo mkdir -p /opt/brownhill/auth
sudo cp auth-crypt.mjs set-customer-password.mjs diag-verify.mjs /opt/brownhill/auth/

# then, as the operator, on the box:
set -a; . /etc/brownhill/secrets/app.env; set +a
SET_PASSWORD='<a new value — not written down anywhere in git>' \
  node /opt/brownhill/auth/set-customer-password.mjs info@brown-hillchauffeurs.co.uk
```

`SET_PASSWORD` is preferred over a command-line argument: an argument is
visible to every process on the machine through `ps`, and it lands in the
shell's history. Give the new password to the customer **by phone**. Not by
email, not in a ticket, not in this repository.

Verify the new password against the row the app reads:

```bash
node /opt/brownhill/auth/diag-verify.mjs info@brown-hillchauffeurs.co.uk '<the new value>'
```

It must print `timingSafeEqual = true` and `derived.byteLength = 64`. If it
prints `false`, or a derived key that is not 64 bytes, stop — the scripts and
the app disagree about the row, and that is the first thing to look at.

---

## 1. What you are receiving

- A Next.js 15 application (`src/`) plus the Brownhill Fleet SQL schema (`supabase/migrations/` and `standalone/sql/0000_supabase_shim.sql`). The deployed binary lands under `/var/lib/brownhill/app/`.
- A Postgres 16.4 database (`auth`, `public`, `storage` schemas). The schema is fully created by the install scripts below; you do not run the migrations yourself.
- A PostgREST 12.2.3 instance exposing the SQL data over HTTP on `127.0.0.1:55430` (the app talks to it on loopback only).
- An HTTPS-only nginx reverse-proxy with HSTS, terminating on `:443`. TLS is by Let's Encrypt via `certbot`. There is no HTTP-only mode in production.
- A backup / restore path that writes locally to `/var/backups/brownhill/` and off-hosts to Backblaze B2 (S3-compatible).
- An acceptance script (`hosted/tests/acceptance.sh`) that proves the system is healthy before you call it shippable: five baseline gates, plus the accounting smoke and the no-credential scan when they apply.

The mainline product (Elite Fleet Management, multi-tenant SaaS) is in the same repo. **None of the SaaS-only code paths run on this deployment** — the `DEPLOYMENT_PROFILE=hosted` switch gates them out at compile time.

## 2. Prerequisites — what you must have before you begin

| What | Why |
| --- | --- |
| A Namecheap Business VPS Pulsar (or any 2 vCPU / 4 GB / 80 GB Ubuntu 24.04 LTS box). 4 GB RAM is sized for "a few dozen vehicles"; resize to 6 GB if the dataset grows. | The runtime is sized for that. |
| A registered **FQDN** (e.g. `brownhill.example.co.uk`) whose A/AAAA records already point at the Pulsar's public IP. The Let's Encrypt cert is issued against this name. | TLS issuance; the owner-facing URL. |
| An e-mail inbox the certbot registration can receive mail at. We use `ops@<your-fqdn>` for Let's Encrypt's terms-of-service mail; supply your own. | LE registration. |
| A Backblaze B2 bucket + application key with **list / read / write / delete** on that bucket. Recommended: a single-bucket setup named e.g. `brownhill-fleet-prod`. We'll create the application key in their web UI. | Off-host backup target. The default is B2; switching targets later is one file (`src/lib/backup/managed.ts`). |
| Root SSH access to the Pulsar box. | The install scripts all run as root because they touch `/etc/`, `/var/`, and `/usr/local/bin/`. |
| `curl`, `psql`, `openssl`, `certbot`, `nginx`, `systemd` are present on a typical Ubuntu 24.04 — the scripts assume they are, do not install them yourself. | Tools used by the bootstrap. |
| Someone to **own and operate** the deployed instance. | Restores, certificate renewal alerts, chaos drills — there is a recurring monthly checklist. |

You do **not** need Docker, a database server of your own, or any external monitoring service (a path-unit alert is on the box).

## 3. Five secrets you will own and seed into the box

These are generated on the box by `hosted/bootstrap/install.sh` if you don't pre-fill them, but production operations prefer a human-owned value. The five files are at `/etc/brownhill/secrets/` with mode `0640` and the corresponding service user as the owner. The format is the Linux convention `KEY=value` (one per file, since `set -a; source /etc/brownhill/secrets/*.env; set +a` is the standard way to load them).

| File | Variable | Use |
| --- | --- | --- |
| `pg.env` | `PG_SUPERUSER_PASSWORD` | Postgres superuser. Used by the running app and by the runtime fetcher. |
| `jwt.env` | `JWT_SHARED_SECRET` | HS256 secret that signs the issued access/refresh JWTs **and** verifies them at PostgREST. Same value on both sides by design. |
| `bootstrap.env` | `BOOTSTRAP_TOKEN` | HMAC key for the `/api/v1/bootstrap` first-run endpoint. Only used **once**, on the day the owner account is created. After that the row in `app_state` flips and the token is no longer accepted. |
| `backup.env` | `BACKBLAZE_B2_KEY_ID`, `BACKBLAZE_B2_APPLICATION_KEY`, `BACKBLAZE_B2_BUCKET` | B2 credential for nightly off-host backups. |
| `backup.env` (continued) | `BROWNHILL_FQDN` | The FQDN above; used as the B2 path prefix. |

`hosted/bootstrap/operator-secrets.example` is a template you can copy and fill in. Once filled, drop it onto the box at `/etc/brownhill/secrets/` (renamed to remove `.example`) before `install.sh`. The default behaviour is to **generate** secrets at install time if your file is absent.

## 4. First-deploy procedure (in order, idempotent)

> Run every step as root on the Pulse via `sudo bash -c '...'`. The order matters because the install step enables systemd units that the next step depends on.

### Step A — Pull the code

```bash
mkdir -p /opt/brownhill
cd /opt/brownhill
git clone https://github.com/Alexander77063/elite-fleet-management.git repo
cd repo
git checkout main
```

### Step B — Drop secrets (optional but recommended)

If you pre-generated `/etc/brownhill/secrets/{pg,jwt,bootstrap,backup}.env`, copy them to the box before step C. The `install.sh` script will see they exist and **not** regenerate them. If they are absent, the script will generate them with `openssl rand -hex` and print the values to its journal — capture them somewhere on the way out.

### Step C — Install the systemd units, secrets, and PostgREST config

```bash
sudo ./hosted/bootstrap/install.sh
```

What this does:

- Creates `/etc/brownhill/secrets/{pg,jwt,bootstrap}.env` if absent (mode 0640).
- Renders `/etc/brownhill/postgrest.conf` (mode 0640) from `hosted/bootstrap/postgrest.conf.template`.
- Copies `hosted/systemd/postgresql.service`, `postgresql.service.d/override.conf`, and `brownhill-bootstrap.service` into `/etc/systemd/system/`.
- Installs `hosted/bootstrap/brownhill-bootstrap.sh` to `/usr/local/bin/brownhill-bootstrap.sh`.
- Runs `systemctl daemon-reload` and enables `postgresql` (running) and `brownhill-bootstrap.service` (one-shot, idempotent).

It then prints:

```
=== Postgres $PG_VERSION (apt.postgresql.org)
[…]
=== Runtime ready at /opt/brownhill.
```

with the secrets laid out under `/etc/brownhill/secrets/`.

**Capture the secrets now** if you let install.sh generate them:

```bash
sudo cat /etc/brownhill/secrets/pg.env
sudo cat /etc/brownhill/secrets/jwt.env
sudo cat /etc/brownhill/secrets/bootstrap.env
```

You will need the bootstrap token during step F.

### Step D — Fetch the runtime binaries (PostgreSQL 16.4 + PostgREST 12.2.3 + Node 22.11)

```bash
sudo ./hosted/scripts/fetch-runtime.sh
```

If you also want to use the **Linux binary tarball** path for PostgreSQL (instead of the default apt path), set `PG_TARBALL_URL` and `PG_TARBALL_SHA256` in `hosted/scripts/runtime.sha256` before this step. The default is the apt install from `apt.postgresql.org`; both paths land binaries at `/opt/brownhill/pgsql/bin/`.

### Step E — Apply the schema (if not already done)

The `brownhill-bootstrap.service` one-shot unit runs `/usr/local/bin/brownhill-bootstrap.sh`, which:

1. Waits for Postgres to answer a real query.
2. Applies `standalone/sql/0000_supabase_shim.sql` (idempotent).
3. Applies every migration under `supabase/migrations/*.sql` in order, each in its own transaction.
4. Records what it applied in `public.schema_migrations` — the ledger.
5. Writes `app_state.bootstrap_pending='1'` **only if that row is not already there**.

This runs on the systemd `After=postgresql.service` ordering. To run it now:

```bash
sudo systemctl start brownhill-bootstrap.service
sudo journalctl -u brownhill-bootstrap.service --since '1 minute ago' --no-pager
```

The last log line should be `INSERT INTO app_state … ` and `exit 0`.

**You can re-run it as often as you like.** It is a no-op against a database
that is already provisioned: the ledger says what has been applied, and only
what has not been applied is applied. Before the ledger existed, a second run
died on migration `0001` — `create type user_role` has no guard — and the unit
exited 3 on every boot after the first. That is fixed, and
`hosted/tests/hosted-bootstrap-idempotency.sh` is the gate that proves it.

Two things worth knowing:

- **The first-run flag is a one-way door.** The bootstrap endpoint flips
  `app_state.bootstrap_pending` to `'0'` when you complete first-run setup
  (step H), and the bootstrap script does not set it back. Do not be surprised
  that `bootstrap_pending` is `'0'` on a system that has been set up — that is
  correct, and the first-run endpoint stays closed.
- **A database that was provisioned before the ledger existed** has to be
  adopted once, explicitly:

  ```bash
  sudo /usr/local/bin/brownhill-bootstrap.sh --baseline-through=<the last migration that HAS been applied>
  ```

  The option is inclusive: it claims the file you name **and** every
  migration before it. The script checks the claim against the database — the
  tables, enum types and functions those migrations create must actually be
  there — and refuses if they are not. The check happens **before anything
  is written**, so a refused baseline leaves the database exactly as it was:
  it is safe to try a cut, read the refusal, and try another.
  `brownhill-bootstrap.sh --status` reports every migration's state and the
  file to use; it does not touch the application's schema.

  The adoption is a **one-off**, not a setting. Once the ledger holds the
  history, the cut is no longer needed, and leaving it in place would
  re-assert the claim on every boot. The ledger records a baseline as
  `source='baseline'`, so the record says plainly that it was the operator's
  word rather than the script's work. The full procedure is in
  [`docs/runbook/brownhill-namecheap-deploy-2026-10-07.md`](docs/runbook/brownhill-namecheap-deploy-2026-10-07.md).

### Step F — Issue the Let's Encrypt cert and substitute the FQDN

```bash
sudo ./hosted/bootstrap/initial-cert.sh brownhill.example.co.uk ops@example.co.uk
```

What this does:

1. `certbot --nginx -d <fqdn> --redirect …` — issues the cert, saves it under `/etc/letsencrypt/live/<fqdn>/`.
2. `substitute-fqdn.sh` — `sed`-replaces the `brownhill.example.co.uk` placeholder throughout `hosted/nginx/brownhill.conf` with your actual FQDN. The seam is idempotent.
3. `systemctl reload nginx` — picks up the new server_name + cert paths.

After step F, **verify by hitting the live URL**:

```bash
curl -I https://brownhill.example.co.uk/
```

You should see HTTP 200 (the Next page returns a status) and `strict-transport-security` in the headers. If you see HTTP 302 to HTTPS, your Nginx `return 301 https://$host$request_uri;` is firing correctly — follow the redirect.

### Step G — Run the acceptance bar

```bash
sudo ./hosted/tests/acceptance.sh
```

This is the shippable definition (Spec §4.5.7). Five baseline gates always
run, and every gate that runs must return 0:

1. `DEPLOYMENT_PROFILE=hosted pnpm test` — the test suite under `DEPLOYMENT_PROFILE=hosted`.
2. `hosted/tests/verify-hosted-portability.sh` — runs assertions 0–17 against the live stack.
3. `hosted/tests/migrations-regression.sh` — replays the schema against a throwaway Postgres, replays portable RLS proof.
4. `hosted/tests/smoke/hosted-smoke.sh` — round-trips one `.from()` per major resource.
5. Sunday `brownhill-backup-verify.service` journal entry — restore from a fresh dump into a throwaway Postgres, row counts and RLS replay.

Two further gates are conditional, and the script says which it ran and which
it skipped:

6. *(opt-in)* the accounting smoke, when `accounting.chart_of_accounts` has
   rows — see Step A.5 below.
7. *(opt-in)* the no-credential scan, when this is a git checkout — which is
   what it scans. It checks that the tree you are handing over holds no
   password in plain text, and it runs the scan against a probe as well, so
   that you know the scan can fail. **This repository is public, and it has
   already published two credentials in plain text** (the box's database
   superuser password and the customer's login password). Both have been
   removed from the tree and both must be rotated on the box — that is
   **Before you begin**, at the top of this document, and it is not optional.

The bar is the number of gates that ran, not the number that passed: a
conditional gate that runs and fails raises the bar rather than quietly
dropping it.

Gate 5 won't have a journal entry on first deploy (no Sunday has passed). **Touch the service once manually to confirm the chain:**

```bash
sudo systemctl start brownhill-backup.service     # if you haven't already
sudo systemctl start brownhill-backup-verify.service
sudo journalctl -u brownhill-backup-verify.service --no-pager | tail -10
```

Then `acceptance.sh` gate 5 reports green.

If any gate fails, the script prints the offending output. The spec's monitoring section (§4.4) covers which failures close the surface vs. which keep serving with 502 / 503.

### Step H — Create the owner account (one-time first-run)

The `/api/v1/bootstrap` endpoint is reachable **only when `app_state.bootstrap_pending='1'`**, and only after presenting a valid HMAC signature with `BOOTSTRAP_TOKEN`. From the machine where you have `BOOTSTRAP_TOKEN` available:

```bash
TOKEN=$(sudo cat /etc/brownhill/secrets/bootstrap.env | cut -d= -f2)
NOW=$(date +%s)
BODY='{"email":"you@example.co.uk","password":"a-strong-password-of-12+chars","fullName":"Your Name","businessName":"Brownhill Fleet"}'
SIG=$(printf 'POST/api/v1/bootstrap'"$NOW""$BODY" | openssl dgst -sha256 -hmac "$TOKEN" | awk '{print $2}')

curl -sS -X POST \
  -H "x-bootstrap-t: $NOW" \
  -H "x-bootstrap-sig: $SIG" \
  -H 'content-type: application/json' \
  --data "$BODY" \
  https://brownhill.example.co.uk/api/v1/bootstrap | jq
```

The response is JSON with `access`, `refresh`, and `user.id`. Save the access token for browser use. **Subsequent calls return 410 Gone** because the bootstrap flag was flipped to 0.

After step H:

- `app_state.bootstrap_pending='0'` — bootstrap endpoint will not serve any future request.
- `app_state.app_draining='0'` — application is live.
- The owner can sign in via the regular `/api/auth/local/signin` endpoint from the same Pulse.

## 5. Ongoing operations

### Updates (v1 — SSH + git pull)

```bash
sudo bash -c 'cd /opt/brownhill/repo && git pull origin main \
  && ./hosted/scripts/deploy-app.sh \
  && systemctl restart postgrest.service'
```

`deploy-app.sh` performs the whole application update: `pnpm install
--frozen-lockfile`, the standalone hosted build, copying the output into
`/var/lib/brownhill/app`, and restarting `brownhill-next.service`.

Two things it does that a hand-run build does not, and that are why the
hand-run sequence deployed nothing:

- **The build must be standalone.** `output: 'standalone'` is what produces
  the `server.js` the unit runs, and it is also what enables the
  `/rest/v1 → PostgREST` rewrite every `.from()` call reads its data
  through. Without it the app starts and then cannot reach its database.
- **The output must be copied into `/var/lib/brownhill/app`.** Building in
  the repository and restarting the service leaves the service running the
  *previous* build.

The previous build is kept at `/var/lib/brownhill/app.previous` until the new
one is in place, and the script prints the rollback command if the restart
fails.

A future v2 will host an in-app "click to update" button (out of scope for this PR).

### Backups

- Nightly at 02:00 (`brownhill-backup.service.timer`) — local dump, then `b2 sync` to your bucket.
- Weekly verify at Sun 04:00 (`brownhill-backup-verify.service.timer`) — restore the latest dump into a throwaway Postgres, assert row counts + RLS.
- Local retention: 7 days. Off-host retention: 90 days (configurable via `brownhill.toml` if you add it).
- Local dump directory: `/var/backups/brownhill/`. Index at `…/_index.json` is what the `/admin/restore` UI reads.

### Restore

From the browser:

1. Sign in as owner.
2. Navigate to `/admin/restore`.
3. The endpoint lists dumps read from `/var/backups/brownhill/_index.json`.
4. Pick one, type `RESTORE` in the confirmation box, submit.
5. The middleware 503s everything except `/admin/*` until the swap completes; the app becomes live again when the dump and WAL are replayed and `app_draining` flips back to 0.

A failed restore leaves `app_draining='1'` and pages the operator (see next section).

### Alarms

- Path unit `alert-watch.path` watches `/run/brownhill/alerts/` for marker files.
- The back-up script writes `backup_sync_stale` if B2 hasn't succeeded in >24h.
- The verify script writes `backup_verify_failed` if the weekly restoration reports row counts below threshold.
- The certbot timer includes a deploy hook that reloads nginx; cron alarms are wired only at the marker-file layer in v1 — wire your actual page-out channel (Pushover / email / SMS) at `/usr/local/bin/brownhill-alert-forward.sh`.

### Chaos drills (monthly)

Run them on the live box — they are designed not to lose data:

```bash
sudo ./hosted/tests/chaos/01-power-loss.sh          # SIGKILL postgres, restart, RLS replay
sudo ./hosted/tests/chaos/02-postgres-restart.sh    # systemctl restart postgresql, time recovery, RLS
sudo ./hosted/tests/chaos/03-mid-restore-crash.sh   # corrupt dump, assert drain retained + alarm fires
sudo ./hosted/tests/chaos/04-b2-sync-stale.sh       # force b2 to fail, assert marker, restore, assert cleared
```

Log results in `hosted/tests/chaos/RUNS.md`. They are the proof the failure-mode guarantees in Spec §4.4 hold for your install.

## 6. Troubleshooting

| Symptom | First thing to check |
| --- | --- |
| `404 Not Found` on the live URL | `systemctl status nginx brownhill-next postgrest` — at least one is down. Check `journalctl -u <service> -n 50`. |
| `/api/v1/bootstrap` returns 401 | `BOOTSTRAP_TOKEN` mismatch. The token the script signs with must match `/etc/brownhill/secrets/bootstrap.env` byte-for-byte. Re-read it. |
| `/admin/restore` returns 503 | `app_state.app_draining='1'`. Read `hosted/README.md`'s section on alarms. The alert-watch path unit will have written a marker; clear it manually once the underlying issue is fixed and run `UPDATE app_state SET value='0' WHERE key='app_draining'`. |
| First-run page loads, but `.from()` calls return 0 rows | RLS is enforcing; signed in but no JWT `tenant_id` matches the path `/t/<tenant>/...`. The middleware will 403. Check the path is well-formed. |
| Backup "stale" alarm after 24h | `journalctl -u brownhill-backup.service` — most often a B2 credential issue. Re-source `/etc/brownhill/secrets/backup.env`. |
| `nginx -t` fails after certificate renewal | Usually the FQDN substitution was missed. Re-run `hosted/bootstrap/substitute-fqdn.sh <fqdn>`. |

## 7. Files and paths the operator owns

- `/etc/brownhill/secrets/{pg,jwt,bootstrap,backup}.env` — mode 0640, owned by `postgres`/`root` per file. Source of truth for runtime secrets.
- `/etc/brownhill/postgrest.conf` — rendered from `hosted/bootstrap/postgrest.conf.template`. Re-runnable.
- `/etc/nginx/nginx.conf` — overlay on top of `hosted/nginx/brownhill.conf`. The `substitute-fqdn.sh` script writes to the in-repo copy, which `install.sh` copies into `/etc/nginx/`. To customise beyond FQDN-cosmetic, edit the in-repo source and re-run the install.
- `/etc/systemd/system/{postgresql.service, postgresql.service.d/override.conf, brownhill-bootstrap.service, brownhill-next.service, postgrest.service, brownhill-backup.{service,timer}, brownhill-backup-verify.{service,timer}, alert-watch.{path,service}}` — managed by `install.sh` and the helper scripts.
- `/var/lib/brownhill/app/` — Next.js standalone build output. Rebuilt by the update procedure.
- `/var/lib/brownhill/static/` — favicons + PWA assets. Built from `hosted/brand/icon.svg` by `pnpm build:icons`.
- `/var/backups/brownhill/` — local backup directory (mount a larger volume here if your dataset grows past 50 GB).
- `/run/brownhill/alerts/` — alert-marker directory; `alert-watch.path` watches it.
- `/opt/brownhill/repo/` — the working copy of the codebase. `git pull` updates this.

## 8. Rollback

If a deploy goes wrong:

1. **Stop further failures.** `systemctl stop brownhill-next.service postgrest.service brownhill-backup.timer` — this freezes the running state without disrupting the DB.
2. **Restore the prior build.** `git log -5` to find the previous commit, `git checkout <sha>`, then `./hosted/scripts/deploy-app.sh` — it builds, installs into `/var/lib/brownhill/app` and restarts the service. (The service runs `node server.js` from that directory, so a build without the copy leaves the old build in place.)
3. **Only if the database is the problem**, use the UI at `/admin/restore` to replay the most recent good dump onto the live cluster. Take a fresh `pg_dump` first if you can (`pg_dump` through PostgREST works at `127.0.0.1:55430`).
4. **Don't roll back the schema.** The 53 SQL migrations are content-versioned forward-only. Restoring an old application build against a current schema is safe; restoring an old schema build against the current application data is not.

There is no automatic revert button. The paths above are exhaustive on purpose.

## 9. Versioning

- The repo's `main` carries the hosted product line. **Tag at deploy-time** so you can reproduce: `git tag brownhill-hosted-v1.0.0 && git push origin brownhill-hosted-v1.0.0`.
- Update only by `git fetch && git pull` on this tag (or on `main` if you accept the risk of new commits).
- Tag the deploy after each successful `hosted/tests/acceptance.sh`. A monthly review of the chaos-drill RUNS.md is recommended.

## 10. What's not in this handoff

- **Multi-instance / horizontally-scaled deployments.** Single-Pulsar is supported; multi-instance needs the operator to add a shared KV (Redis is the natural choice) for the `app_state.app_draining` signal. The Edge middleware reads the flag over HTTP from PostgREST as `anon`, against a one-row RLS policy; a second instance would need that flag served from somewhere both can reach. The abstraction is small.
- **External monitoring / paging.** Alert markers are written; the page-out (Pushover / email / SMS) is wired as an empty shim at `/usr/local/bin/brownhill-alert-forward.sh`. Wire that to your channel of choice.
- **In-app update button.** v1 is SSH + git pull. v2 will surface this in the operator UI.
- **Multi-tenant routing.** The hosted profile is single-tenant-by-deployment. A second Brownhill-style customer requires their own deploy.
- **Custom email / SMS / payment integrations.** The online-required integrations (DVLA, payments, SMS, telematics, AI) live off the smoke path. They fail soft — the UI says "DVLA lookups temporarily unavailable" instead of erroring. Wiring is unchanged from the standalone product.

---

End of handoff.

If anything here doesn't match what you shipped, that's a finding on this doc, not on the system — file a follow-up against `hosted/README.md` or your local adaptors. The system itself is on `main` at the SHA in `git rev-parse HEAD` of this checkout.

---

## Appendix A — Accounting module (opt-in)

If the in-app accounting module is enabled in your deploy (PR #89 + #90 + #91 + #92 + #93 + #94 land on `main`), the operator surface adds:

- `/admin/accounting/coa` — chart-of-accounts viewer (read-only).
- `/admin/accounting/periods` — period lifecycle (open / close / reopen within 7 days).
- `/admin/accounting/banks` — registered bank accounts + per-row Import CSV.
- `/admin/accounting/banks/[id]/import` — CSV/OFX upload + parsed preview + commit.
- `/admin/accounting/reconcile` — bank-transaction reconciliation queue.
- `/admin/accounting/reports/pnl?from=…&to=…`
- `/admin/accounting/reports/balance-sheet?as_of=…`
- `/admin/accounting/reports/cashflow?from=…&to=…`
- `/admin/accounting/reports/ar-aging?as_of=…`
- `/admin/accounting/reports/vat-return?period=YYYY-MM` — UK VAT return with all 9 boxes + Submit-to-HMRC.
- `/admin/accounting/mtd` — HMRC MTD connection settings + token status.

### Step A.1 — Register with HMRC MTD sandbox

1. Register an app at `developer.service.hmrc.gov.uk`.
2. Receive a `client_id` + `client_secret` + a `redirect_uri` (use `https://brownhill.<your-host>/admin/accounting/mtd/callback`).
3. Drop them onto the box at `/etc/brownhill/secrets/mtd.env`:
   ```
   MTD_CLIENT_ID=<client_id>
   MTD_CLIENT_SECRET=<client_secret>
   MTD_REDIRECT_URI=https://brownhill.<your-host>/admin/accounting/mtd/callback
   ```

### Step A.2 — Complete the OAuth consent (operator-paste-the-code in v1)

1. In the Brownhill app, navigate to `/admin/accounting/mtd` and click **Connect to HMRC**.
2. The consent screen redirects to HMRC; the operator signs in with their Government Gateway credentials and grants the app access to VAT filings.
3. On the consent screen's "code" parameter URL, copy the `code` value.
4. The app's callback handler (the SaaS team wires this) accepts the code and exchanges it for tokens via `submitVatReturn`'s `exchangeCodeForTokens`. Tokens are stored encrypted at rest via the AES-GCM / HKDF helpers in `src/lib/accounting/mtd.ts`.

### Step A.3 — Submit a VAT return

1. Navigate to `/admin/accounting/reports/vat-return?period=YYYY-MM`.
2. Review the box figures; if correct, click **Submit to HMRC**.
3. The submit handler calls `aggregateVatReturn` + `submitVatReturn` (the fail-safe flow): only on HMRC success is the §2 Rule #5 journal entry posted; on rejection or token expiry, no journal entry is written and the operator gets an inline error.

### Step A.4 — Reconcile bank statements

1. Export a CSV from your bank portal (the four formats supported v1: Barclays / HSBC / Starling / Lloyds — see spec §8 default 7).
2. Drop it on the box at `/var/brownhill/inbox/<bank>-YYYY-MM-DD.csv` (any readable path works).
3. The `/admin/accounting/banks/[id]/import` page reads the file, parses it, previews the rows with auto-match suggestions, and on commit runs the auto-matcher (90% threshold from spec §8 default 6).
4. Unmatched transactions go to `/admin/accounting/reconcile` for manual categorisation.

### Step A.5 — Verify the accounting gate

The acceptance script at `hosted/tests/acceptance.sh` runs **Gate 6 — the
accounting smoke** when `accounting.chart_of_accounts` has rows. It is
opt-in, so the bar is six gates with accounting enabled and seven with the
no-credential scan as well (see Step G). Every gate that runs must return 0
for the deploy to be shippable.

Run the chaos drills monthly:

```bash
sudo ./hosted/tests/chaos/05-vat-submit-rejected.sh
sudo ./hosted/tests/chaos/06-period-close-with-open-bank.sh
sudo ./hosted/tests/chaos/07-mid-period-void.sh
sudo ./hosted/tests/chaos/08-concurrent-period-close.sh
sudo ./hosted/tests/chaos/09-mtd-token-expiry.sh
```

---

End of handoff (with accounting appendix).
