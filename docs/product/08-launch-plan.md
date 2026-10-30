# 8 — Launch plan

Sequence, gates, rollback, and who is told what and when.

**This is a decision document, partially.** The *operational* launch — the
install, the schema, the acceptance gates, the rollback — is fully specified
and lives in `HANDOFF-BROWNHILL.md`; it is summarised here so the product set
is navigable. The *commercial* launch — when Brownhill starts selling
rent-to-buy to its customers, and what is said to whom — depends on facts
this repository does not hold.

*Status: partial as of 2026-10-30.*

---

## 1. The unresolved question

> **When does Brownhill start offering rent-to-buy to its customers, and what
> does it tell them about the rate?**

A rent-to-buy deal is a credit product. Before it goes to a customer, two
things have to be true that this repository cannot make true:

1. **The rate is known and approved.** The calculator now solves the rentee's
   implied APR and Brownhill's yield per deal. **Who approves the rate**, and
   **what the floor is** — the minimum APR that makes a deal worth writing,
   given the cost of capital and the servicing cost — is a business decision.
   The software enforces no floor today, and it should not: a floor is a
   policy, and policies belong in configuration, not in code.

2. **The disclosures are right.** A customer buying on credit needs to be told
   the APR. The system computes it. Whether the agreement template carries
   it, and whether the wording is reviewed, is a legal step this product
   cannot perform.

**What would settle it:** Brown's credit policy (the floor rate, the approval
path, the bad-debt provision) and a reviewed agreement template.

## 2. The product launch sequence

Each stage has a gate. **A stage is not complete until its gate is passed,
and the gate is run, not asserted.**

### Stage 0 — The deployment is healthy

```
docker compose -f hosted/dev/docker-compose.yml up -d     # the hosted stack
apply the shim, then every migration, each in its own transaction
hosted/tests/acceptance.sh                                  # all gates green
```

**Gate:** all five acceptance gates return 0 (six with accounting enabled).

- `DEPLOYMENT_PROFILE=hosted pnpm test`
- `hosted/tests/verify-hosted-portability.sh` — assertions 0–17 against the live stack
- `hosted/tests/migrations-regression.sh` — replay the schema against a throwaway Postgres
- `hosted/tests/smoke/hosted-smoke.sh` — round-trip one `.from()` per major resource
- the Sunday `brownhill-backup-verify.service` journal entry — restore a fresh dump, assert row counts and RLS

### Stage 1 — The schema is proven from zero

**Gate:** migrations 0001–0082 apply to an empty Postgres, in order, with
`ON_ERROR_STOP`, and the seed loads.

**Status: passed 2026-10-30.** The replay ran against a scratch `postgres:16`
container, in two steps: a dry run that applied every migration inside one
transaction and rolled it back — leaving `public_tables=0` behind, so nothing
survived it — and then a real from-zero apply in production semantics, each
migration in its own transaction. The result was 85 public tables, 15
accounting tables and 10 public views.

What the run asserted, and what it found:

| Check | Result |
| --- | --- |
| The schema lands and the seed loads — 1 tenant, 4 vehicles, 4 drivers, 4 agreements (2 of them rent-to-buy), 31 equity rows, 33 chart-of-accounts rows | **Passed** |
| 0077's four contract columns and all three `agreements` constraints are present | **Passed** |
| Both seeded rent-to-buy agreements carry the monthly contract and satisfy `weekly_components_sum` | **Passed** |
| `rtb_contract_fields` actually refuses a rent-to-buy with no monthly contract | **Passed** |
| `v_investor_rtb` exists and exposes no name or driver column | **Passed** |
| All ten tenant roles map to the expected portal role through the signup trigger — including the `director_exec` → `accounts` case 0078 exists to fix | **Passed** |
| Row-level security is on `agreements`, `drivers`, `vehicles` and `profiles` | **Passed** |
| Money cannot be allocated to a voided invoice, and allocations cannot exceed the invoice's gross or the payment's amount | **Enforced by CI** — `standalone/sql/billing-allocation-proof.sql`, four assertions; it fails against 0001–0081 and passes against 0001–0082 |

And, run as a live session rather than as the schema owner — a superuser
bypasses RLS, so a check made as the owner would have proved nothing:

| Check | Result |
| --- | --- |
| An investor sees both rent-to-buy deals, priced: 156 weeks / 36 months, £4,420 a month, £5,000 deposit, £162.50 a week of buyout credit, £35,000 residual, car cost £117,000 taken from the funder invoice | **Passed** |
| A driver sees none of them | **Passed** |
| Ops sees both — the guard admits ops as well as investors | **Passed** |
| An investor reaches no row of the `agreements` or `drivers` base table | **Passed** |
| A driver sees only their own damage report — not the office's other records, payment links, dispatch rules or handover photographs | **Enforced by CI** |
| Ops in that tenant still sees all four kinds of record — the tightening must not close the office out | **Enforced by CI** |
| Ops in another tenant sees none of them | **Enforced by CI** |
| The accounting schema is tenant-isolated — all twelve tenant-scoped tables carry a RESTRICTIVE `tenant_isolation` policy ANDing `is_tenant_member(tenant_id)`, and the two global reference tables (`chart_of_accounts`, `vat_codes`) are deliberately exempt | **Passed** |

The last three rows are the operator-only tables (`driver_damage_reports`,
`booking_series`, `payment_link_tokens`, `agreement_handover_photos`), whose
policies now require the operator role as well as tenant membership. They are
assertions 10–12 of `standalone/sql/portable-rls-proof.sql`, and the
`Migrations-regression` step of the `hosted-smoke` job is what runs them, on
every pull request that touches `supabase/migrations/**`. They are marked
**Enforced by CI** rather than **Passed** because the gate for them is the
pipeline, not a local claim: **a green `hosted-smoke` job is what turns them
into Passed.**

**The gap this left, and what now closes it.** A from-zero replay applies 0077
to an *empty* `agreements` table: its backfill updates zero rows, and its
`rtb_contract_fields` constraint is validated against zero rows. A live
deployment is the opposite — the rent-to-buy book already exists. A backfill
that mis-computed, or that missed a row, would therefore pass the gate above
and fail the deploy in front of a customer.

That case is now permanent rather than anecdotal.
`hosted/tests/migrations-regression.sh` has a second phase that replays the
same history over a database that already holds rent-to-buy agreements
(`hosted/tests/backfill-fixture.sql`, `hosted/tests/backfill-assert.sql`):
the backfill is asserted to reconstruct 36 months at £4,420 a month from
£1,020 a week over 156 weeks, to take the agreed price from the car's list
value, to leave the standard rentals alone, to be idempotent, and to satisfy
the CHECK it adds. The harness already runs on every PR — it is the
`Migrations-regression` step in `.github/workflows/hosted-smoke.yml` — so both
phases are enforced by the pipeline. **The pipeline is the gate: a red
`hosted-smoke` job means Stage 1 is not passed.**

### Stage 2 — The rent-to-buy prices itself correctly

**Gate:** the calculator's figures are reconciled against a real deal, and the
report's figures match the calculator's figures for the same deal.

Concretely: pick one seeded agreement, price it on `/ops/rtb-calculator`,
write it, and assert that the report shows the same monthly payment, the same
buyout balance, the same APR and the same yield. The unit tests cover the
engine and the renderer separately; **this gate covers the join between them
and the database**, which is where a real defect would live.

### Stage 3 — The governance pack is what the directors want

**Gate:** a director opens `/accounts/reports`, reads the rent-to-buy section,
downloads the CSV, downloads the printable document, sends it by email, and
confirms the figures are right and the format is usable.

**Who is told what:**

| Who | What | When |
| --- | --- | --- |
| The MD | "The rent-to-buy book is now in the board pack, with the rate each rentee pays and the rate we make." | At Stage 3 |
| The directors | The pack itself, by email, from the report's own send button | At Stage 3, and monthly thereafter if the schedule in [07-monetisation](./07-monetisation.md) §4.3 assumption C is adopted |
| The investors | Their own pack from `/investor`, and the emailed copy | Only after the directors have signed off the format. **Not before** — the first investor-facing document sets the expectation for every one after it |
| The operations staff | "Price rent-to-buy on the calculator, not in a spreadsheet. Here is the page." | At Stage 2, before the first live deal |
| The customers | Nothing, yet — see §1 | At Stage 5 |

### Stage 4 — One live deal, priced and written

**Gate:** one real customer signs a rent-to-buy produced by the calculator,
and the resulting invoice run bills the weekly rate the agreement holds.

This is the first time the monthly contract and the weekly billing meet a
real payment. The 80p rounding is the thing to watch: over 260 weeks it is
£45,000.80 against a £45,000 contract, and the first invoice must show that
figure without someone querying it.

### Stage 5 — The customer-facing rate

**Gate:** the agreement template carries the APR disclosure, reviewed by
whoever reviews Brownhill's agreements; and the floor rate is configured and
enforced by whatever process enforces it.

**This stage has no software deliverable in it.** It is the point at which the
product stops being an internal tool and becomes a credit product. It should
not be reached by accident.

## 3. Rollback

### 3.1 A bad deploy

```
1. systemctl stop brownhill-next.service postgrest.service brownhill-backup.timer
2. git log -5 → git checkout <sha>
3. ./hosted/scripts/deploy-app.sh   (builds, installs into /var/lib/brownhill/app, restarts)
```

Rolling the application back is a **build-and-install**, not a build: the unit
runs `node server.js` from `/var/lib/brownhill/app`, so the standalone output
has to be copied there. `deploy-app.sh` does both and keeps the build it
replaced at `/var/lib/brownhill/app.previous`.

### 3.2 A bad database change

**Do not roll the schema back.** Migrations are content-versioned
forward-only. Restoring an old application build against a current schema is
safe; restoring an old schema against current data is not.

The database path is `/admin/restore`: browse the dumps in
`/var/backups/brownhill/_index.json`, type `RESTORE`, submit. The middleware
503s everything except `/admin/*` while the swap completes; the app comes
back when the dump and WAL are replayed and `app_draining` flips to 0.

**A failed restore leaves `app_draining='1'` and pages the operator.** The app
stays closed rather than coming back half-restored. That is the intended
behaviour.

### 3.3 Rolling back the rent-to-buy feature specifically

The feature is additive in every direction: new columns, new views, new
routes, new tables. Nothing existing was replaced. Rolling it back is
`git checkout` of the branch and a rebuild — the columns and the view stay in
the database, unused.

The one exception is migration 0077's `rtb_contract_fields` constraint, which
**requires** `term_months` and `monthly_gross_pence` on any row of type
`rtb`. Rolling back the application to a version that does not write those
columns would break the write path for new RTB agreements. **So: rolling back
the application past 0077 means rolling back past 0077's constraint too** —
which means forward-only is violated, which means the answer is a restore
from a dump, not a schema rollback.

**This is the one place in the system where the forward-only rule and the
rollback rule meet, and it is worth knowing about before it is needed.**

## 4. What would make us stop

| Signal | Action |
| --- | --- |
| The spread (rentee's APR − Brownhill's yield) is thin or negative across the book | Stop growing the book; reprice. This is a pricing finding, not a bug |
| A stage gate cannot be passed | Stop at that stage. Do not proceed on a gate that was "mostly green" |
| The weekly restore-verify fails | Stop deploying. A backup that cannot be restored is not a backup |
| `app_draining` is stuck at 1 | Stop deploying. The instance is closed, and the next deploy lands on a closed system |
| The margin is thin **and** the servicing cost is unknown | Do not write more rent-to-buy agreements until §1 of the [monetisation](./07-monetisation.md) document is answered |
