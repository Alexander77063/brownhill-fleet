# Brownhill Fleet — product foundation

The ten documents every Brownhill Fleet project carries. This file is the
index: it says what each document is for, when it was last checked against
the code, and where its gaps are.

**Last audited against the code: 2026-10-30**, on `feat/rtb-calculator`
(fork `Alexander77063/brownhill-fleet`, base commit `dc6e043`). The migration
replay below was run against a scratch Postgres on the same date.

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
| Migrations 0001–0079 apply from zero, in order, and the seed loads | A scratch `postgres:16` — a dry run rolled the whole set back, then a real apply produced 84 public tables, 15 accounting tables and 10 public views, with 21 assertions on top | **Verified 2026-10-30** |
| Every tenant role maps to a portal role at signup | The signup trigger was exercised for all ten roles, including the `director_exec` → `accounts` case migration 0078 exists to fix | **Verified 2026-10-30** |
| `v_investor_rtb` returns the rent-to-buy book to an investor and to ops, and to nobody else | Live sessions run as `authenticated`, so row-level security was not bypassed | **Verified 2026-10-30** |
| The rent-to-buy backfill (0077) runs correctly over rows that already exist | The second phase of `hosted/tests/migrations-regression.sh` | **Enforced by CI** — the `hosted-smoke` job runs it on every PR |
| The four operator-only tables are closed to drivers and open to ops | Assertions 10–12 of `standalone/sql/portable-rls-proof.sql` — a driver reads their own damage report and none of the office's records; ops in that tenant still sees all four kinds of row; ops in another tenant sees none of them | **Enforced by CI** — the `hosted-smoke` job runs the proof on every PR that touches `supabase/migrations/**` |
| A spreadsheet is never handed a cell it would run | `tests/unit/csv.test.ts` and `tests/unit/rtb-format.test.ts` — the shared CSV writer refuses a cell starting `=`, `+`, `-`, `@`, tab or CR unless the cell is genuinely a number, and the rent-to-buy report's export is checked through it | **Verified 2026-10-30** — 43 unit tests green |

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
| The live deploy has not been migrated to this branch | The branch's migrations apply from zero and the rent-to-buy backfill is covered by the regression harness (both verified); what is left is running them against the live database itself | Engineering |
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
