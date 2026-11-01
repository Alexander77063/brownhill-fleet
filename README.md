# Brownhill Fleet

Self-hosted fleet management on your own Linux VPS.

This repository is the **Brownhill-only mirror** of the upstream
[`Alexander77063/elite-fleet-management`](https://github.com/Alexander77063/elite-fleet-management)
project. SaaS-only paths have been removed; what remains is everything
needed to deploy and operate the Brownhill Fleet hosted installation on a
Namecheap Business VPS Pulsar (Ubuntu 24.4.4 LTS).

## Start here — operator handoff

See **[`HANDOFF-BROWNHILL.md`](./HANDOFF-BROWNHILL.md)**. That document is
the full, ordered, idempotent procedure: prereqs, the five secrets you own,
`install.sh`, `fetch-runtime.sh`, the schema-bootstrap systemd unit, the
nginx/certbot config, the Backblaze B2 backup path, and the acceptance
script. Read it through before running anything.

## What's in this repo

| Path | What it is |
| --- | --- |
| `src/` | The Next.js 15 application (the same source as the SaaS; `DEPLOYMENT_PROFILE=hosted` gates SaaS-only code paths out at compile time) |
| `hosted/` | The Linux deployment — bootstrap, systemd units, nginx config, runtime fetcher, brand assets, the acceptance bar |
| `supabase/` | SQL migrations (Postgres schema history, applied by `brownhill-bootstrap.service` on first run) |
| `standalone/sql/0000_supabase_shim.sql` | The schema shim that lets the migrations apply cleanly to plain Postgres (Supabase Auth is replaced by local HS256 JWT) |
| `standalone/README.md`, `standalone/CODE-SIGNING.md` | Architecture documentation (kept for context) |
| `standalone/scripts/verify-portability.sh` | Proves the schema applies cleanly to plain Postgres with RLS intact |
| `HANDOFF-BROWNHILL.md` | The operator handoff doc — the entry point |
| `docs/runbook/`, `docs/testing/` | Operational references |
| `docs/product/` | The product foundation set — PRD, TRD, MVP scope, user flow, design system, schema, monetisation, launch, acquisition, growth. Start at [`docs/product/README.md`](./docs/product/README.md) |
| `.github/workflows/hosted-smoke.yml` | CI for the hosted stack (runs on `ubuntu-latest`; the production-shaped job is opt-in, on the self-hosted `pulsar` runner) |
| `.github/workflows/unit-tests.yml` | CI for typecheck + unit tests (runs on `ubuntu-latest`) |

## What's NOT in this repo (and why)

These paths existed in the upstream repo but were stripped for this mirror
because they aren't part of the Brownhill-hosted deployment:

- `standalone/tauri/`, `standalone/delivery/`, `standalone/scripts/*.ps1` — Windows Tauri installer (different deployment shape, not used here)
- `docs/superpowers/`, `docs/accessibility/`, `docs/business/` — internal planning, SaaS-only docs. **`docs/product/` is the exception: it is kept, because it describes this deployment**
- `tests/`, `.github/workflows/{ci,migrate-production}.yml` — SaaS CI
- `.claude/`, `.serena/`, `.vercel/`, `.sops.yaml`, `.env*` — local dev secrets, agent config

## Where the rent-to-buy lives

The rent-to-buy product — the calculator, the two rates, and the governance
report — is described in [`docs/product/01-prd.md`](./docs/product/01-prd.md)
and specified in [`docs/product/02-trd.md`](./docs/product/02-trd.md) §7. The
engine is `src/lib/rtb-calculator.ts`; the report is `src/lib/reports/`; the
investor's portal is `/investor`.

## Sync model

Periodic squash from `elite-fleet-management` `main`. SaaS-only paths are
stripped at sync time; what remains is the latest Brownhill-relevant code.

## Source of truth

This is a mirror. The canonical source is
[`Alexander77063/elite-fleet-management`](https://github.com/Alexander77063/elite-fleet-management).
Bug fixes and changes land there first and are then squashed here.
