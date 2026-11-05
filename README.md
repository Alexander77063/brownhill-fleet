# Brownhill Fleet

Self-hosted fleet management on your own Linux VPS.

This repository began as the **Brownhill-only mirror** of the upstream
[`Alexander77063/elite-fleet-management`](https://github.com/Alexander77063/elite-fleet-management)
project. SaaS-only paths were removed; what remains is everything needed to
deploy and operate the Brownhill Fleet hosted installation on a Namecheap
Business VPS Pulsar (Ubuntu 24.4.4 LTS).

It is **not a mirror any more, and this repository is the one you are being
handed.** The upstream is private — Brownhill cannot reach it, and neither
can the box — and every change to the Brownhill deployment lands here
first. See [Source of truth](#source-of-truth) for what that means in
practice.

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
| `docs/accessibility/` | The accessibility programme — the audit, the VPAT, and what the runtime pass covers. Start at [`docs/accessibility/README.md`](./docs/accessibility/README.md) |
| `tests/a11y/` | The Playwright + axe runtime pass — 97 scans across 85 pages of the hosted build |
| `.github/workflows/hosted-smoke.yml` | CI for the hosted stack — the database-backed suites, the migration replay and the row-level-security proof (runs on `ubuntu-latest`; on every push to `main`, and on the pull requests that touch the code, the schema, the tests or the hosted box; the production-shaped job is opt-in, on the self-hosted `pulsar` runner) |
| `.github/workflows/unit-tests.yml` | CI for typecheck + unit tests (runs on `ubuntu-latest`; on every pull request and every push to `main`) |
| `.github/workflows/a11y.yml` | CI for the runtime accessibility pass — builds the hosted stack, seeds it and runs axe in Chromium (runs on `ubuntu-latest`; on every push to `main`, and on the pull requests that touch the code, the tests, the schema or the hosted box) |

## What's NOT in this repo (and why)

These paths existed in the upstream repo but were stripped for this mirror
because they aren't part of the Brownhill-hosted deployment:

- `standalone/tauri/`, `standalone/delivery/`, `standalone/scripts/*.ps1` — Windows Tauri installer (different deployment shape, not used here)
- `docs/superpowers/`, `docs/business/` — internal planning and SaaS-only docs. **`docs/product/` and `docs/accessibility/` are the exceptions: they are kept, because they describe this deployment**
- the SaaS integration suites under `tests/`, `.github/workflows/{ci,migrate-production}.yml` — SaaS CI. **`tests/unit/`, `tests/helpers/`, `tests/rls/` and `tests/a11y/` are the exception: they are kept, because they gate this deployment**
- `.claude/`, `.serena/`, `.vercel/`, `.sops.yaml`, `.env*` — local dev secrets, agent config

## Where the rent-to-buy lives

The rent-to-buy product — the calculator, the two rates, and the governance
report — is described in [`docs/product/01-prd.md`](./docs/product/01-prd.md)
and specified in [`docs/product/02-trd.md`](./docs/product/02-trd.md) §7. The
engine is `src/lib/rtb-calculator.ts`; the report is `src/lib/reports/`; the
investor's portal is `/investor`.

## Sync model

There is none, and there has not been for a while. This repository was
originally kept in step by a periodic squash from `elite-fleet-management`
`main`, with the SaaS-only paths stripped at sync time. **No workflow or
script in this repository performs that squash** — the `upstream` remote
exists only in a local clone — and it would be the wrong operation now in
any case: `main` here already carries **16 commits the upstream has never
seen**, and `feat/handover-hardening` carries **43** (those 16 among them).
Brownhill's deployment is maintained here.

If the upstream is ever brought back into use, it is a **merge into this
repository**, not a squash over the top of it.

## Source of truth

**This repository** —
[`Alexander77063/brownhill-fleet`](https://github.com/Alexander77063/brownhill-fleet) —
is the canonical source for the Brownhill deployment. It is public, it is
the repository [`HANDOFF-BROWNHILL.md`](./HANDOFF-BROWNHILL.md) tells you to
clone, and it is where every change to the deployment lands.

The upstream `elite-fleet-management` is where the SaaS product and the
shared code live, and parts of this codebase still come from it. It is
private, so it is context rather than a destination: report a defect here,
against this repository.
