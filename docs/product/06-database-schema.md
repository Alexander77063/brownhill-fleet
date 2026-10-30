# 6 — Database schema

Tables, relationships, invariants, and what the money model actually is.

*Status: current as of 2026-10-30. Read from `supabase/migrations/` (81 files)
and `supabase/seed.sql`. The most recent migration is
`0082_billing_allocation_guard.sql`.*

---

## 1. The shape

PostgreSQL 16.4, three schemas:

| Schema | What is in it |
| --- | --- |
| `public` | The application. Fleet, drivers, agreements, billing, tenancy, RLS |
| `auth` | Supabase's auth schema — **replaced** on the hosted deployment by the shim and local HS256 JWT |
| `storage` | Object storage metadata |

`accounting` is a **fourth** schema (migration 0064) that holds the
in-app accounting module: `chart_of_accounts`, `journal_entries`,
`journal_lines`, `bank_accounts`, `bank_transactions`, `bank_imports`,
`periods`, `vat_codes`, `vat_submissions`, `vat_return_lines`,
`filing_artifacts`, `firs_credentials`, `tenant_accounting_settings`,
`bank_formats`, `audit_log`. It is **opt-in**, and the schema
contract knows the difference — a deployment without accounting tables still
passes its preflight.

The shim at `standalone/sql/0000_supabase_shim.sql` creates just enough of
`auth` (a `users` table, an `auth.uid()` function, `auth.role()`) for the
migrations to apply cleanly to plain Postgres with RLS intact. It is applied
before the migrations, and it is idempotent.

## 2. The tenancy spine

```
tenants
  │
  ├── tenant_memberships ──► profiles (users)
  │     (user_id, tenant_id, role, status, permissions[])
  │
  └── everything else carries tenant_id
```

### 2.1 `tenant_memberships` — the authoritative role

| Column | Notes |
| --- | --- |
| `user_id`, `tenant_id` | The pair |
| `role` | **Free text.** One of: `owner`, `tenant_admin`, `md`, `director_exec`, `director_nonexec`, `ops`, `accounts`, `driver`, `investor`, `vehicle_owner` |
| `status` | `active` / `disabled` |
| `permissions` | Extra grants beyond the role's defaults |

`role` here is what the application checks. It is **not** an enum, and it is
**not** the same thing as `profiles.role`.

### 2.2 `profiles` — the portal role

| Column | Notes |
| --- | --- |
| `id` | = `auth.uid()` |
| `role` | The Postgres `user_role` enum: `ops`, `driver`, `investor`, `owner`, `accounts` |
| `full_name`, `email`, `phone` | |

This is what `auth_role()` returns, what `ROLE_HOME` keys off, and what the
portal layout's `requireRole` checks. It decides **which app you land in**.

### 2.3 The two vocabularies

They are separate and nothing syncs them. The signup trigger (0078) maps one
to the other — see the [TRD](./02-trd.md), decision D12, and the
[user flow](./04-user-flow.md) §1.

**Consequence for the investor report.** `v_investor_rtb`'s guard is
`auth_role() in ('investor','ops')` — a **portal** role check. A
`director_exec` whose portal role is `accounts` does not open the view. That
is why `assembleRtbReportFor` has an anonymised fallback: the board's book,
with the name column blanked, when the view yields nothing.

## 3. Row-level security

### 3.1 The helper chain

```sql
-- 0016
current_app_user()   → coalesce(nullif(current_setting('app.user_id',true),'')::uuid, auth.uid())
current_app_tenant() → the tenant from the request
is_tenant_member(tid) → SECURITY DEFINER check against tenant_memberships
                        where status = 'active'

-- 0017
is_ops()             → auth_role() = 'ops'
auth_role()          → select role from profiles where id = current_app_user()
current_driver_id()  → the driver linked to the signed-in user
```

`is_tenant_member` is `SECURITY DEFINER` so it can read `tenant_memberships`
without recursing through its own policy. `current_app_user()` prefers the
`app.user_id` GUC — the hosted deployment sets it, because there is no
Supabase Auth to read `auth.uid()` from.

### 3.2 The investor rule

**Migration 0012: an investor has NO base-table access.** They read only the
PII-free views:

| View | What it exposes |
| --- | --- |
| `v_investor_vehicle` | Fleet economics, no driver names |
| `v_investor_fleet` | The fleet summary, no names |
| `v_investor_rtb` | The rent-to-buy book, no names |

The views run **as the owner**, and carry their own `auth_role()` guard and
tenant filter. `v_investor_rtb` additionally joins the funder's invoice
through a lateral subquery to resolve the cost of the car — and exposes
`car_cost_pence` and `cost_basis` but no `driver_id` and no name.

### 3.3 The other views

| View | What it is for |
| --- | --- |
| `v_agreement_arrears` | Arrears on an agreement |
| `v_invoice_balance` | Invoice balance |
| `v_receipt_vat` | VAT on receipts |
| `v_vat_by_quarter`, `v_vat_by_quarter_tenant` | The VAT return's inputs |
| `v_vehicle_economics`, `v_vehicle_economics_all` | Per-vehicle economics |

### 3.4 The operator-only tables

Four tables are the **office's** records, not the driver's: the incident queue,
the dispatch rules, the payment links, and the handover photographs.

| Table | Created in | Who may read it |
| --- | --- | --- |
| `driver_damage_reports` | 0073 | the driver (their own rows), and ops in that tenant |
| `booking_series` | 0074 | ops in that tenant |
| `payment_link_tokens` | 0075 | the driver (their own rows), and ops in that tenant |
| `agreement_handover_photos` | 0076 | ops in that tenant |

Their tenant policies are `is_ops() and is_tenant_member(tenant_id)` — the
role **and** the tenant, never the tenant alone.

**Why the role has to be in there.** A driver is an *active member of their
tenant* (`src/lib/ops/driver-invite.ts` upserts a `driver` membership with
`status = 'active'`). On the tenant predicate alone, every driver in the
business could read every damage report, every payment link and every handover
photograph in the fleet. On `payment_link_tokens` that is not merely privacy:
the `token` column **is** the credential, and the row carries the `used_ip` and
`used_user_agent` that used it.

**The tenant floor is structural.** Migration 0017 gave sixteen domain tables a
`RESTRICTIVE` policy named `tenant_isolation`, which is ANDed onto the
permissive role policies — so a permissive policy added later inherits the
tenant check without anyone having to remember to write it. 0017 is shipped and
is never edited, so migration **0079** adds the same policy, in the same shape,
to the four tables created after it. The driver-scoped policies carry no tenant
predicate of their own; 0079 bounds them, so a driver's read of their own rows
is now ANDed with the tenant floor rather than standing beside it.

`RESTRICTIVE` is only ever ANDed with the permissive policies, never ORed, so
0079 can remove access and never add it.

**Both changes are in 0079, and 0073–0076 are left as they shipped.** A
policy's `USING` expression cannot be altered in place, so 0079 drops and
recreates the four tables' tenant policies with the role in the predicate, and
then adds the floor. Editing 0073–0076 in place would have been the shorter
route and the wrong one: those files are already on `main`, and a migration
that has already been applied is never applied again — an install would keep
the permissive policies forever, which is the bug. A forward-only migration
reaches every install, the new one and the old one alike.

**No application path is affected.** Every ops path reads these tables through
`localDb()` — a direct connection as the table owner — or through
`createServiceClient()`, whose service-role JWT bypasses RLS entirely. The one
path that does go through RLS, `src/lib/queries-driver-damage.ts`, is the
driver's own read and relies on `driver_self_select`, which 0079 does not
touch.

**This is proven, not asserted.** `standalone/sql/portable-rls-proof.sql`
assertions **10–12** run the three cases against a real Postgres with the
migrations applied from zero: a driver sees their own damage report and none
of the office's records; ops in that tenant still sees all four kinds of row
(the fix must not close the office out); and ops in another tenant sees none of
it. The `hosted-smoke` CI job replays that proof on every pull request that
touches `supabase/migrations/**`.

## 4. The core tables

### 4.1 `vehicles`

`registration`, `vin`, `make`, `model`, `year`, `list_value_pence`, `list_value_pence` is the
fallback cost of the car when nothing better is recorded.

### 4.2 `drivers`

`full_name`, `email`, `phone`, `licence_*`, `dod` (date of birth),
`status`, `tenant_id`. `current_driver_id()` resolves the signed-in user to a
driver row — that is how the driver portal is scoped.

### 4.3 `finance_agreements`

How the business bought the car: `initial_rental_pence`,
`amount_financed_pence`, `funder`. The funder's invoice price is
`initial_rental_pence + amount_financed_pence` — that is the `funder` cost
basis, and it is a lateral join, not a stored column.

### 4.4 `agreements` — where the money model lives

```sql
create table agreements (
  id                        uuid primary key default gen_random_uuid(),
  type                      agreement_type not null,      -- 'standard' | 'rtb'
  vehicle_id                uuid not null references vehicles(id),
  driver_id                 uuid not null references drivers(id),
  status                    agreement_status not null default 'draft',
  start_date                date,
  end_date                  date,                          -- null = ongoing
  term_weeks                int,                          -- null = rolling
  weekly_gross_pence        bigint not null check (weekly_gross_pence >= 0),
  weekly_net_pence          bigint not null check (weekly_net_pence  >= 0),
  weekly_vat_pence          bigint not null check (weekly_vat_pence  >= 0),
  deposit_pence             bigint not null default 0 check (deposit_pence >= 0),
  notice_weeks              int not null default 4,
  option_credit_weekly_pence bigint check (option_credit_weekly_pence >= 0),
  agreed_residual_pence     bigint,
  signed_doc_path           text,
  signed_on                 date,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint rtb_requires_fields check (
    type <> 'rtb' or (option_credit_weekly_pence is not null and term_weeks is not null)
  ),
  constraint weekly_components_sum check (
    weekly_gross_pence = weekly_net_pence + weekly_vat_pence
  )
);
```

Migration 0077 added the monthly side:

| Column | Meaning |
| --- | --- |
| `term_months` | The monthly term the rentee signed — null for a standard rental |
| `monthly_gross_pence` | The monthly payment the rentee signed, VAT-inclusive |
| `agreed_vehicle_price_pence` | The price the rentee is buying the car at |
| `agreed_vehicle_cost_pence` | What the car cost Brownhill when the deal was priced |

And a fourth constraint:

```sql
constraint rtb_contract_fields check (
  type <> 'rtb' or (term_months is not null and monthly_gross_pence is not null)
)
```

The cost is deliberately **not** required: a car bought outright has no funder
invoice, and the report falls back to the list value and says so.

**The backfill** (0077) reconstructs the monthly contract from the weekly
billing for existing rows — exact arithmetic, not a guess: 156 weeks is 36
months (156 × 12 / 52 = 36 exactly), and £1,020 a week over 156 weeks is
£159,120, which is £4,420 a month.

**One active agreement per vehicle:**

```sql
create unique index one_active_agreement_per_vehicle
  on agreements (vehicle_id) where status = 'active';
```

### 4.5 The equity ledgers

```sql
create table deposit_ledger (
  agreement_id uuid not null references agreements(id) on delete cascade,
  event        deposit_event not null,
  amount_pence bigint not null check (amount_pence > 0),
  reason       text,
  occurred_on  date not null default current_date,
  ...
);

create table rtb_equity_ledger (
  agreement_id            uuid not null references agreements(id) on delete cascade,
  week_no                 int not null check (week_no >= 0),
  credit_pence            bigint not null default 0 check (credit_pence >= 0),
  cumulative_credit_pence bigint not null default 0 check (cumulative_credit_pence >= 0),
  deposit_pence           bigint not null default 0 check (deposit_pence >= 0),
  equity_total_pence      bigint not null default 0 check (equity_total_pence >= 0),
  as_of                   date not null,
  unique (agreement_id, week_no)
);
```

One row per week. `equity_total = cumulative_credit + deposit` — the deposit
plus the credited rent: what the rentee owns at the end of the term, and
therefore what they get the car for.

**Note on duplication.** The equity is *also* derivable from the agreement
(`deposit + optionCreditWeekly × weeks`). The ledger is the running
historical record — it is what the driver portal's "My equity" reads, and it
survives a change to the agreement's terms. The report computes from the
agreement, because the report is a pricing exercise over the *current*
contract. Both are correct; they answer different questions.

## 5. The money model

**Every monetary value is a `bigint` count of pence.** There is no
`numeric` money column, no currency column, and no rounding at the storage
layer.

| Column family | Meaning |
| --- | --- |
| `*_gross_pence` | What the customer pays |
| `*_vat_pence` | The VAT inside it |
| `*_net_pence` | What the business keeps — `gross − vat`, enforced |
| `*_pence` (unqualified) | A single amount, whose gross/net status depends on the table |
| `*_minor` | The subscription platform's own minor-unit convention (a different subsystem) |

### 5.1 The invariant that matters

```sql
constraint weekly_components_sum check (
  weekly_gross_pence = weekly_net_pence + weekly_vat_pence
)
```

The database refuses a billing row where gross ≠ net + VAT. That is why the
calculator's derivation can state "gross − vat = net **exactly**" and mean it:
the derivation is not a hope, it is the same equality the constraint enforces.

### 5.2 The cost of a car — three records, one order

| Basis | Record | When |
| --- | --- | --- |
| `deal` | `agreements.agreed_vehicle_cost_pence` | The agreement prices the car itself |
| `funder` | `finance_agreements.initial_rental_pence + amount_financed_pence` | The business bought on finance and knows the invoice |
| `list` | `vehicles.list_value_pence` | Nothing else is recorded |

`resolveRtbCost` (application) and the `CASE` in `v_investor_rtb` (database)
implement **the same order**, so the board's figure and the investor's figure
are the same figure. The basis is reported beside the number, because a margin
measured against the list value is not the margin measured against what the
business paid.

### 5.3 The accounting module's money

| Table | What it holds |
| --- | --- |
| `accounting.chart_of_accounts` | The CoA: `code`, `name`, `type`, `normal_balance` |
| `accounting.journal_entries` / `journal_lines` | Double-entry. `check ((debit_pence > 0) <> (credit_pence > 0))` — a line is a debit or a credit, never both and never neither |
| `accounting.bank_accounts` | Registered accounts and their import settings |
| `accounting.bank_transactions` | Imported statements |
| `accounting.periods` | The accounting period lifecycle; `period_end >= period_start`; `reopen_window_days between 1 and 90` |
| `accounting.vat_codes` | `code ~ '^T[0-9]$'`, `vat_t1_rate_pct between 0 and 100`, `vat_treatment in ('standard','zero','exempt','outside')` |
| `accounting.vat_submissions` | UK VAT return; `box_number between 1 and 6` (the nine boxes are spread across six box numbers with sub-boxes) |
| `accounting.filing_artifacts` | What was filed, when, and the MTD response |
| `accounting.firs_credentials` | HMRC tokens, AES-GCM encrypted at rest. One row per tenant — see §5.4 |
| `accounting.vat_return_lines` | The lines of a VAT return. Keyed on `vat_submission_id`; its tenancy is its submission's |
| `accounting.audit_log` | The accounting module's own append-only audit trail — read and appended to, never edited or removed |
| `accounting.tenant_accounting_settings` | Per-tenant thresholds and the reopen window |

### 5.4 How the accounting schema is tenant-scoped

The accounting schema is the one part of the product that **does not** follow
the `public` tenancy spine by default, and getting that wrong is a
cross-tenant data leak rather than a broken screen — so it is worth stating
exactly.

| Tables | Scope |
| --- | --- |
| `chart_of_accounts`, `vat_codes` | **Global.** Seeded once by migrations 0065/0066; nothing provisions a per-tenant copy. A tenant-scoped lookup would find nothing and every chart-of-accounts lookup in the product would break. They are reference data, not tenant data |
| `vat_return_lines` | **Inherited.** Keyed on `vat_submission_id`; its tenancy is its submission's |
| The other twelve — `periods`, `journal_entries`, `journal_lines`, `audit_log`, `bank_accounts`, `bank_imports`, `bank_transactions`, `vat_submissions`, `firs_credentials`, `tenant_accounting_settings`, `bank_formats`, `filing_artifacts` | **Tenant-scoped.** `tenant_id` is `NOT NULL`, indexed, and carries a RESTRICTIVE `tenant_isolation` policy ANDing `is_tenant_member(tenant_id)` onto the existing permissive policies |

Migration 0069 added the `tenant_id` columns and the per-tenant UNIQUE
constraints but left them nullable and the policies decorative — the policies
called `accounting.is_current_tenant()`, which only checks that *a* tenant is
pinned on the session and never compares it with the row's own `tenant_id`.
Migration **0081** is what makes it real: it backfills `tenant_id` to the
bootstrap tenant, makes it `NOT NULL` (a NULL tenant makes every row distinct,
which would let two periods for the same `(year, month)` coexist), indexes it,
and replaces the decorative policies with the house `tenant_isolation` pattern
used by `public` since migration 0017.

**The application must still name the tenant.** The Node server connects as a
superuser, which bypasses RLS entirely, and the accounting schema is not
exposed by PostgREST — so a policy is not what stops one tenant reading
another's ledger. `tests/unit/accounting/sql-contract.test.ts` holds every
statement that touches a tenant-scoped accounting table to containing
`tenant_id`; the policy is the second line of defence for any connection that
is *not* the superuser.

Two other things 0081 fixes that the code had been working around:

- `accounting.firs_credentials` gained `unique (tenant_id)`. The application
  upserts on it; before that the only unique key was the primary key `id`,
  which defaults to a fresh random uuid, so the conflict never fired, every
  reconnect inserted another row, and `loadCredentials` could return a stale
  token.
- `accounting.bank_transactions` and `accounting.vat_submissions` gained
  `posted_journal_id`, so a source row can point at the journal entry it
  produced. The journal's idempotency key is
  `(tenant_id, source_type, source_id)`, which is why `bank_receipt` and
  `bank_fee` are separate source types — one bank transaction can produce more
  than one posting.

## 6. Other invariants worth knowing

| Constraint | Table | What it forbids |
| --- | --- | --- |
| `amount_pence > 0` | `payments`, `payment_allocations` | A zero or negative payment |
| `amount_minor > 0` | `invoices`, `billing_events` | A zero-value invoice |
| `cost_pence >= 0` | `invoice` | A negative cost |
| `excess_mile_pence >= 0` | agreements | Negative excess-mileage charges |
| `apr >= 0` | `rent_schedule` | A negative APR |
| `cover_to >= cover_from` | `insurance_certificates` | An insurance period that ends before it starts |
| `end_date is null or end_date >= start_date` | agreements | An agreement that ends before it starts |
| `period_end >= period_start` | accounting periods | An inverted period |
| `state in ('in_stock','allocated','fitted','faulty','returned','retired','lost')` | `device_units` | An unknown device state |
| `kind ~ '^[a-z][a-z0-9_]{1,40}$'` | `plan_features` | A malformed feature key |
| `reopen_window_days between 1 and 90` | accounting settings | A reopen window of zero or two years |
| `bank_statement_max_bytes between 1024 and 1073741824` | tenant settings | A nonsensical import cap |
| allocation targets a non-void invoice (trigger `check_allocation()`) | `payment_allocations` | Money landing on a voided invoice |

**The void guard, and why it lives in the database.** An invoice that has
been voided has been cancelled: nothing is owed on it, so a receipt must never
be allocated to it. `public.check_allocation()` enforces that, and enforces it
for *every* writer — the reconcile route, the bank import, the payment ingest,
and any writer not yet written. The application applies the matching rule
(`src/lib/accounting/invoice-eligibility.ts`: allocatable means `open`,
`part_paid` or `overdue`) so it can explain the refusal; the database refuses
it regardless.

Two limits travel with the guard: an invoice's allocations cannot exceed its
gross, and a payment's allocations cannot exceed the payment itself. The
trigger takes the invoice row lock first and the payment row lock second —
the same order the reconcile route uses — so the two cannot deadlock.

Before migration 0082 the trigger checked neither the invoice's status nor
the invoice row itself, so a void invoice accepted money. The regression proof
`standalone/sql/billing-allocation-proof.sql` fails against 0001–0081 and
passes against 0001–0082.

**Status vocabularies** are enum-typed or `CHECK`-constrained, not free text —
with one exception. `agreement_status` (`draft`, `pending_signature`, `active`,
`ended`, `defaulted`, `transferred`), `invoice_status` (`open`, `paid`,
`part_paid`, `void`, `overdue`) and `booking_status` (`requested`, `assigned`,
`en_route`, `in_progress`, `completed`, `cancelled`, `no_show`) are enums.

Two different invoice vocabularies exist and they are **not** the same list.
`public.invoices.status` uses the `invoice_status` enum above — a tenant's
invoice to its driver, which starts `open`. `subscription_invoices.status` is
a `text` column with its own CHECK over `draft`, `issued`, `part_paid`,
`paid`, `overdue`, `void` — the invoice **we** issue to a tenant for its
protection subscription, which starts `draft`. `src/lib/collection/invoices.ts`
types the second one and `src/lib/types.ts` types the first.

`tenant_subscription.status` is a `text` column with a CHECK over `trialing`,
`unpaid`, `active`, `past_due`, `suspended`, `cancelled`. `device_units.state`
is a `text` column with a CHECK over `in_stock`, `allocated`, `fitted`,
`faulty`, `returned`, `retired`, `lost`. **`notifications.status` is the
exception**: it is free text with no CHECK, and the application writes
`pending`, `sent`, `skipped` or `failed`.

## 7. Operational state

| Table | What it is |
| --- | --- |
| `app_state` | Key/value operational flags: `bootstrap_pending`, `app_draining`. Read by the Node server through `localDb()` (a direct connection as the table owner) and by the Edge middleware over HTTP from PostgREST — see §7.1 |
| `numbering_sequences` | Per-tenant document numbering (agreement numbers, invoice numbers) |
| `audit_log` | Append-only. Migration 0018 makes it immutable |
| `void_events` | Void markers on financial records |
| `notifications` | `status in ('pending','sent','acknowledged','failed')` |
| `subscriptions` / `tenant_subscription` | The SaaS subscription — **unused in the hosted profile**, where entitlements come from `PROFILE_MODULES` |

### 7.1 How `app_state` is read

The table has **three** access paths, and they are not interchangeable.

| Reader | Mechanism | RLS |
| --- | --- | --- |
| Node server — sign-in, `/admin/status`, `/admin/restore`, first-run setup | `localDb()` — a direct `postgres` connection as the table owner, using `DATABASE_URL` | Bypassed (owner) |
| Any server-side path using the service client | `createServiceClient()` — a service-role JWT | Bypassed (`service_role` has `bypassrls`) |
| **Edge middleware** — the drain check | `fetch()` to PostgREST as `anon` | **Applies.** One policy: `anon` may `select` the row whose `key = 'app_draining'`, and nothing else |

Migration 0080 enables RLS on `app_state` and installs that single-row
policy. Two things make it necessary rather than decorative:

- `0014_grants.sql`'s `alter default privileges in schema public` grants
  `authenticated` DML on every table created after it — which is `app_state`.
  With RLS off, any signed-in account could write these flags: a driver
  could set `app_draining='1'` and close the whole business, or set
  `bootstrap_pending='0'` on a fresh install and lock the owner out of
  first-run setup. A table with RLS enabled and no matching policy is
  unreachable whatever the table-level grants say, so the blanket grant buys
  nothing here.
- The Edge runtime **cannot open a database connection**. The middleware
  therefore reads the drain flag over HTTP from PostgREST, which needs a
  role — and the only role that needs no credential is `anon`. The policy
  exposes one row and nothing else: `anon` can read the drain flag, cannot
  read `bootstrap_pending`, cannot write, and cannot see anything else.

The alternative — a service-role token inside the Edge bundle — would put a
credential that bypasses every policy in the database into the middleware, to
read one flag. A single-row policy is a much smaller thing to hand out.

`app_state` is also created by a migration rather than by
`hosted/bootstrap/brownhill-bootstrap.sh` alone. It used to be created only
by that shell script, which meant it existed only on a host where the script
had been run by hand; every other path — a fresh CI stack, a container that
provisions itself, a developer running the app locally — queried a table that
did not exist and got `42P01`. The migration history is the one thing every
install has applied, by definition.

## 8. Migrations

- 81 files, `0001`–`0082` (there is no `0057`; the number was never used).
- Applied in filename order, each in **its own transaction**, by
  `brownhill-bootstrap.service`.
- **Forward-only.** Never rolled back. Restoring an old application build
  against a current schema is safe; restoring an old schema against current
  data is not.
- The hosted deployment applies `standalone/sql/0000_supabase_shim.sql` first,
  then the migrations.
- `supabase/seed.sql` provides the development seed: one tenant, four
  vehicles, four drivers, four agreements — two of them rent-to-buy, one of
  those live and one a draft — a rent schedule and invoices for thirty weeks
  of the live deal, the equity ledger, and the accounting chart of accounts.

## 9. The investor's rent-to-buy book — verified

**The `v_investor_rtb` view was exercised against a live database on
2026-10-30.** Its guard — `auth_role() in ('investor','ops')` — opens for an
investor and for ops, and the `current_app_user()` helper prefers the
`app.user_id` GUC, which the hosted deployment sets.

The sessions ran as `authenticated`, not as the schema owner. That is the
whole point: the view runs as its owner, so as a superuser every check below
would have passed without proving anything — which is precisely the mistake
the repo's own `standalone/sql/portable-rls-proof.sql` calls out. The first
assertion checked the role switch had actually taken effect; the rest then
ran under it.

| Check | Result |
| --- | --- |
| The role switch took effect and the identity resolved from the GUC | **Passed** |
| An investor sees both rent-to-buy deals — and sees them priced: 156 weeks / 36 months, £4,420 a month, £5,000 deposit, £162.50 a week of buyout credit, £35,000 residual, car cost £117,000, cost basis `funder` | **Passed** |
| A driver sees none of them | **Passed** |
| Ops sees both | **Passed** |
| An investor reaches no row of the `agreements` or `drivers` base table | **Passed** |

The view also carries no identifying column at all — no name, no driver
column — which is asserted from the catalogue. The investor's report therefore
does not fall back to the anonymised summary for the rent-to-buy book: it
reads the real figures, and the rentee's identity is not in them.

The one thing this does not prove is the backfill 0077 performs on a database
that already holds rent-to-buy rows; that case has its own phase in
`hosted/tests/migrations-regression.sh`, and it is described in the
[launch plan](./08-launch-plan.md) §2 Stage 1.
