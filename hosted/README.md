# Hosted Brownhill Fleet (Namecheap Pulsar)

This directory is the runtime operation of Brownhill Fleet as a single-tenant web app on Namecheap Business VPS Pulsar, instead of the Tauri NSIS Windows installer that ships the standalone product. Same code, same migrations, same RLS — different process supervisor and network surface.

## Running the stack locally

```bash
docker compose -f hosted/dev/docker-compose.yml up -d --build
```

**`--build` is not optional.** `docker compose up` reuses an existing `dev-next`
image whenever one is present, so a stack that was brought up before a source
change keeps running the *old* bundle — and every assertion afterwards is
testing yesterday's code, not the change you just made. This is not
hypothetical: the Edge middleware bundle was found still running the previous
implementation for exactly this reason.

The stack provisions itself. The `bootstrap` service runs the real
`hosted/bootstrap/brownhill-bootstrap.sh`, which applies the shim and every
migration and creates `app_state`; the `next` service waits for it to exit
cleanly, so the app never starts against a half-built schema.

The bootstrap records what it applied in `public.schema_migrations`, so
running it again applies nothing. That matters because the production
equivalent is a systemd oneshot that runs on **every boot**: without the
ledger it applied the whole history from the top each time and died on
migration `0001` (`create type user_role` has no guard), so the unit exited 3
on every boot after the first. `hosted/tests/hosted-bootstrap-idempotency.sh`
is the gate that proves the re-run is a no-op, and it runs the real script
against a real postgres.

A box that was provisioned before the ledger existed can be adopted with
`--baseline-through=FILE`, which claims FILE and every migration before it.
The claim is **checked** against the database — the tables, enum types and
functions those migrations create have to be really there — and refused if it
is not. The check happens before anything is written, so a refused baseline
leaves the database exactly as it was. `brownhill-bootstrap.sh --status`
reports what the ledger sees and which file to baseline through; it does not
touch the application's schema.
The full procedure is in
[`docs/runbook/brownhill-namecheap-deploy-2026-10-07.md`](../docs/runbook/brownhill-namecheap-deploy-2026-10-07.md).

```bash
# what is up
docker compose -f hosted/dev/docker-compose.yml ps -a

# the app          → http://127.0.0.1:55431
# PostgREST       → http://127.0.0.1:55430
# PostgreSQL      → postgres://postgres@127.0.0.1:55432/postgres
# nginx (TLS)     → https://127.0.0.1
```

To start clean from an empty database:

```bash
docker compose -f hosted/dev/docker-compose.yml down -v
docker compose -f hosted/dev/docker-compose.yml up -d --build
```

## Port layout

| Port | Service             | Notes                                |
| ---- | ------------------- | ------------------------------------ |
| 55432 | PostgreSQL 16.4    | loopback only                        |
| 55430 | PostgREST 12.2.3    | loopback only; bound to 127.0.0.1    |
| 55431 | Next.js (hosted)    | loopback only; bound to 127.0.0.1    |
| 443   | nginx + Let's Encrypt | the only port open to the public  |

These are non-default ports by design — a fleet operator's PC may already run Postgres and colliding with it is a confusing first-run failure. The same convention is preserved from the standalone installer.

## Secret paths

Secrets live on the VM at `/etc/brownhill/secrets/`, mode `0640`, owned `root:brownhill` — the shared service group that the `postgres`, `postgrest` and `brownhill` accounts all belong to:

- `pg.env` — `PG_SUPERUSER_PASSWORD`
- `jwt.env` — `JWT_SHARED_SECRET` (used by both PostgREST and Next.js)
- `bootstrap.env` — `BOOTSTRAP_TOKEN` (HMAC key for the first-run `/api/v1/bootstrap` endpoint)
- `backup.env` — `BACKBLAZE_B2_*` (off-host backup credentials) and
  `BROWNHILL_FQDN` (the path prefix inside the bucket — the deployment's
  hostname, and the source of `NEXT_PUBLIC_APP_URL`)
- `app.env` — the application's own run-time environment (`DATABASE_URL`,
  `BOOTSTRAP_TOKEN`, `POSTGREST_URL`, `NEXT_PUBLIC_APP_URL`). Written by
  `hosted/bootstrap/write-app-env.sh`, which `install.sh` and
  `substitute-fqdn.sh` both call. **Rewritten on every install**, so a
  rotated database password takes effect on the next one.
- `cron.env` — `CRON_SECRET`, the bearer token the scheduled jobs present.
  The cron routes are exempt from the session middleware (a scheduled call
  carries a token and no cookie), so `isCronAuthorized` (`src/lib/cron.ts`)
  is the only thing in front of the job that raises invoices — and it fails
  closed: with `CRON_SECRET` unset and `NODE_ENV=production`, every
  `/api/cron/*` call answers 401. Created empty by `install.sh`, which
  generates the value if the file is not there; the operator may pre-place
  their own. **The secret and the timers below are two halves of one fix** —
  neither is enough alone.
- `mtd.env` — the HMRC Making Tax Digital credentials
  (`HMRC_MTD_CLIENT_ID`, `HMRC_MTD_CLIENT_SECRET`, `HMRC_MTD_REDIRECT_URI`,
  `HMRC_ENV`), the VAT registration number a return is filed against
  (`HMRC_MTD_VRN` — the installation's default, adopted by the first tenant
  to connect and by no other), and the endpoint (`HMRC_MTD_BASE_URL`, empty =
  HMRC's own).
  Created empty by `install.sh`; the operator fills it in.
  Optional — without it the application starts and the HMRC page says the
  connection is not configured.

These are generated by `hosted/bootstrap/install.sh` on first provisioning and never committed. Each one is written through a temporary file that is narrowed to `0640` and then **moved** into place, so the path a service reads is never occupied by a world-readable file, not even for the length of the write.

## The scheduled jobs

On the SaaS the scheduled jobs run on Vercel Cron: `vercel.json` names the path
and the schedule, and Vercel calls it with `Authorization: Bearer
$CRON_SECRET`. The hosted box has no Vercel — and until these timers were
installed it had no replacement either, so **nothing called them at all**.

That is not a cosmetic gap. `/api/cron/generate-rent` is what raises the
weekly rent invoice, and `/api/cron/complete-agreements` is what stops a
finished agreement being billed for another week. With neither running,
Brownhill's books stay empty: no invoice, no revenue in the ledger, no VAT on
the return, nothing ageing on the receivables — and an agreement that has
ended keeps billing.

Eight systemd timers call one template service, `brownhill-cron@<slug>.service`,
which runs `hosted/scripts/brownhill-cron.mjs` — the only thing on the box
that knows how to present the secret. The ninth route in `vercel.json`
(`subscription-lifecycle`) is the SaaS's billing lifecycle and is switched off
on the hosted profile, so it has no timer.

| Job | Schedule | What it does |
| --- | --- | --- |
| `generate-rent` | Mon 06:00 | Raises the week's rent invoices and posts them to the ledger |
| `complete-agreements` | daily 05:00 | Ends agreements that have run their course, so they stop billing |
| `sweep-obligations` | daily 07:00 | Sweeps the obligations that are due |
| `send-reminders` | daily 07:30 | Sends the notification sweep |
| `vat-snapshot` | quarterly, 1 Jan/Apr/Jul/Oct 08:00 | Snapshots the VAT position for the return |
| `owner-reports` | monthly, 1st 06:00 | Writes the owner reports |
| `device-health` | hourly | Checks the telematics devices |
| `escalations` | every 5 minutes | Works the escalation ladder |

Every schedule is the `vercel.json` one, translated to `OnCalendar`. Every
timer is `Persistent=true`, so a box that was off over a weekend catches up
rather than silently skipping the rent run.

**The caller is node, not curl.** The box's runtime is pinned and installed
before the app is deployed (`hosted/scripts/fetch-runtime.sh`), and the app
itself runs on it — but curl is not something the installer puts on the box,
so a script that assumed curl would fail on a box the installer had just
finished building. The script uses nothing but node's own `http` module.

**The secret never travels on the command line.** The unit reads
`/etc/brownhill/secrets/cron.env` as root and hands it to the script in the
environment; `/proc/<pid>/cmdline` is world-readable on Linux, so a secret
passed as an argument would be readable by every account on the box for the
length of the run.

**A missing `cron.env` fails the unit loudly.** It is not marked `optional`.
A cron job that started without a secret would answer 401 on every call and
look, in the journal, like a job that simply had nothing to do.

Running one by hand, with the same environment the unit has:

```bash
systemctl start brownhill-cron@generate-rent.service
journalctl -u brownhill-cron@generate-rent.service -n 50

# or, out of systemd, with the secret in the environment:
CRON_SECRET="$(sudo cat /etc/brownhill/secrets/cron.env | cut -d= -f2)" \
  /opt/brownhill/node/bin/node /usr/local/lib/brownhill/brownhill-cron.mjs generate-rent
```

The caller reaches the application on the loopback at
`http://127.0.0.1:55431` — the same port the deployed unit sets
(`Environment=PORT=55431`) and the compose stack publishes, so one default
serves both. `CRON_BASE_URL` overrides it when a box answers somewhere else.
The script refuses to run without a secret, refuses a slug that is not a
slug, and exits non-zero on a non-2xx answer — so `systemctl status` shows a
failed unit rather than a green one that did nothing.

`hosted/tests/cron-timers.sh` is the gate that holds all of this to its
promise: every route the profile enables has a timer, every timer names a
route that exists, every schedule matches `vercel.json`, every timer is
`Persistent=true`, and the unit reads the secret from a file rather than the
command line. `hosted/tests/cron-timers-negative.sh` runs it against copies
of the tree carrying the faults it exists to catch.

## Verifying the hosted stack

```bash
# Static gates — no docker, no database, about a second each.

#   The ledger's fingerprint sees every kind of object a migration creates —
#   tables, enum types and functions. It is what lets the bootstrap REFUSE a
#   baseline that claims more than the database actually has, instead of
#   believing it and leaving the schema silently broken.
bash hosted/tests/schema-ledger-fingerprint.sh

#   One spelling for every BROWNHILL_* setting, every setting that is read
#   is provided by something, and every setting that is provided is read by
#   something. A variable that is set under one spelling and read under
#   another is not a failure — it is silence.
bash hosted/tests/env-var-names.sh

#   The settings the application reads — the HMRC credentials and the
#   deployment's own address — are provided by the installer, under the
#   names the application reads them by, and the handover tells the
#   operator those same names. It also proves the application's address
#   follows the deployment's FQDN, and that a rotated database password
#   reaches the application.
bash hosted/tests/mtd-env-wiring.sh

#   That gate's negative case: four copies of the tree, each carrying one
#   of the faults the gate exists to catch, and the gate has to fail on the
#   right check for each.
bash hosted/tests/mtd-env-wiring-negative.sh

#   That a build only serves the surfaces it actually has — and that the
#   gate saying so can fail.
#
#   The table that decides which URL prefixes a deployment profile does not
#   serve had NO call site anywhere in the repository: it was complete,
#   correct-looking, and never consulted. On the hosted build that left the
#   cross-tenant console (/platform), the SaaS's own signup form
#   (/request-access) and the subscription API reachable on a box that must
#   serve none of them.
#
#   `tests/unit/deployment-gate.test.ts` is the boundary, and this is its
#   negative case: the test is run against a gate that blocks nothing and
#   against one that blocks everything, and each has to fail on the right
#   family of checks. Needs the dependencies installed (`pnpm install`) —
#   it runs the unit suite, not a shell gate — but no docker, no database
#   and no stack.
bash hosted/tests/deployment-gate-negative.sh

#   That the box's credentials are never readable by anybody else — not even
#   for the length of the write.
#
#   The installer writes five credentials onto the box, and each one used to
#   be written straight to its final path and narrowed afterwards, so for the
#   length of the write the credential sat where the services read it from,
#   empty, in whatever mode the process umask gave it: 0644, readable by
#   every account on the box.
#
#   The writer now goes through a temporary file and a rename, so the path a
#   reader uses only ever holds a file that is already complete and already
#   narrowed. This gate watches that path WHILE the write is in progress and
#   requires every observation of it to be the whole secret, at mode 0640.
#
#   It needs no docker, no database, no secrets and no stack. On a file
#   system that does not honour permissions — Git Bash on Windows — the two
#   mode checks are skipped out loud rather than passing quietly.
bash hosted/tests/secret-file-permissions.sh

#   That gate's negative case: three copies of the tree, each carrying one
#   of the faults the gate exists to catch, and the gate has to fail on the
#   right check for each.
bash hosted/tests/secret-file-permissions-negative.sh

#   Where the nightly dump is filed when it leaves the box, what a box
#   provisioned before the rename does, and what happens when the hostname
#   is not set at all.
bash hosted/tests/backup-offhost-target.sh

#   The portability proof's OWN guards. The proof decides whether a
#   deployment is fit to hand over, so its guards have to be trustworthy —
#   and four of them could never pass. The backup assertion asked for
#   `systemctl` rather than for the Brownhill unit, so it failed on any
#   machine that was not the deployed box; the HTTPS assertion passed `-k`
#   (skip verification) AND `--cacert` together, which made the CA
#   decorative; the tenant assertion loaded `jsonwebtoken`, which this
#   project does not depend on, so it skipped itself everywhere; and the
#   off-host assertion synced to a bucket named "test" instead of reading
#   the box's own recorded state.
#
#   A guard that can never pass is not a guard — a skipped assertion looks
#   exactly like a passing one in a build log. This gate holds them to
#   their promises: off the box they skip and the proof still exits 0; on
#   the box a missing backup unit FAILS; a job told it must be on the box
#   FAILS when it is not; the CA the HTTPS assertion verifies against is
#   really tracked in git; the proof loads nothing the project does not
#   have; and the token it presents carries the claims the application
#   itself mints. Hermetic — no docker, no database, no stack.
bash hosted/tests/portability-guards.sh

# Smoke run: confirms nginx serves HTTPS, the bootstrap endpoint contracts
# hold, RLS still enforces, and the backup + restore-verify paths are real.
bash hosted/tests/verify-hosted-portability.sh

#   The chain assertion's negative case. Assertion 14 verifies nginx's
#   certificate chain; this runs the proof against the live stack with a CA
#   that signed nothing and requires the proof to FAIL on assertion 14.
#   Needs the stack up.
bash hosted/tests/tls-assertion-negative.sh

# End-to-end fresh-deploy smoke.
bash hosted/tests/smoke/hosted-smoke.sh

# Migration regression: replays the shim + 84 migrations against an empty
# postgres:16 in a container and asserts the original nine RLS proofs hold.
bash hosted/tests/migrations-regression.sh

# A re-run of the bootstrap applies nothing — the property the systemd
# oneshot depends on, because it runs on every boot.
bash hosted/tests/hosted-bootstrap-idempotency.sh

# The CI step that waits for the stack's bootstrap can actually FIND it.
# `docker compose ps` lists only the project's RUNNING containers, so a
# oneshot that has already exited is invisible to it — and a bootstrap that
# has exited is exactly what the step is looking for. The hosted smoke's
# wait step did exactly that on 2026-10-31 and failed a job whose
# bootstrap had applied all 81 migrations and exited cleanly.
bash hosted/tests/bootstrap-wait.sh

# Five-gate acceptance — run before declaring shippable.
bash hosted/tests/acceptance.sh
```

### The database-backed suites

Two suites need a real postgres. Both check for `DATABASE_URL` and **skip out
loud** when it is absent — a skipped check and a passing check look the same in
a build log, and these are worth knowing about.

```bash
# The stack's own postgres, published on the loopback. It authenticates with
# trust, so the URL carries no password.
export DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres

# The ledger's atomicity, against the real schema. A balanced entry commits
# with every one of its lines and its audit row; an unbalanced one commits
# NOTHING — no entry, no lines, no audit row; and the same unbalanced entry
# written WITHOUT a transaction really does leave an orphan entry behind.
#
# That third case is the one that keeps the other two honest: it reproduces
# the old behaviour on purpose and asserts the orphan appears, so the first
# two cannot be passing for the wrong reason.
#
# It exists because `accounting.journal_lines` carries a DEFERRED balance
# trigger, which only means anything at COMMIT. The bridge used to write its
# entry, its lines and its audit row as three separate autocommitted
# statements, so the trigger fired after the first line, judged it alone, and
# rejected the entry — while the entry row, already committed, stayed behind
# as an orphan. The reconciliation queue's "mark as a VAT payment" and "mark
# as a bank fee" buttons both failed that way, and the MTD VAT return never
# reached the ledger at all.
pnpm test:integration

# The accounting schema's tenant isolation. No browser-facing role can reach
# the schema at all; row-level security is enabled on every tenant-scoped
# table; every one of them carries the restrictive `tenant_isolation` policy
# and the two sets are exactly the same set; the audit log has no permissive
# policy that could rewrite it; and a member of one tenant sees none of
# another's ledger, while a caller with no identity at all sees nothing.
#
# The last two checks are the negative controls. They drop the restrictive
# policy — inside a transaction, so it comes back with the rollback — and
# require the isolation to leak, and they add a permissive DELETE policy and
# require the audit trail to go. Without them the checks above could pass
# against policies that do nothing, which is exactly what migrations 0068 and
# 0069 shipped.
pnpm test:rls
```

Both suites create their own tenants, users and rows and remove them
afterwards. `pnpm test` includes them too, so with `DATABASE_URL` set the whole
suite runs against the database.

**In CI they run in the `hosted-smoke` job, not the `unit-tests` job.** The
`unit-tests` job has no database, so there they skip. The `hosted-smoke` job
brings the compose stack up, so its test step is given the stack's own
`DATABASE_URL` and the two suites really execute. That job's `paths` filter
used to name the schema, the scripts and the hosted box — and nothing under
`src/` — so a change to the ledger's own code never brought the job up, and
the database-backed tests never ran in CI at all. The filter now names the
accounting module, the API routes under it, the database helper and the two
test directories.

## Backup adapter

Off-host backups default to Backblaze B2 (S3-compatible, ~$0.005/GB/month, no egress fees within NA/EU). The adapter interface lives at `src/lib/backup/managed.ts`:

```ts
interface OffHostTarget {
  push(localPath: string, remotePrefix: string): Promise<void>;
}
```

The default implementation is `backblazeB2`. Switching to another target is one file — implement `OffHostTarget` and swap the binding in `hosted/bootstrap/install.sh`.

## Update (v1)

```bash
ssh brownhill-host
cd /opt/brownhill/repo
git pull origin main
./hosted/scripts/deploy-app.sh
```

`deploy-app.sh` does the whole job: `pnpm install --frozen-lockfile`, the
standalone hosted build, copying the output into `/var/lib/brownhill/app`
(the systemd unit's `WorkingDirectory`), and restarting the service.

**Do not hand-run the build and restart the unit instead.** Two things make
that sequence deploy nothing:

- The build must be a **standalone** build. `output: 'standalone'` is what
  produces the `server.js` the unit runs, and it is also what enables the
  `/rest/v1 → PostgREST` rewrite that every `.from()` call in the app reads
  its data through. Without it the app starts and then cannot reach its own
  database.
- The build output must be **copied** to `/var/lib/brownhill/app`. Building in
  the repository and restarting the service leaves the service running the
  *previous* build, and the update looks like it worked.

The script keeps the previous build at `/var/lib/brownhill/app.previous` until
the new one is in place, and prints the rollback command if the restart fails.

**The build removes its own output directory first, and that is load-bearing.**
`next build` clears `.next` at the start, using a routine that walks *into*
directory symlinks. A standalone build leaves `node_modules` in that
directory as symlinks back into the project's own `node_modules`, so the
second build in the same tree deleted the real packages: the directories
survived, empty, and every import through them failed with "Cannot find
module". On a box with no other checkout above it, that took the deployment
down — and the operator's documented update is a build, so the second update
of a live installation would have broken it. `hosted/scripts/build-app.mjs`
now removes `.next` itself, through a routine that unlinks a symlink rather
than following it (`scripts/clean-dist-dir.mjs`), before Next starts.
`tests/unit/clean-dist-dir.test.ts` pins both halves: that Next's own clean
step really does empty the target, and that ours does not.

**The deployed tree stands on its own, and that is checked before it is
installed.** A standalone build writes `node_modules` into its output as
symlinks back into the *build checkout's* `node_modules/.pnpm` tree,
carrying the build machine's absolute path — so the tree that gets deployed
would resolve only while `/opt/brownhill/repo` was still there. The build
rewrites those links onto the copies the output already holds, as paths
relative to the link itself, so the deployed application stands alone
(`scripts/rebase-standalone-symlinks.mjs`). The deploy then checks the
staged tree independently and refuses to install it if any link still points
out of it.

The failure this prevents is sharp. An update's `pnpm install` can prune the
store directories the *previous* deployment's links point at, and the
previous deployment is still the one running at that moment — the staging
only happens after a successful build. Without the rewrite, an update that
failed at the build step took the running application down with it.

Restart PostgREST only if `postgrest.conf` changed:

```bash
systemctl restart postgrest.service
```

**A migration applied to a running box has to tell PostgREST about it.**
PostgREST reads the database schema once, at start-up, and caches it; it does
not poll. A PostgREST that was running before a migration was applied keeps
the old schema, and every write through it then fails — an INSERT answers 404
with an empty body, an RPC answers PGRST202, an embedded relationship answers
PGRST200. Reads keep working, because PostgREST falls through to the database
for a table it has never heard of, so the failure looks like a page that
renders with no data rather than like a broken database.

The bootstrap now sends `NOTIFY pgrst, 'reload schema'` when it finishes
applying migrations, which is PostgREST's own reload signal, so an update
needs no manual restart. `hosted/tests/postgrest-schema-cache.sh` asserts
that the notification is there, and that the compose stack starts PostgREST
only after the bootstrap has applied the schema — a fresh stack must not have
a cache of nothing.

In-app "click to update" is a v2 follow-up after the friction of the SSH+git-pull cycle is measured.

## Spec

The design this implementation builds against is `docs/superpowers/specs/2026-09-24-brownhill-hosted-on-namecheap-design.md`. The plan is `docs/superpowers/plans/2026-09-24-brownhill-hosted-on-namecheap.md`.
