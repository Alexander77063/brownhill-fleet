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

### Migration files need care at sync time

The migration set is the one place where this mirror deliberately differs
from upstream, and a naive squash will undo it.

`elite-fleet-management` `main` carries three accounting migrations that
this mirror must not take:

- `0069_accounting_nigeria_tenant_scoping.sql`
- `0070_accounting_reopen_window_per_tenant.sql`
- `0071_accounting_per_tenant_thresholds.sql`

They are the Nigeria tenant-scoping migrations. The integration plan that
brought the accounting module into this mirror says explicitly: *"Do NOT
re-add 0069–0071 (Nigeria-specific)"*. They break this single-tenant UK
product in six places — they rename `mtd_credentials` to
`firs_credentials`, drop the unique constraints this codebase's
`on conflict (year, month)` and `on conflict (period_id)` depend on, and
add `tenant_id` columns nothing populates.

Upstream also still carries two defects this mirror has fixed: `0064`
(`DEFERRABLE` on a plain trigger, which is a syntax error on PostgreSQL 16)
and `0068` (a `coalesce` of `text` and `uuid`). Both are fixed here; both
need fixing upstream too, or the next sync reintroduces them.

After any sync, run the schema gate before deploying:

```bash
bash hosted/tests/schema-gate.sh
```

It builds the schema from zero on a throwaway `postgres:16` using this
repository's own provisioning script and proves the RLS isolation holds.
It is the same check CI runs on every pull request.

## Source of truth

This is a mirror. The canonical source is
[`Alexander77063/elite-fleet-management`](https://github.com/Alexander77063/elite-fleet-management).
Bug fixes and changes land there first and are then squashed here — with
the exception noted above: the accounting-migration fixes in this mirror
should go upstream first, or a sync will revert them.
