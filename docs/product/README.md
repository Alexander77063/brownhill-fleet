# Brownhill Fleet — product foundation

The ten documents every Brownhill Fleet project carries. This file is the
index: it says what each document is for, when it was last checked against
the code, and where its gaps are.

**Last audited against the code: 2026-10-31**, on `feat/rtb-calculator`
(fork `Alexander77063/brownhill-fleet`, base commit `dc6e043`). The migration
replay, the bootstrap idempotency gate, the environment-variable gate, the
bootstrap-waiter gate and the portability-guards gate below were all run
against a scratch Postgres on the same date. The portability proof and the
chain-assertion negative gate were run against the **live hosted stack** on
the same date — the first time assertion 14 (the TLS chain) or assertion 15
(the tenant-mismatch 403) have ever executed anywhere. The no-credential
gate, its negative gate and the acceptance bar's own arithmetic were run
against the working tree on the same date; the no-credential gate is the
first of the three that had never run at all, and its first run found a
rule in it that could not fail.

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
| The handover proof's own guards are guards, not decoration | `hosted/tests/portability-guards.sh` — `hosted/tests/verify-hosted-portability.sh` is the thing that decides whether a deployment is fit to hand over, and **four of its guards could never pass**. The backup assertion asked for `systemctl` rather than for the installed Brownhill unit, so it failed on any machine that was not the deployed box — it failed the hosted-smoke job on 2026-10-31, a job whose stack, schema and application were all fine. The HTTPS assertion passed `-k` (skip verification) **and** `--cacert` together, so the CA was decorative — and the CA it pointed at was swallowed by a blanket `*.pem` rule in `.gitignore`, so the assertion skipped itself on every machine, forever. The tenant assertion loaded `jsonwebtoken`, which this project does not depend on, so it skipped itself everywhere, and the off-host assertion synced to a bucket named `"test"` instead of reading the box's own recorded state. A guard that can never pass is not a guard: in a build log a skipped assertion is indistinguishable from a passing one. The gate holds them to their promises — off the box they skip and the proof still exits 0; on the box a missing backup unit FAILS; a job told it must be on the box FAILS when it is not; the CA is really tracked in git; the proof loads nothing the project does not have; the token carries the claims the application itself mints | **Enforced by CI** — 26 assertions, green 2026-10-31 |
| The HTTPS assertion verifies the chain, and it can fail | `hosted/tests/verify-hosted-portability.sh` assertion 14, and `hosted/tests/tls-assertion-negative.sh` — the chain is verified with `openssl s_client` against a named CA **and the certificate's identity**, and a failed verification is a non-zero exit. It used to be judged by curl's HTTP status instead: nginx answers `/` with an ordinary **307** redirect, and the assertion's whitelist stopped at 302, so it **failed the hosted-smoke job on 2026-10-31 against a perfectly healthy stack**. It also depended on curl's TLS backend — the OpenSSL build honours the CA file it is given, and the Schannel build that ships with Windows curl loads that file and then refuses the certificate because the test CA publishes no revocation information, so the same assertion failed on a developer machine and passed on the runner. The negative gate runs the proof against the live stack with a CA that signed nothing and requires it to FAIL on assertion 14, because a verification that cannot fail is not a verification | **Enforced by CI** — 4 assertions in the negative gate, green against the live stack 2026-10-31 |
| The end-to-end smoke actually runs against the live stack | `hosted/tests/smoke/hosted-smoke.sh` — the front door sends a visitor to sign in, the sign-in page renders, the first-run endpoint demands a token, the operator status surfaces are closed to the public, and every major resource answers through the PostgREST rewrite. Two of its assertions could never pass: the data-plane probe asked for `/api/v1/postgrest/<table>`, which is not a route in this app, and the operator-status assertion expected the **page** to answer 403 — but the page sits behind the admin layout, which has required the `ops` role since the initial import and sends a visitor with no session to `/login` (307); the 403 is the **API's** contract, and it is now asserted there. The hosted-smoke job had never once been green, so neither assertion had ever run in CI to say so | **Enforced by CI** — green against the live stack 2026-10-31 |
| No credential is committed, and the gate that says so has actually read the tree | `hosted/tests/no-committed-credentials.sh` — this repository is **public**, and it has already published two credentials in plain text: the box's PostgreSQL superuser password, as the literal fallback of a `process.env.DATABASE_URL` lookup in two operator scripts, and the customer's own login password, printed in a handover document. Both are gone from the tree; both remain in the public history, so **rotation on the box is mandatory** and the handover says how. The gate has three rules: no connection URL with an inline literal password, no credential-named variable with a literal fallback, and no credential value printed anywhere in the tree. The third rule exists because the first two did not see the password in the handover document — a password written in prose is neither a URL nor a fallback. The gate also **refuses to report a clean tree it did not read**: not a checkout, an implausible number of tracked files, or a `git grep` that matched nothing all fail loudly rather than passing | **Enforced by CI** — the `unit-tests` job, on every pull request; 4 checks, green 2026-10-31 |
| The no-credential gate can fail | `hosted/tests/no-committed-credentials-negative.sh` — a gate that cannot fail is not a gate. This runs the real gate against a tree that does hold a value of the hunted shape and requires it to fail on the right rule, one probe per rule. It earns its place: the first version of the gate **passed every tree in the repository, including the ones it was written for**, because a greedy regular expression stripped the hit it had found and the rule reported "no fallback" on a file that had a credential in plain text. The probe value is assembled at run time from base64, because the negative gate lives in the tree the gate scans — written plainly, it would make the gate fail on its own source | **Enforced by CI** — the `unit-tests` job, on every pull request; 10 checks, green 2026-10-31 |
| The acceptance bar cannot be met by a gate that failed | `hosted/tests/acceptance-arithmetic.sh` — `hosted/tests/acceptance.sh` decides whether a deployment is fit to hand over, and that decision is arithmetic. The arithmetic asked "did the accounting gate pass?" instead of "how many gates ran?", so a deployment whose accounting module **was** enabled and whose accounting smoke **failed** dropped back to the five-gate bar and was reported as five of five — met. The bar is now the count of gates that ran, every gate that runs has to be green, and a skipped gate is named in the summary instead of vanishing. This runs the real acceptance script against stubbed gates and holds the counting to that promise | **Enforced by CI** — the `unit-tests` job; 11 checks, green 2026-10-31 |

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
| Two credentials were published in a public repository and have to be rotated on the box | The box's PostgreSQL superuser password and the customer's own login password were committed in plain text to a **public** fork. Deleting the lines removed them from the checkout — not from the history, and the history is public. `HANDOFF-BROWNHILL.md` has the procedure: rotate the database role's password from `pg.env` and re-run the idempotent installer, then reset the customer's password with `set-customer-password.mjs` and hand it over by phone, never by file or email. The gate stops the next one; it cannot undo this one | Operator, before handover |
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
