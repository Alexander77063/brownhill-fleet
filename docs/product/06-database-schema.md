# 6 — Database schema

Tables, relationships, invariants, and what the money model actually is.

*Status: current as of 2026-11-05. Read from `supabase/migrations/` (88 files)
and `supabase/seed.sql`. The most recent migration is
`0089_audit_system_actor.sql`.*

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
| `v_agreement_arrears` | Arrears on an agreement — `billed_pence`, `collected_pence`, `outstanding_pence`, with voided invoices excluded |
| `v_invoice_balance` | Invoice balance — `balance_pence` is what is still owed, and it is zero on a voided invoice |
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
| `accounting.periods` | The accounting period lifecycle. One row per (tenant, year, month) — `unique (tenant_id, year, month)` — with `month between 1 and 12` and `year between 2000 and 2100`; `started_at`, `closed_at`, `closed_by_user_id` and `locked_at`. The row is created lazily, by whichever posting first needs the month |
| `accounting.vat_codes` | `code ~ '^T[0-9]$'`, `vat_t1_rate_pct between 0 and 100`, `vat_treatment in ('standard','zero','exempt','outside')` |
| `accounting.vat_submissions` | UK VAT return; `box_number between 1 and 6` (the nine boxes are spread across six box numbers with sub-boxes). Its `status` has **four** values — `pending_submission`, `accepted`, `submitted`, `rejected` — see §5.6 |
| `accounting.filing_artifacts` | What was filed, when, and the MTD response |
| `accounting.firs_credentials` | HMRC tokens, AES-GCM encrypted at rest. One row per tenant — see §5.4. `vrn` is the tenant's VAT registration number (migration 0084), and it is **unique across tenants** (migration 0085) — see §5.5 |
| `accounting.vat_return_lines` | The lines of a VAT return. Keyed on `vat_submission_id`; its tenancy is its submission's |
| `accounting.audit_log` | The accounting module's own append-only audit trail — read and appended to, never edited or removed |
| `accounting.tenant_accounting_settings` | Per-tenant thresholds and the reopen window: `reopen_window_days between 1 and 90` (migration 0070, default 7) |

**The accounting audit trail is written in the same transaction as the change
it records.** `accounting.audit_log` is append-only. `entity` and `entity_id`
say what changed, `before` and `after` are `jsonb` snapshots, `user_id` says
who, and `tenant_id` says whose — it is `NOT NULL` and carries a foreign key
to `public.tenants`, so an audit row cannot outlive the tenant it belongs
to. The `action` column is the `accounting.audit_action` enum.

| Action | Written when | Writer |
| --- | --- | --- |
| `journal_posted` | A balanced entry commits | `journal-bridge.ts` |
| `period_opened` | A period row is **created** — not when it is merely looked up, which the journal bridge does on every posting | `periods.ts` |
| `period_closed` | A period is closed | `periods.ts` |
| `period_reopened` | A period is reopened inside the reopen window | `periods.ts` |
| `invoice_voided` | An invoice is voided by reversal — see §5.8 | `invoice-void.ts` |
| `credit_note_issued`, `bank_import_committed`, `bank_transaction_categorised`, `bank_transaction_recategorised`, `vat_submission_attempted`, `vat_submission_succeeded`, `vat_submission_rejected`, `chart_of_accounts_seeded` | Carried by the enum since migration 0064; **none of them has a writer yet** | — |

The three period actions had been in the enum since 0064 and **nothing ever
wrote them**: a month could be closed and reopened with no record of who did
it. Each state change now writes its row inside the same `sql.begin` as the
change itself, so a close cannot land without a record of who closed it and
when.

**The jsonb columns take an object, not a JSON string.** This is the one
place the audit trail could have been written wrong and nobody would have
known. `postgres.js` serialises a `jsonb` parameter with `JSON.stringify`,
so a value that is *already* a JSON string is stringified a second time and
lands in the column as a JSON **string** rather than a JSON **object** — and
`after->>'key'` then reads NULL, because the value is one opaque string
rather than a map. The failure is invisible in the column: the row is there,
the payload is there, and the payload cannot be read. The rule is therefore
to pass the JavaScript **object** and let the driver encode it:

```ts
// wrong — lands as a JSON string; after->>'sourceType' is NULL
await sql`insert … values (${JSON.stringify(payload)}::jsonb)`;

// right — lands as a JSON object; jsonb_typeof(after) = 'object'
await sql`insert … values (${sql.json(payload)}::jsonb)`;
```

`sql.json()` is postgres.js's own API: it tags the parameter with the jsonb
OID instead of leaving the server to infer it from the cast. (Passing the raw
object works too, and lands as an object as well — but `sql.json()` says what
it means, and it is what the code does.)

`tests/integration/accounting/journal-atomicity.test.ts` asserts the
difference with `jsonb_typeof`, so the trail cannot go back to being
unreadable without a test failing.

**The balance is checked at COMMIT, not at INSERT.** `accounting.journal_lines`
carries a deferred constraint trigger — `trg_journal_lines_balanced`,
`AFTER INSERT OR UPDATE … DEFERRABLE INITIALLY DEFERRED` — because an entry's
balance can only be judged once every one of its lines is present. The trigger
therefore fires at the end of the **enclosing transaction**, and under
autocommit that is the end of each individual statement, which is the wrong
moment: the first line of a two-line entry is judged on its own and the entry
is rejected with `journal <id> unbalanced: debits=120 credits=0`.

**Every posting must therefore be written inside one transaction.**
`src/lib/accounting/journal-bridge.ts` takes a transaction handle as a
**required first argument** for exactly this reason, so a call site that
forgets one does not compile. The behaviour is proved against a real postgres
by `tests/integration/accounting/journal-atomicity.test.ts`.

**A closed period and a bank line must not race.** The close reads the
warnings the operator has to acknowledge, and then closes the month. Between
those two acts there used to be no ordering at all — the read was one
transaction and the close another. A bank line dated in the month that landed
in that window was never shown to the operator, never acknowledged, and the
month closed over it anyway. The ledger was not corrupted (the posting guard
still refuses a posting into a closed period, so the line simply stays
uncategorised until the month is reopened), but the **confirmation was a
lie**: the operator was asked to acknowledge what was outstanding, and the
system shut a month over something they had not seen.

The close and the writes that change what it warns about are therefore
ordered by a **Postgres advisory lock**, one per (tenant, year, month):

```sql
select pg_advisory_xact_lock(hashtextextended('<tenant-id>:<year>:<month>', 0));
```

`pg_advisory_xact_lock` is released when the transaction ends — commit or
rollback — so a crash cannot leave a lock held and there is nothing to clean
up. It is re-entrant within a session, so the close can take it and the
re-read of the warnings can take it again.

| Who takes it | When |
| --- | --- |
| `src/lib/accounting/close.ts` | The whole close — the lock, the re-read of the warnings, the period row and its audit row — in **one transaction** |
| `src/lib/accounting/bank-import.ts` | A bank import, for **every month the statement touches**, before the first insert. The module owns the transaction, so a caller cannot supply one and forget the lock |
| `src/lib/accounting/journal-bridge.ts` | A journal posting, **before** the guard that refuses a posting into a closed period — the same ordering requirement, one line |
| `src/lib/accounting/periods.ts` | Opening, closing or reopening a period, so a period row cannot be created in the middle of somebody else's close |

Why an advisory lock and not `SELECT … FOR UPDATE`: a row lock needs a row.
A month with no postings has no period row yet — the journal bridge creates
rows lazily — so a bank import that had to lock the period row would have to
create it as a side effect, and a lock protocol that creates the rows it
locks is a lock protocol with a surprise in it. An advisory lock needs no
row, creates nothing, and is scoped exactly to (tenant, period): two
tenants, or two months of one tenant, never wait on each other.

Two rules the protocol depends on:

- **The lock must be taken on a transaction handle.** A lock taken on a
  pooled connection outside a transaction is released at the end of that
  statement and orders nothing at all. The application's pool is
  `max: 2`, so every statement inside a lock-holding transaction has to run
  on that transaction's handle — a second pooled statement while a
  transaction is open can exhaust the pool.
- **The months come from `posted_at`, in UTC.** A bank line posts into the
  month the bank posted it, and that is the clock the close preflight counts
  on. `bank_imports.period_id` is a different thing — the tenant's most
  recent **open** period, which is where the file is filed — and locking
  that month would order nothing.

Deadlock is avoided by taking multiple locks in a sorted `(year, month)`
order. A transaction that needs one month takes exactly one, so no cycle can
form.

The lock is the *ordering*; the *figures* are what the operator acknowledged.
An acknowledgement carries the warning's count and amount, not only its
name, because the warning's name does not change when a fourth bank line
lands — an acknowledgement that carried only the name would still match, and
the month would close over a line nobody saw.

Both halves are proved against a real postgres by
`tests/integration/accounting/close-race.test.ts`: a close whose
acknowledgement no longer matches the figures is refused, and a bank import
is shown to be **blocked on the lock** — checked in `pg_locks`, so a writer
queued for a connection cannot be mistaken for a writer waiting on the lock.
The gate was watched failing with the lock removed from the writer.

**The chart of accounts is a contract, and it was broken.** The ledger posts to
accounts by CODE — `1100` trade debtors, `2210` VAT payable to HMRC, `2200`
VAT output. Those codes are the only thing joining the journal to the schema,
and nothing in the database enforced them. The FRS 102 seed (migration 0065)
created 33 accounts and did not create `2200` "VAT Output", which rules 1 and
5 of the posting spec post to. The MTD VAT submission read

```sql
select id from accounting.chart_of_accounts where code = '2200'
```

and then `[0].id`, so with the account missing it threw

```
TypeError: Cannot read properties of undefined (reading 'id')
```

before the journal was reached: a return HMRC had already accepted never
reached the ledger, and the failure named no account at all. Migration
**0083** adds the account.

**Migration 0069 dropped the global uniqueness, and nothing replaced it.** It
replaced `unique (code)` with `unique (tenant_id, code)`, and because NULLs
are distinct in a unique index, every *global* row — `tenant_id IS NULL` —
fell outside the constraint entirely. A second global `2200` could have been
inserted, and a lookup by code would then have had two rows to choose
between. Migration 0083 restores the old invariant for the global rows with a
partial unique index (`chart_of_accounts_global_code_key`, and the same for
`vat_codes`), leaving a tenant's own copy of a code free to coexist with the
global one.

**One lookup, not six.** Six places asked for an account by code, each with
its own SQL and each reading `[0].id` — so a missing account was an
undefined-property crash rather than a named error, and a lookup by code alone
could not tell a tenant's own account from the global one. They now all go
through `src/lib/accounting/chart-of-accounts.ts`, which asks for the
tenant's own account first (the global one is the fallback), passes the code
as a parameter, and raises `MissingChartOfAccountsError` — naming the code —
when there is no such account.

**The MTD VAT return resolves its accounts BEFORE it calls HMRC.** A
submission HMRC has accepted cannot be taken back, so a chart of accounts that
cannot carry the posting stops the filing rather than orphaning it.

Both halves are proved rather than asserted.
`tests/integration/accounting/chart-of-accounts.test.ts` checks that every
account the ledger posts to exists with the right type and normal balance,
that a second global code is refused, and that a tenant's own account wins
over the global one. `tests/rls/accounting-portable-proof.sql` (assertions
11, 15 and 16) carries the same checks into the migration replay that runs in
CI — which that file did not do at all before, having been written and never
executed by anything.

### 5.4 How the accounting schema is tenant-scoped

The accounting schema is the one part of the product that **does not** follow
the `public` tenancy spine by default, and getting that wrong is a
cross-tenant data leak rather than a broken screen — so it is worth stating
exactly.

| Tables | Scope |
| --- | --- |
| `chart_of_accounts`, `vat_codes` | **Global.** Seeded once by migrations 0065/0066 and 0083; nothing provisions a per-tenant copy today, though the schema allows one — a tenant's own account shadows the global one when it has one (see §5.3). A tenant-scoped lookup would find nothing and every chart-of-accounts lookup in the product would break. They are reference data, not tenant data |
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
another's ledger. The tenant has to be in the SQL, and two gates hold it
there: `tests/unit/accounting/sql-contract.test.ts` holds every statement that
touches a tenant-scoped **accounting** table to containing `tenant_id`, and
`tests/unit/tenant-scope-contract.test.ts` holds **every** tenant-scoped table
the direct client touches — accounting and `public` alike — to being filtered
by itself, alias by alias. The policy is the second line of defence for any
connection that is *not* the superuser.

**And no such connection exists today.** The accounting schema carries **no
privileges at all** for any role other than the owner: `anon` and
`authenticated` — the two roles PostgREST uses — have neither USAGE on the
schema nor SELECT on a single table in it. That is deliberate, and it is the
stronger guarantee: the ledger cannot be served over HTTP even by accident,
because there is no grant for it to be served through. It also means the
policies are currently **unreachable** — the only connection that can read the
ledger is the superuser one, which bypasses them. So today the SQL contract is
the only active defence, and the policies are what would hold if a
non-superuser connection ever reached the schema.

Both halves of that are proved rather than asserted, by
`tests/rls/accounting-rls.test.ts` (`pnpm test:rls`), against a real
postgres:

- no browser-facing role has USAGE on the accounting schema or SELECT on
  `accounting.journal_lines`;
- row-level security is enabled on every tenant-scoped accounting table, and
  every one of them carries the restrictive `tenant_isolation` policy — the
  two sets are exactly the same set, so no table can be quietly left out;
- the audit log has no **permissive** policy that could rewrite it. A
  restrictive policy narrows and never grants, so the absence of a permissive
  UPDATE/DELETE policy is the protection, and a role holding every privilege
  still cannot update or delete a row;
- a member of one tenant sees none of another's ledger, and a caller with no
  identity at all sees nothing — proved by switching to the `authenticated`
  role inside a transaction, because a table's owner bypasses RLS and a proof
  run as `postgres` passes against policies that do nothing;
- and the checks are load-bearing: with the restrictive policy dropped the
  isolation really does leak, and with a permissive DELETE policy added the
  audit trail really does go.

The temporary grants the behavioural checks need are made inside a transaction
that is rolled back, so the deployed database is left exactly as it was found.

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

### 5.5 The VAT registration number (migration 0084)

`accounting.firs_credentials.vrn text` is the tenant's **VAT registration
number**, with a check constraint `vrn ~ '^[0-9]{3,15}$'`.

It had to be added: HMRC files a return at
`POST /organisations/vat/{vrn}/returns`, so the number is **in the path** —
it decides which organisation the return belongs to — and there was nowhere
to keep one. No column, no setting, no field on any screen. A submission
therefore had nothing to file against.

**It is not the `tin`.** The same table carries `tin`, which is the Nigerian
FIRS Tax Identification Number: a different country's identifier, on a table
that was renamed for the Nigerian programme. Filing a UK return against the
`tin` would file it against the wrong organisation, which is why the number
has its own column and its own field.

The number is per tenant, because a tenant is the thing that files returns.
The installation-wide `HMRC_MTD_VRN` is a **default one tenant adopts**, not
a fallback at filing time: the first tenant to connect to HMRC adopts it,
and no other tenant can take it. A VAT registration number belongs to one
organisation, so two tenants filing under the same number would be a
duplicate return at HMRC and one tenant's figures on another's record.
`setVrn` refuses a number another tenant already holds, the adoption is
serialised with an advisory lock, and the filing path reads the tenant's own
column and nothing else.

**One number, one tenant — at the database level too (migration 0085).** The
rule above was *checked* in the application and then *written* in a separate
statement, so two tenants saving the same number at the same moment both read
"nobody holds it" and both wrote it. The backstop is a partial unique index:

```sql
create unique index firs_credentials_vrn_unique
  on accounting.firs_credentials (vrn)
  where vrn is not null;
```

It is **partial** because a connection with no VAT registration number is
perfectly normal — there is one row per tenant and most of them have not been
given one — and NULL is already distinct from every other NULL in a unique
index. The application's advisory lock is the *first* line: it turns the common
case into a clean refusal ("that number belongs to another organisation")
rather than an exception. The index is the *backstop*, and refuses the second
write whatever the application does.

Migration 0085 clears any duplicates it finds **before** creating the index —
the index cannot be created while they exist, and a duplicate is itself the
bug the migration exists to close. The number stays on one connection, the
most recently active one; the others have theirs cleared, which puts the
conflict in front of the operator who caused it.

**A second, smaller rule about the same column.** The VRN is not part of the
credential upsert. `persistCredentials` writes the OAuth tokens with
`on conflict (tenant_id) do update`, and that clause only handles a conflict
on the index it names — a concurrent conflict on the *VRN* index is a
different index, so it would be an unhandled 23505 rather than a clean
refusal. The number is therefore written by its own `UPDATE` inside the same
transaction, under the same advisory lock.

### 5.6 Filing a return once — the four states (migration 0085)

`accounting.vat_submission_status` has four values, and the fourth is the one
that was missing:

| State | What it means |
| --- | --- |
| `pending_submission` | An attempt is talking to HMRC. It has not been accepted, and it has not been refused. |
| `accepted` | HMRC has the return and the ledger does not. |
| `submitted` | HMRC accepted it, and its ledger entry has landed. |
| `rejected` | HMRC refused it. Its own words are in `response_payload`. |

`pending_submission` used to mean two different things at once — *"an attempt
is talking to HMRC"* **and** *"HMRC took it and the ledger entry has not landed
yet"* — and the application told the two apart by whether a correlation id had
been written. The takeover path, which is what runs after a filing dies, did
not look at it. So a filing that HMRC accepted and that then died before its
journal entry landed left a row that said *"pending, never finished"*, and the
deliberate "file it again" button sent HMRC a **second** return for the same
period: a duplicate return at HMRC, and one organisation's figures counted
twice.

`accepted` is a state of its own, and it is the fix. A row in that state is
**never taken over**, so it cannot be filed again; what it *can* do is have
its ledger entry completed, which is a separate and idempotent operation. The
journal's idempotency key is `(tenant_id, 'vat_submission', submission_id)`,
so completing it twice posts it once.

Two columns carry the rest of it:

- **`claim_token uuid`** — the token of the filing attempt that currently
  owns the row. A settlement must present it. The settlement used to address
  the row by id alone, so an attempt that was slow could come back after a
  later attempt had taken the period over, and write its own answer over the
  row — turning a return HMRC had accepted into a "rejected" one that the
  next filing would happily send again. An attempt that no longer owns the row
  now changes **nothing**.
- **`vat_amount_pence bigint`** — the net VAT the return was **filed with**.
  The ledger entry is posted from this, so a return that is completed a week
  later posts the figure HMRC accepted, not whatever the invoices happen to
  say today.

The close preflight knows about `accepted`: a period whose return HMRC has
taken but whose ledger entry has not landed is closed with the warning
`vat_not_posted` — *"HMRC has accepted the VAT return for {period}, but its
ledger entry has not landed yet"* — because the books are behind the return
and the return cannot be filed again. The warning is not a block: the HMRC
connection is the operator's, so an install without one would otherwise have
every month close refused.

### 5.7 Restoring the ledger for the business that already happened (migration 0086)

Migration 0086 exists because the two automatic posting rules the design
spec names — **rule #1** (invoice issued: Dr 1100 / Cr 4000 / Cr 2200) and
**rule #2** (payment confirmed: Dr bank / Cr 1100) — had generators in
`src/lib/accounting/journal.ts` and **no call sites in the product at all**.
The rent cron raised invoices; the payment ingest took money; neither wrote to
the ledger. So a live deployment's trial balance contained none of the
business it was actually running — it contained the handful of bank lines
somebody had reconciled by hand, and nothing else. The VAT return was worse
than empty: it reported **£0 of output VAT** against £40,000 of rentals,
because `public.invoices.vat_code_id` had been null on every invoice since
migration 0067 and the return groups on it.

0086 repairs the history for a deployment that already holds data. It is a
**migration**, not a script an operator runs by hand, because it has to be
applied atomically with the rest of the schema and it has to be
**idempotent** — it is replayed by the migration runner, by the portability
proof, and by the CI regression harness.

Four helper functions carry it:

| Function | What it does |
| --- | --- |
| `accounting.ensure_period(tenant, year, month) → uuid` | Returns the period row for that month, creating it if it is absent. `accounting.periods` is unique on `(tenant_id, year, month)`, so the create is an upsert. |
| `accounting.account_id(code, tenant) → uuid` | The chart-of-accounts row for a code — the tenant's own account if it has one, the global row otherwise. **Raises** when the code is not there, naming the code and the tenant. |
| `accounting.payment_bank_account_id(tenant, bank_account) → uuid` | The GL account a payment is banked into: the bank account's own `gl_account_id`, else the tenant's default bank account, else the seeded `1200`. |
| `accounting.invoice_vat_code_id(vat_pence, tenant) → uuid` | The VAT code an invoice's VAT implies — `T0` when the VAT is zero, `T1` when it is not. **Raises** when the code is not there. |

A missing chart-of-accounts code is **fatal**, and the whole migration rolls
back with it. A ledger that cannot carry the business is worse than a ledger
that is empty, and a half-applied backfill — invoices posted, payments not —
is worse than both.

The backfill itself is three steps:

1. **Every invoice gets its VAT code.** `public.invoices.vat_code_id` is set
   from the invoice's own VAT amount. This is the step that makes the VAT
   return able to see the business at all.
2. **Every unposted, non-void invoice is posted** as rule #1, into the month
   the invoice was **issued** — not the month the migration happens to run.
3. **Every unposted, confirmed payment is posted** as rule #2, into the month
   the money was **received**.

Three things it deliberately does **not** do:

- **It does not post a void invoice.** A cancelled invoice has no revenue.
- **It does not post money that did not arrive.** A pending or failed payment
  is not a receipt.
- **It does not leave a zero line behind.** `journal_lines` carries
  `check ((debit_pence > 0) <> (credit_pence > 0))`, so a line that is zero
  on both sides is **illegal**, not merely empty. A zero-rated invoice is
  therefore posted as two lines (Dr 1100 / Cr 4000), never three.

**It writes into closed periods on purpose.** The alternative is to leave the
history out of the ledger, which is the thing being repaired: the rent was
due in April whether or not April is shut now. The application's guard —
`assertPeriodOpenForPosting` — still refuses **new** postings into a closed
period, so this restores history without opening a door.

Each posting is **idempotent** because the journal's own key is
`(tenant_id, source_type, source_id)`: a second run finds the entry that is
already there, adds no lines, and changes nothing. A backfill that added a
*second* set of lines would double the business's revenue while every
individual posting still looked correct, so the CI harness replays the
migration and compares the ledger's row counts before and after.

Every posting writes its `accounting.audit_log` row, so the restored history
is distinguishable from the history the application posted itself.

### 5.8 Voiding an invoice by reversal

An invoice raised by mistake has to be cancelled, and the cancellation has to
be **in the ledger** — not only a status on the row. A void that changes the
invoice's status but leaves the revenue on the books has moved the problem
rather than solved it.

**One transaction, five steps.** `src/lib/accounting/invoice-void.ts` owns the
whole thing, and the caller hands it a transaction handle:

1. **Lock the invoice** — `select … from public.invoices where id = $1 and
   tenant_id = $2 for update`. Another tenant's invoice is `not_found`, not a
   403 leak: the tenant is named in the SQL because this connection bypasses
   RLS. An invoice already `void` is `already_void`, and the function returns
   **without posting anything**.
2. **Read what has been received** — the sum of the allocations joined to
   **confirmed** payments, tenant-scoped on both sides. A `pending` or
   `failed` payment is not money.
3. **Find the original entry and its period** — `accounting.journal_entries`
   where `source_type = 'invoice'` and `source_id = $invoiceId`, joined to
   `accounting.periods` for the year and month. An invoice with no ledger
   entry (never posted, or posted by a migration that skipped it) is voided
   with `noLedgerEntry = true` and **no journal** — the reversal would have
   nothing to reverse.
4. **Post the reversal** — into the **original invoice's own month**, not the
   current one. A March invoice voided in November belongs to March: the
   business that raised it has already reported March, and putting the
   reversal in November would leave March's revenue overstated and November's
   understated. The period is read from the original entry and handed to
   `persistJournal`, whose guard refuses a closed or locked period — the
   route answers **409** and names the period.
5. **Mark the invoice void and write the audit row** — the status change and
   the `invoice_voided` audit row land in the same transaction, so a void
   cannot happen unrecorded.

**The credit is split, because a paid invoice is not a mirror.** The original
posting is Dr Trade Debtors (1100) gross / Cr Revenue (4000) net / Cr VAT
Output (2200) VAT. A plain mirror — Cr Trade Debtors gross — is right for an
unpaid invoice and **wrong** for a paid one: the payment already credited
Trade Debtors by the gross, so the account is back at zero, and a second credit
would leave it at **−gross**, a negative asset.

So the credit is split against what has actually been received:

| Line | Amount | When |
| --- | --- | --- |
| Cr Trade Debtors (1100) | `gross − received` | Only when something is still owed |
| Cr Refunds Payable (2120) | `received` | Only when money has been received |
| Dr Revenue (4000) | `net` | Always |
| Dr VAT Output (2200) | `vat` | Always |

`2120 Refunds Payable` was already seeded by migration 0065, so no migration
was needed — but the lookup is through the one chart-of-accounts module that
**names** a missing account rather than crashing on `undefined`. A zero line is
illegal: `check ((debit_pence > 0) <> (credit_pence > 0))` refuses a line that
is neither, so the split lines are omitted when their amount is zero rather
than written as `(0, 0)`.

**The lock order is invoice → period.** The rent cron already holds the
invoice's row lock when it calls the bridge (`select … for update` on the
invoice, then the posting takes the period lock), so the void follows the same
order. Taking the period lock first would invert against the cron and could
deadlock.

**Idempotency comes from the journal's own key.** `accounting.journal_entries`
carries `unique (tenant_id, source_type, source_id)`, and the reversal uses
`source_type = 'invoice_void'` with the invoice's id — so a replay cannot
post the reversal twice, even if the guard were bypassed. `invoice.posted_journal_id`
is deliberately **not** moved: it points at the issuance entry, and the reports
and the receivables ageing read it.

**No schema change was needed for any of this.** `accounting.journal_source_type`
already carried `invoice_void`, `accounting.audit_action` already carried
`invoice_voided`, and `2120` was already in the chart of accounts. What was
missing was the writer, the operator surface and the proof — §5.8's behaviour
is proved against a real postgres by
`tests/integration/accounting/invoice-void.test.ts` (8 cases: the original
month, exact ledger cancellation, the status and the audit row, the paid
invoice's 2120 credit, the double void, the closed period, the cross-tenant
refusal and the invoice with no ledger entry).

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
| `vrn ~ '^[0-9]{3,15}$'` | `accounting.firs_credentials` | A VAT registration number that is not 3 to 15 digits — the number goes in a URL path, so anything else is a wrong-organisation filing or a broken path |
| `vrn` is unique across tenants (partial unique index `firs_credentials_vrn_unique`) | `accounting.firs_credentials` | Two tenants holding one VAT registration number — one organisation filing under another's number |
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

**A voided invoice is worth nothing.** The guard above stops *money* landing on
a cancelled invoice. Migration 0087 closes the other side of the same hole:
the views that say what a customer *owes* used to include voided invoices at
their full gross, because `markInvoiceVoid` sets the status and changes
nothing else, and `v_invoice_balance` filtered on no status at all.

That was money leaving a customer's account.
`src/app/api/payments/checkout/route.ts` sums `balance_pence` for an
agreement and hands the sum to the payment provider as the amount to
**charge**; a cancelled invoice in that sum meant a customer was taken to a
payment page for work they no longer owed. `v_agreement_arrears` summed the
same column, so the operator's arrears screen showed the cancelled work as
still due.

The rule now is: **a void invoice contributes nothing to any amount owed.** It
stays **visible** — the operator must be able to see the document they
cancelled, and the customer must be able to see it in their invoice list — but
its `balance_pence` is zero, it is never `is_overdue`, and it is excluded from
all three of the arrears figures, so the row still adds up
(`outstanding_pence = billed_pence - collected_pence`).

The regression proof `standalone/sql/void-balance-proof.sql` fails against
0001–0086 and passes against 0001–0087. `hosted/tests/migrations-regression.sh`
runs it a second time against the views as migration 0011 left them and
requires it to **fail** there, so the proof is known to be able to fail.

**What "collected" means in these views.** The allocation sums in
`v_invoice_balance` and `v_agreement_arrears` count every allocation, whatever
state its payment is in, while `src/lib/accounting/invoice-register.ts` counts
only **confirmed** payments. No code path writes a payment in any state other
than `confirmed` today — all four insert sites write it explicitly — so the two
agree in practice. The difference only appears once a pending or refunded
payment becomes possible, and closing it then means changing the views, the
trigger `sync_invoice_status()` and the register together, so that a payment
changing state re-syncs the invoices it was allocated to.

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

### 6.1 The self-service password reset's own state (migration 0088)

Two pieces of state, in two different schemas, because they answer two
different questions.

**In `auth`, on the credential row** — `auth.local_credentials` gains two
columns:

| Column | What it holds |
| --- | --- |
| `reset_token_hash` | The **SHA-256** of the live reset token. Only the hash is stored: the database sits on the customer's own box, and a database that leaks must not hand out live reset links |
| `reset_expires_at` | When the token stops working. The application refuses a token whose expiry has passed, and a token with **no** expiry is treated as **expired** — a NULL read as "no limit" would be a link that never dies |

A partial index (`local_credentials_reset_token_idx`) covers the lookup, which
is by hash and never by the token itself. There is **one live token per
account**: a second request overwrites the first, so a link that was already
forwarded stops working.

**In `public`, the throttle's own table** — `password_reset_requests` records
who asked for a reset and from where, so the endpoint can be throttled the way
the one-time-code endpoint already is. Without it the endpoint is a mail
cannon: a script can put an unlimited number of reset emails into one
person's inbox.

Two things about that table are deliberate. **The rows are written only when a
link actually goes out** — an address that is not on file produces no mail, so
counting it would let a stranger burn a legitimate user's allowance by
guessing their address, and would let the throttle itself become an oracle for
which addresses are real. And the table is **revoked from `anon`,
`authenticated` and `service_role`**, with row-level security enabled: it is
reachable only over the application's own direct database connection, never
through the API.

The columns are added **idempotently**, and the whole block is guarded. The
shim already declares them, but `create table if not exists` only ever
CREATES the table — on a box that applied an older shim the columns never
arrive, and the application then fails with 42703 on the one screen that
exists so a locked-out person can get back in. And `auth.local_credentials`
does not exist at all on a Supabase-hosted database — there, Supabase Auth
owns the passwords — so the block checks first and says so in a notice rather
than failing the whole migration run and skipping every migration after it.

## 7. Operational state

| Table | What it is |
| --- | --- |
| `app_state` | Key/value operational flags: `bootstrap_pending`, `app_draining`. Read by the Node server through `localDb()` (a direct connection as the table owner) and by the Edge middleware over HTTP from PostgREST — see §7.1 |
| `schema_migrations` | The migration ledger: which migrations this database has applied — see §8.1 |
| `numbering_sequences` | Per-tenant document numbering (agreement numbers, invoice numbers) |
| `audit_log` | Append-only. Migration 0018 makes it immutable. Migration 0089 decides what a **system** action records as its actor — see §7.3 |
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

### 7.2 The first-run window — `app_state.bootstrap_pending`

The flag is a **cache of a fact the database already holds**: "does this
installation have an owner yet?".

| Moment | Value | Who writes it |
| --- | --- | --- |
| A fresh installation | `'1'` | Migration 0080 inserts the row. `brownhill-bootstrap.sh` inserts it with `ON CONFLICT DO NOTHING`, so a boot can never re-open a window the application has closed |
| First-run setup completes | `'0'` | `createFirstUserAndTenant()` — **in the same transaction** as the owner account and the tenant they operate |
| An installation that already has an owner but whose flag still says `'1'` | `'0'` | `firstRunOpen()` and `closeStaleFirstRunWindow()` — the server corrects a flag the database has already contradicted, rather than believing it |

The closing write is inside the transaction on purpose. The owner account,
the tenant and the closing of the window are one transition — "this
installation has an owner now" — and splitting them is how an installation
ends up with an owner and a flag that still says it is waiting for its first
run: a green setup on an application that still believes it is pending, with
the first-run door open behind the operator. In a transaction either all of
it lands or none of it does, so a setup that cannot close the window does not
report success, and a setup that fails leaves nothing half-made.

Both first-run doors read the flag before they serve — the signed
`/api/v1/bootstrap` and the browser `/api/auth/local/setup` — and both read
it through `localDb()`, as the table owner. The Edge middleware never sees
it (§7.1), which is why the first-run decision is made server-side.

### 7.3 The audit trail's actor — `audit_log.actor`

`audit_log.actor` is a foreign key to `auth.users(id)`, and `log_audit()`
defaults it to the user the request was made for.

| The request was made by | The actor recorded |
| --- | --- |
| A person | That person |
| The server — a cron job, an operations tool, the server signing on somebody's behalf | **Nothing.** The service principal is deliberately not a row in `auth.users`: an audit row attributing a cron job to a named employee would be a lie. The audit page renders a missing actor as "system" |
| A subject that is not a user id at all — the hosted build's service role carries the subject `supabase` | **Nothing**, and no error. A subject that cannot be read as a user id means "not a person", and that is an answer, not a failure |

The rule is that an action is **never lost because its actor could not be
established**. If the actor turns out not to be a user, the row is written
without one, and the drop is named in the database's own log. A failure that
has nothing to do with the actor — a tenant that does not exist, say — still
fails, loudly.

This is migration 0089, and it fixes a defect that was not visible from the
schema. `log_audit()` used to default the actor to `current_app_user()`
unconditionally, so every system write was refused by the foreign key
(23503) — and the twenty-four of the twenty-eight call sites that wrote
system actions threw the refusal away. The trail did not fail; it was
silently never written, and the only symptom was an empty table.

The application now writes every audit row through **one** writer,
`appendAudit` in `src/lib/audit.ts`, which looks at the error and reports a
refusal instead of discarding it. A contract test fails the build if any
module writes an audit row by hand.

## 8. Migrations

- 88 files, `0001`–`0089` (there is no `0057`; the number was never used).
- Applied in filename order, each in **its own transaction**, by
  `brownhill-bootstrap.service`.
- **Forward-only.** Never rolled back. Restoring an old application build
  against a current schema is safe; restoring an old schema against current
  data is not.
- The hosted deployment applies `standalone/sql/0000_supabase_shim.sql` first,
  then the migrations.
- **What has been applied is recorded**, in `public.schema_migrations` — see
  §8.1. The bootstrap is a systemd oneshot that runs on every boot, so it has
  to be a no-op against a database that is already provisioned, and it can
  only be a no-op if it knows what it already did.
- `supabase/seed.sql` provides the development seed: one tenant, four
  vehicles, four drivers, four agreements — two of them rent-to-buy, one of
  those live and one a draft — a rent schedule and invoices for thirty weeks
  of the live deal, the equity ledger, and the accounting chart of accounts.

### 8.1 The migration ledger — `public.schema_migrations`

| Column | Type | What it is |
| --- | --- | --- |
| `filename` | `text` primary key | The migration file, e.g. `0080_app_state.sql` |
| `checksum` | `text` | sha256 of the file as applied |
| `applied_at` | `timestamptz` | When it was applied |
| `source` | `text` | `applied` (this script ran it), `baseline` (the operator asserted it was already there), or `skipped` (deliberately not applied) |

RLS is on and the request roles are revoked, so nothing that reaches
PostgREST as `anon` or `authenticated` can read it. `service_role` bypasses
RLS by design and can; that role is the server's own.

**Why it exists.** The bootstrap is a systemd oneshot with `RemainAfterExit`,
so it runs on every boot. Until the ledger, it applied every migration from
the top on every run, and migration `0001` creates twenty-three enum types
with no guard — so the second run died on its first statement with
`ERROR: type "user_role" already exists` and the unit exited 3. The script's
header claimed it was idempotent. It was not.

**What it guarantees.**

- A migration is applied **at most once**. A re-run applies nothing.
- The migration and the ledger row that records it are applied in **one
  transaction**, so the two can never disagree — not even if the process is
  killed between them.
- A migration whose **content changed** after it was applied is refused, and
  the refusal names the file. The history is content-versioned, so a changed
  file means someone rewrote history.
- A database provisioned **before the ledger existed** can be adopted
  explicitly (`--baseline-through=<file>`), and a baseline that over-claims
  what is actually in the database is **refused** — the script checks that
  the tables, enum types and functions the claimed migrations create are
  really there.
- A **refused** baseline changes nothing. The claim is checked before the
  shim is applied and before any ledger row is written, so the refusal is
  the only trace and the database is exactly as it was found.

The ledger is the same idea Flyway, Liquibase and the Supabase CLI use, for
the same reason: a forward-only history needs to know where "forward"
currently is.

**Operating it.** Three options, each with an environment-variable equivalent
so a systemd drop-in can set it:

| Option | Environment variable | What it does |
| --- | --- | --- |
| `--status` | — | Report what the ledger sees, and the cut to baseline through. Does not touch the application's schema. |
| `--baseline-through=FILE` | `BROWNHILL_BASELINE_THROUGH` | Adopt a database provisioned before the ledger existed. FILE and every migration before it are recorded as applied. Checked against the database, and refused if the claim is false. |
| `--skip=FILE[,FILE...]` | `BROWNHILL_SKIP_MIGRATIONS` | Do not apply these migrations. Recorded as `skipped`, so they are not retried. |

`--baseline-through=FILE` is inclusive: it claims FILE **and** everything
before it, so the file an operator names is the last one already applied.
That is what makes the whole-history case expressible — a database that
already has everything can be adopted by naming its last migration, with
nothing applied again.

**How the claim is checked.** The ledger fingerprints each migration: the set
of tables, enum types and functions it creates. The baseline is accepted only
if the database really has those objects. Three details make that check
honest rather than nominal, and each of them was a bug first:

- The fingerprint sees **all three kinds** of object. It used to see tables
  only — three greps shared one stdin, so the first consumed the stream and
  the others matched nothing — which meant a baseline claiming a migration
  that creates only enum types found nothing to check and was accepted
  against an empty database.
- A function's **name ends at its parameter list**. Read off the token whole,
  `fn_x(p_vehicle uuid)` became `fn_xp_vehicle`, which matches no function in
  the database, and the baseline was refused against a database that has it.
- A migration can **rename** what an earlier one created — `0069` renames
  `accounting.mtd_credentials` to `accounting.firs_credentials` — so the
  object is in the database under a name the fingerprint never saw. The
  check accepts it under **either** name.

`hosted/tests/schema-ledger-fingerprint.sh` is the gate for all three.

The variable names are spelled one way throughout the repository, and
`hosted/tests/env-var-names.sh` fails the build if a second spelling appears.
A variable that is set under one spelling and read under another is not a
failure — it is silence, and the script carries on with a fallback that
happens to work on the developer's machine and not on the box. The full
procedure for adopting a live database is in
[the deploy runbook](../../runbook/brownhill-namecheap-deploy-2026-10-07.md).

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
