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
nginx/certbot config, the Backblaze B2 backup path, and the 5-gate
acceptance script. Read it through before running anything.

## What's in this repo

| Path | What it is |
| --- | --- |
| `src/` | The Next.js 15 application (the same source as the SaaS; `DEPLOYMENT_PROFILE=hosted` gates SaaS-only code paths out at compile time) |
| `hosted/` | The Linux deployment — bootstrap, systemd units, nginx config, runtime fetcher, brand assets, the 5-gate acceptance test |
| `supabase/` | SQL migrations (Postgres schema history, applied by `brownhill-bootstrap.service` on first run) |
| `standalone/sql/0000_supabase_shim.sql` | The schema shim that lets the migrations apply cleanly to plain Postgres (Supabase Auth is replaced by local HS256 JWT) |
| `standalone/README.md`, `standalone/CODE-SIGNING.md` | Architecture documentation (kept for context) |
| `standalone/scripts/verify-portability.sh` | Proves the schema applies cleanly to plain Postgres with RLS intact |
| `HANDOFF-BROWNHILL.md` | The operator handoff doc — the entry point |
| `docs/runbook/`, `docs/testing/` | Operational references |
| `.github/workflows/hosted-tests.yml` | CI for the hosted acceptance script |

## What's NOT in this repo (and why)

These paths existed in the upstream repo but were stripped for this mirror
because they aren't part of the Brownhill-hosted deployment:

- `standalone/tauri/`, `standalone/delivery/`, `standalone/scripts/*.ps1` — Windows Tauri installer (different deployment shape, not used here)
- `docs/superpowers/`, `docs/accessibility/`, `docs/business/`, `docs/product/` — internal planning, SaaS-only docs
- `tests/`, `scripts/`, `.github/workflows/{ci,migrate-production}.yml` — SaaS CI
- `.claude/`, `.serena/`, `.vercel/`, `.sops.yaml`, `.env*` — local dev secrets, agent config

## Sync model

Periodic squash from `elite-fleet-management` `main`. SaaS-only paths are
stripped at sync time; what remains is the latest Brownhill-relevant code.

## Source of truth

This is a mirror. The canonical source is
[`Alexander77063/elite-fleet-management`](https://github.com/Alexander77063/elite-fleet-management).
Bug fixes and changes land there first and are then squashed here.
