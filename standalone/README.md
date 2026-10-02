# Standalone build (Brownhill Fleet)

The self-hosted product: one tenant, running on the customer's own Windows
machine, shipped as an installer. No Supabase, no Vercel, no internet required.

Design: [`docs/superpowers/specs/2026-09-01-two-product-redirection-design.md`](../docs/superpowers/specs/2026-09-01-two-product-redirection-design.md)

## Why it is shaped this way

The application makes **370 PostgREST-style `.from()` calls across 64 files**,
plus 25 `.rpc()` calls. Rewriting that data layer for a different client would be
rewriting the app. So the standalone build **keeps the PostgREST wire protocol**
and swaps only the two things that are genuinely Supabase-hosted services:

| Concern | Hosted product | Standalone |
|---|---|---|
| Data access | Supabase (PostgREST) | **PostgREST** — unchanged, 370 call sites untouched |
| Database | Supabase Postgres | Plain PostgreSQL, bundled |
| Identity | Supabase Auth (GoTrue) | Local auth, HS256 JWT that PostgREST validates |
| Object storage | Cloudflare R2 | Local disk (`src/lib/storage/local.ts`) |
| Scheduled jobs | Vercel cron | In-process scheduler |

## The security model is not weakened

Migration `0016_tenancy.sql` resolves the current user as
`coalesce(current_setting('app.user_id'), auth.uid())` — the GUC **first**,
`auth.uid()` only as a fallback. That was written deliberately for a
direct-Postgres deployment.

So RLS enforces **identically**, with every policy unchanged. That is a strong
claim, so it is tested rather than asserted:

```bash
bash standalone/scripts/verify-portability.sh
```

This stands up a throwaway `postgres:16`, applies the shim and all 62
migrations **unmodified** from empty, and then proves:

| | Assertion |
|---|---|
| −1 | The app's own `handle_new_user()` trigger populates `profiles` from `raw_user_meta_data` |
| 0 | The harness runs as `authenticated`, so RLS is actually enforced (not bypassed as table owner) |
| 1 | `current_app_user()` resolves from the GUC with no Supabase present |
| 2 | A user sees exactly their own tenant |
| 3 | Domain tables (`vehicles`) are scoped too, not just the tenancy tables |
| 4 | Changing `app.user_id` changes the enforced scope |
| 5 | An identity-less caller sees **zero** rows — it fails closed, not open |
| 6 | A cross-tenant **write** is refused |
| 7 | `service_role` **does** bypass RLS — otherwise every cron job silently returns nothing |
| 8 | JWT claims flow through `auth.pre_request()` into the RLS GUCs |
| 9 | End-to-end: a verified JWT scopes a real query to one tenant |

## Building the installer

```powershell
pwsh -File standalone/scripts/package.ps1
```

That builds the Next.js standalone server, assembles the payload, fetches the
bundled binaries, and produces the installer at
`standalone/tauri/src-tauri/target/release/bundle/nsis/`. **That `.exe` is the
file to send to Brownhill.**

## Code signing

An unsigned installer is not merely "shows a warning". On the machine this was
developed on, **Norton 360 silently deleted the .exe on write** — copying it to
Downloads or the Desktop failed with access denied and the file was simply gone.
Mail gateways strip unsigned executables too. An unsigned build can quietly fail
to arrive.

The build signs automatically once a certificate is configured. Set **one** of:

```powershell
# A certificate in the Windows store — the mode for a USB hardware token.
$env:BF_SIGN_THUMBPRINT = "A1B2C3…"        # spaces are fine; they are stripped

# Or an external signer, for cloud signing services. %1 is the file.
$env:BF_SIGN_COMMAND = "azuresigntool sign -kvu https://… -kvc … -tr http://timestamp.digicert.com -td sha256 %1"
```

then `powershell -File standalone/scripts/package.ps1` as usual.

Set `BF_REQUIRE_SIGNED=1` for anything you are actually going to send someone:
the build then refuses to start unsigned rather than producing an installer you
might ship by mistake. Both misconfigurations — no certificate, or a thumbprint
that is not in the store — fail in the first second, not after ninety minutes.

Signing is **verified after the build** with `signtool verify /pa`, and a build
that was told to sign but did not fails. Tauri reports success either way, and
an installer you believe is signed but is not is worse than one you know is
unsigned, because you would send it.

### What to buy

Since June 2023 the private key for a publicly trusted code-signing certificate
must live on certified hardware or in a cloud HSM — a plain `.pfx` file is no
longer issued. That leaves two shapes:

| | Roughly | Notes |
|---|---|---|
| **Azure Trusted Signing** | ~$10/month | Cheapest sane option. Cloud HSM, no token to lose. Requires a verified organisation with 3+ years of history, or use their individual tier. Use `BF_SIGN_COMMAND`. |
| **OV certificate + USB token** | ~£200–400/year | Sectigo, DigiCert and others. A physical token posted to you; it must be plugged into the build machine. Use `BF_SIGN_THUMBPRINT`. |
| **EV certificate** | ~£350–600/year | Same as OV but clears SmartScreen reputation immediately rather than earning it over time. Worth it if the first impression matters. |

An **OV** certificate stops the antivirus deletions and names you as the
publisher, but SmartScreen may still warn until the certificate builds
reputation across a few hundred installs — which, for a product going to one
customer, may never happen. **EV** skips that. For a single-customer hand-off,
EV is the one that actually removes the blue box on day one.

Timestamping is not optional and is always applied (`http://timestamp.digicert.com`,
override with `BF_SIGN_TIMESTAMP_URL`). Without it the signature stops validating
the day the certificate expires, and a customer installing in two years is back
to the warning you paid to remove.

### Why NSIS and not MSI

MSI was the first choice and it does not work here. WiX's `light.exe` is not
long-path aware, and the payload contains pnpm's virtual store —
`node_modules/.pnpm/next@15.5.20_@playwright+te_49ff63f…/node_modules/next/dist/…`
— which crosses 260 characters. Every one of those files fails with
`LGHT0103: The system cannot find the file`, naming files that are plainly
there.

NSIS handles the depth, and a double-clickable `.exe` is a better answer to
"an app I can send them" than an MSI anyway. It installs per-user, so no
administrator prompt.

Prerequisites (the script checks them rather than assuming): Rust with the MSVC
toolchain, Node 22+, pnpm. Windows 11 already ships the WebView2 runtime the
shell renders with.

**Install dependencies with `pnpm install --node-linker=hoisted` before building.**
`next build` with `output: standalone` reproduces pnpm's virtual store by
*symlinking* it, and Windows refuses that with `EPERM` unless the process is
elevated or Developer Mode is on — five minutes into the build, as a wall of
"Failed to copy traced files" warnings ending in one fatal error that reads like
a Next.js bug rather than a machine setting. A hoisted `node_modules` has no
store to link, needs no privilege, and is the flat layout the standalone output
has to end up as anyway to be portable. `package.ps1` now checks for this
combination up front and refuses to start rather than failing late.

### What ends up inside

```
Brownhill Fleet_0.1.1_x64-setup.exe
├─ bin/pgsql/        PostgreSQL 16.4 (portable binaries, trimmed 967 MB → 123 MB)
├─ bin/postgrest.exe PostgREST 12.2.3
├─ bin/node/node.exe Node 22.11
├─ app/              the Next.js standalone server
├─ migrations/       all 62 .sql files, unmodified
└─ sql/              the Supabase shim
```

Versions are pinned. An installer that silently picked up a new major
PostgreSQL would be an unannounced, irreversible migration on a customer's
machine.

Nothing in `standalone/tauri/runtime/` is committed — it is ~300 MB of upstream
release archives, fetched at package time by `fetch-runtime.ps1`.

## What the customer does, once

Double-click the installer, then open Brownhill Fleet. The first launch takes a
couple of minutes — it is creating a database and applying every migration — and
reports each step.

It then opens **first-run setup**: business name, their name, email, password.
That creates the owner account and the single tenant, and signs them in.

This exists because a self-hosted install has no other way in: there is no
Supabase dashboard, no invite email and no seeded password. Setup runs exactly
once — `createFirstUserAndTenant` refuses if any account exists, so the endpoint
cannot be replayed to mint a second owner.

## What the shell does at launch

1. Creates data folders under `%APPDATA%\BrownhillFleet` and generates the
   per-install secrets on first run.
2. Initialises the PostgreSQL cluster if absent (`--data-checksums`, because
   this database lives on a desk and will lose power eventually).
3. Starts PostgreSQL on `127.0.0.1:55432` and waits for a **real query**, not
   `pg_isready` — which answers yes while the server is still starting.
4. Applies any migrations not in the ledger, each in one transaction, recorded
   in that same transaction. First failure aborts the launch: an app pointed at
   a half-migrated database corrupts data; an app that refuses to start does not.
5. Starts PostgREST with `PGRST_DB_PRE_REQUEST=auth.pre_request`, which is what
   makes RLS enforce.
6. Starts the Next.js server with `DEPLOYMENT_PROFILE=standalone`.
7. Takes a backup, then shows the app.
8. Runs the scheduled jobs on a one-minute tick, and backs up nightly.

Ports are deliberately non-default (55430–55432): a fleet operator's PC may
already run Postgres, and colliding with it would be a confusing first-run
failure. Everything binds to loopback.

## Contents

| Path | Purpose |
|---|---|
| `tauri/src-tauri/src/supervisor.rs` | Job-object process supervision — the reason the shell is Tauri, not Electron |
| `tauri/src-tauri/src/database.rs` | Cluster creation, readiness, the migration ledger, backup and restore |
| `tauri/src-tauri/src/scheduler.rs` | The 5 scheduled jobs, with catch-up. Has its own tests |
| `tauri/src-tauri/src/runtime.rs` | Paths and per-install secret generation |
| `tauri/splash/index.html` | Startup progress, and a readable error if it fails |
| `scripts/package.ps1` | One command, from source to the NSIS installer |
| `scripts/fetch-runtime.ps1` | Downloads the pinned third-party binaries |
| `sql/0000_supabase_shim.sql` | Supplies what the migrations assume Supabase provides: the `anon`/`authenticated`/`service_role` roles, the `auth` schema (`users`, `uid()`, `role()`, `pre_request()`), the `storage` schema, and `auth.local_credentials` for local passwords. Runs once, before `0001`. |
| `sql/portable-rls-proof.sql` | The eleven assertions above. |
| `scripts/apply-migrations.sh` | Applies shim + every migration in order, each in its own transaction, halting at the first failure. This is the migration runner the installer uses. |
| `scripts/verify-portability.sh` | One-command end-to-end proof. |
| `scripts/reset-test-db.sh` | Drops the schemas so a run starts from genuinely empty. |

## Why migrations are never edited

The shim adapts the *environment* to the migrations, never the reverse. One
schema history for both products means a fix in either is a fix in both, and an
install running an edited or skipped migration set would drift out of support —
which for a system on someone else's hardware is not recoverable remotely.

## Not built yet

**Corrected 2026-09-16.** This list had gone stale in the direction that matters
most — it named two things as outstanding that had in fact shipped, which is
exactly the kind of note that gets believed. Items 1 and 2 below were previously
listed here as unbuilt. They are built:

- **Local auth** is wired. `src/lib/auth/{local-store,local-session,owner-signin}.ts`
  back `/api/auth/local/setup`, and `src/lib/auth/context.ts` branches on
  `deploymentProfile().supabaseAuth`. Note it was delivered by profile-branching
  inside the existing client (`src/lib/supabase/{server,middleware}.ts`), **not**
  by the design's 8-verb `AuthAdapter` — that type does not exist, so do not go
  looking for it.
- **PostgREST `db-pre-request`** is wired at `tauri/src-tauri/src/main.rs:253`
  (`PGRST_DB_PRE_REQUEST=auth.pre_request`).

What is genuinely outstanding, tracked in the design doc as SP-2:

1. **Restore from inside the app** — `Database::restore` is written but
   `#[allow(dead_code)]`; the shell exposes no `invoke_handler`, so there is no
   command surface to call it from. **Mitigated, not closed:** the delivery now
   ships `delivery/tools/Restore-Backup.cmd`, which drives the bundled
   `pg_restore` with the same flags, takes a safety dump of the current data
   first, and is round-trip tested. In-app restore remains the real fix.
2. **Signed auto-update** — Tauri's updater, with a pre-update backup and a
   rollback if migrations fail. Nothing is configured today: `tauri.conf.json`
   declares no updater and there is no plugin. Shipping a new version means
   sending a new installer, which is why the version number now moves with every
   build that leaves this machine.
3. **Offline degradation** — DVLA lookups, payments, email/SMS, telematics and AI
   must all fail soft with a clear in-app state. Today they will surface as
   errors rather than as a calm "unavailable offline". Documented for the
   customer in `delivery/READ ME FIRST.txt` §10 in the meantime.
4. **A signing certificate** — the **machinery** is built (`scripts/signing.ps1`,
   `BF_SIGN_THUMBPRINT` / `BF_SIGN_COMMAND`, `BF_REQUIRE_SIGNED`, and a
   post-build `signtool verify /pa`). What is missing is the certificate itself,
   which is a purchase and an identity check, not a code change. Until then the
   installer is unsigned and SmartScreen warns on first run.

## Handing a build to a customer

`delivery/` holds everything that goes with the installer:

| Path | Purpose |
|---|---|
| `delivery/READ ME FIRST.txt` | The customer-facing manual: install, first run, backups, restore, password reset, what needs internet, moving machines, uninstall. |
| `delivery/tools/Restore-Backup.{cmd,ps1}` | Supported recovery path. Refuses to run while the app is open, takes a safety dump first, requires the word RESTORE. |
| `delivery/tools/Reset-Password.{cmd,ps1}` | Sets a new sign-in password on the machine itself. There is no reset email and no server to send one, so without this a forgotten password is permanent. |
| `delivery/tools/hash-password.mjs` | Produces the scrypt hash in the app's own format. **Must stay in step with `src/lib/auth/password.ts`** — if those parameters change, a reset password would be written in a form the app cannot verify. |

`tools/` is bundled into the installer as a Tauri resource, so it lands at
`%LOCALAPPDATA%\Brownhill Fleet\tools` and cannot be lost with the zip.

**Bump the version for every build that leaves this machine.** There is no
auto-update and no telemetry, so the version string in `tauri.conf.json`,
`tauri/package.json` and `src-tauri/Cargo.toml` is the only way to know what a
customer is running when they call.
