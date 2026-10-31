# Brownhill Fleet — product foundation

The ten documents every Brownhill Fleet project carries. This file is the
index: it says what each document is for, when it was last checked against
the code, and where its gaps are.

**Last audited against the code: 2026-10-31**, on `feat/rtb-calculator`
(fork `Alexander77063/brownhill-fleet`, base commit `dc6e043`). The migration
replay, the bootstrap idempotency gate, the environment-variable gate and the
bootstrap-waiter gate below were all run against a scratch Postgres on the
same date.

## The set

| # | Document | What it answers | Status |
| --- | --- | --- | --- |
| 1 | [PRD](./01-prd.md) | The problem, who has it, what we are building, why now | Current |
| 2 | [TRD](./02-trd.md) | Architecture, stack, integrations, constraints, the decisions and their reasons | Current |
| 3 | [MVP scope](./03-mvp-scope.md) | What ships first and what explicitly does not, and the line between them | Current |
| 4 | [User flow](./04-user-flow.md) | Every surface and actor, end to end, including the failure paths | Current |
| 5 | [Design system](./05-design-system.md) | Tokens, components, voice — one source, referenced not copied | Current |
| 6 | [Database schema](./06-database-schema.md) | Tables, relationships, invariants, and what the money model actually is | Current |
| 7 | [Monetisation](./07-monetisation.md) | Where revenue comes from, unit economics, what it costs to serve | **Partial — decisions pending** |
| 8 | [Launch plan](./08-launch-plan.md) | Sequence, gates, rollback, who is told what and when | **Partial — Stage 1 passed; Stages 2–5 open** |
| 9 | [User acquisition](./09-acquisition.md) | First users, channels, cost per user, the first hundred by name | **Blocked — needs the business's list** |
| 10 | [Growth plan](./10-growth.md) | Retention, the loop, the metric that matters, what breaks at 10× | **Decision document — see below** |

## What has been verified, and how

The difference between a document that says a thing is true and a document
that proves it. Each row below was run, not asserted.

| What | How | Status |
| --- | --- | --- |
| Migrations 0001–0082 apply from zero, in order, and the seed loads | A scratch `postgres:16` — the shim, all 81 migrations, then the RLS proof (14 assertions), the billing allocation proof (4 more) and the backfill proof over rows that already exist (7 more); the result was 85 public tables, 15 accounting tables and 10 public views, with 25 assertions on top. A third phase runs the **migration runner itself** against its own database: the first run applies the whole history, the second applies 0 migrations, and the ledger holds 82 rows | **Verified 2026-10-31** — `hosted/tests/migrations-regression.sh`, exit 0 |
| A voided invoice can never receive money, from any writer | `standalone/sql/billing-allocation-proof.sql` — four assertions: money can be allocated to an open invoice, an allocation to a void invoice is refused, an allocation cannot exceed the invoice's gross, and a payment cannot be spent twice. The proof **fails against 0001–0081** (the void assertion) and **passes against 0001–0082**, so it is a regression guard rather than a rubber stamp | **Enforced by CI** — the `hosted-smoke` job runs it on every PR that touches `supabase/migrations/**`, `standalone/sql/**`, `hosted/**` or `package.json` |
| Every tenant role maps to a portal role at signup | The signup trigger was exercised for all ten roles, including the `director_exec` → `accounts` case migration 0078 exists to fix | **Verified 2026-10-30** |
| `v_investor_rtb` returns the rent-to-buy book to an investor and to ops, and to nobody else | Live sessions run as `authenticated`, so row-level security was not bypassed | **Verified 2026-10-30** |
| The rent-to-buy backfill (0077) runs correctly over rows that already exist | The second phase of `hosted/tests/migrations-regression.sh` | **Enforced by CI** — the `hosted-smoke` job runs it on every PR that touches `supabase/migrations/**`, `standalone/sql/**`, `hosted/**` or `package.json` |
| The migration runner applies everything once, and then nothing | The third phase of `hosted/tests/migrations-regression.sh` — the runner against its own database, not a re-implementation of it | **Verified 2026-10-31** — the first run applies the whole history, the second applies 0 migrations, the ledger holds 82 rows |
| The four operator-only tables are closed to drivers and open to ops | Assertions 10–12 of `standalone/sql/portable-rls-proof.sql` — a driver reads their own damage report and none of the office's records; ops in that tenant still sees all four kinds of row; ops in another tenant sees none of them | **Enforced by CI** — the same job, on the same trigger paths |
| A spreadsheet is never handed a cell it would run | `tests/unit/csv.test.ts` and `tests/unit/rtb-format.test.ts` — the shared CSV writer refuses a cell starting `=`, `+`, `-`, `@`, tab or CR unless the cell is genuinely a number, and the rent-to-buy report's export is checked through it | **Verified 2026-10-30** — 43 unit tests green |
| The hosted bootstrap is a genuine no-op on a re-run | `hosted/tests/hosted-bootstrap-idempotency.sh` — runs the **real** `hosted/bootstrap/brownhill-bootstrap.sh` inside a real `postgres:16` against the real migration files. A first run applies the shim and all 81 migrations and records them; a second run applies nothing, exits 0 and leaves the schema fingerprint unchanged; a migration whose content changed after it was applied is **refused by checksum**, naming the file; a database provisioned before the ledger existed can be adopted, and a baseline that over-claims is refused — and a refused baseline leaves the database exactly as it was, because the claim is checked before anything is written. The gate fails against the pre-ledger script (`type "user_role" already exists`) — it was written before the fix and watched fail | **Enforced by CI** — 30 assertions, green 2026-10-31 |
| The deployment's settings are spelled one way, and are actually wired | `hosted/tests/env-var-names.sh` — asserts one spelling for every `BROWNHILL_*` variable, that everything the code **reads** is provided by something, that everything **provided** is read by something, and that the compose stack and the bootstrap script agree on the name of the repository override. A variable that is set under one spelling and read under another is not a failure — it is silence, and the script carries on with a fallback that works on the developer's machine and not on the box | **Enforced by CI** — 5 assertions, green 2026-10-31 |
| The ledger's fingerprint sees every kind of object a migration creates, and names them the way the database does | `hosted/tests/schema-ledger-fingerprint.sh` — the fingerprint is what makes a baseline **checkable** rather than merely asserted, so it has to see tables, enum types *and* functions. It used to see tables only: three greps shared one stdin, so the first consumed the whole stream and the other two matched nothing. The consequence was that a baseline claiming a migration creating only enums was **accepted** against an empty database — and the ledger then recorded it as applied, leaving the schema silently broken while the ledger said it was fine. Two more defects had the same shape: a function's name was read with its parameter list glued on (`fn_xp_vehicle` — a function that does not exist), and a table renamed by a later migration (`mtd_credentials` → `firs_credentials`) was reported missing against a database that has it. The gate now pins all three | **Enforced by CI** — 23 assertions, green 2026-10-31 |
| The CI step that waits for the bootstrap can actually **find** the bootstrap | `hosted/tests/bootstrap-wait.sh` — a step that waits for a compose oneshot has to be able to find it, and `docker compose ps` lists only the project's **running** containers. A oneshot that has exited is invisible to it — and a bootstrap that has exited is exactly what the step is looking for. The hosted smoke's wait step did exactly that on 2026-10-31, on the first run that job ever reached a runner: it failed a job whose bootstrap had in fact applied all 81 migrations and exited cleanly, with the bootstrap's successful output sitting in the log right beside the failure. The gate proves the defect is real, that the waiter finds an already-exited oneshot, that a failed one is reported with the service's own log, and that one that is still running is waited for | **Enforced by CI** — 11 assertions, green 2026-10-31 |

## Why this repo has no `docs/product/` upstream

The upstream project (`elite-fleet-management`) is the multi-tenant SaaS. This
repo is the **Brownhill-only mirror**: a single-tenant, self-hosted deployment
of the same application. The upstream keeps its planning documents private;
this repo ships the operator-facing ones (`docs/runbook/`, `docs/testing/`) and
now this product set.

Consequence worth stating plainly: **the SaaS monetisation model is not
Brownhill's monetisation model.** Brownhill buys the software once and operates
it; it does not pay a per-seat subscription. Documents 7, 9 and 10 are
therefore about a *business*, not a *licence* — see the decision sections
inside each.

## The two product lines in this repository

Both run the same `src/` tree. `DEPLOYMENT_PROFILE` gates the difference at
compile time.

| | **Brownhill Fleet (this repo)** | **Elite Fleet Management (upstream)** |
| --- | --- | --- |
| Shape | Single tenant per deployment | Multi-tenant SaaS |
| Tenancy | One `tenant_id`, seeded at bootstrap | Many, isolated by RLS |
| Where it runs | Namecheap Business VPS Pulsar, Ubuntu 24.04, Postgres 16.4 + PostgREST 12.2.3 + nginx | Vercel + Supabase |
| Auth | Local HS256 JWT against PostgREST | Supabase Auth |
| Entitlement source | `PROFILE_MODULES` for the deployment profile | `plans` / `add-ons` tables |
| Who pays | Brownhill, once, to its own hardware | The operator, per tenant, per period |

## Gaps, named

These are the honest holes. Each has a named gate rather than an omission.

| Gap | Gate | Owner |
| --- | --- | --- |
| Monetisation has no Brownhill-specific numbers | Brownhill's actual cost to serve (hosting, SMS, DVLA, telematics, funder finance) and its actual revenue per agreement | Business |
| Acquisition has no named first hundred | Brown's list of existing customers and the channel that reaches them | Business |
| Growth has no retention data | The product has not run for a reporting period yet | — |
| The live deploy has not been adopted into the migration ledger | The procedure is written down — see "Adopting this box into the migration ledger" in [the deploy runbook](../runbook/brownhill-namecheap-deploy-2026-10-07.md): `--status` to find the cut, `--baseline-through=` to adopt the database, `--skip=` for the migrations the box deliberately left out. It has not been run against the live database | Engineering |
| The report's figures have never been reconciled against a live deal | Stage 2 of the [launch plan](./08-launch-plan.md) — price one real agreement on the calculator, write it, and assert the report shows the same monthly payment, the same buyout balance, the same APR and the same yield | Engineering |

## How to keep this honest

- A change that invalidates a document changes that document **in the same
  commit** as the code. A doc edit that trails the code is a promise, and the
  gap between the promise and the doc is where a stale document lives.
- Before declaring a build task complete, re-open this file and make the
  statuses and dates true.
- When a figure changes, grep the set for the old one and fix every
  occurrence. Two documents quoting different numbers is worse than one
  document quoting nothing.
