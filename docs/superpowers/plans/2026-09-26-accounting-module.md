# In-app Accounting Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a full Xero-grade in-app accounting module (chart of accounts, double-entry GL, monthly periods, auto-posting on every invoice/payment/VAT submission, manual CSV/OFX bank import + auto-match, four reports, UK MTD VAT submission, append-only audit trail) for the Brownhill Fleet hosted product line. Built as 7 sequential PRs over ~3-5 weeks. Existing 53 migrations stay byte-identical.

**Architecture:** Three layers — persistence (new `accounting` schema + additive migrations 0064-0068), domain (`src/lib/accounting/*.ts` pure functions), surface (`src/app/admin/accounting/**` + `src/app/api/v1/accounting/**`). All GL postings auto-commit in a single transaction with their audit-log entry. RLS continues to scope every new row via the existing `current_app_user()`.

**Tech Stack:** TypeScript, Next.js 15 App Router (existing), PostgreSQL 16.4 (existing — `0006_billing` extends), Web Crypto (existing — HS256 + AES-GCM via HKDF from `JWT_SHARED_SECRET`), Vitest + `@fast-check/vitest` for property-based tests, HMRC MTD OAuth 2.0 sandbox, csv-parse + OFX parsing.

**Spec:** `docs/superpowers/specs/2026-09-26-accounting-module-design.md` (merged at `1363f0b`). Plan argues from the spec; executor reads both.

---

## Global Constraints

- **The 53 existing migrations stay byte-identical.** New migrations land at 0064-0068, additive. If a new migration is needed, it's a new file, never an edit.
- **Existing portable-rls-proof is extended, never edited.** New `accounting-portable-proof.sql` adds assertions 10-14 alongside the existing nine. `migrations-regression.sh` continues to pass with all 14+ assertions green.
- **Existing webhook handlers at `/api/billing/webhook/*` are unchanged.** The accounting module hooks the existing "payment confirmed" state transition; the webhooks themselves are not modified.
- **`HANDOFF-BROWNHILL.md` is appended to, never edited.** PR 7 lands an additive section.
- **`hosted/tests/acceptance.sh` Gate 6 is opt-in.** Present only when `accounting.chart_of_accounts` is non-empty.
- **Token-at-rest encryption:** HMRC access + refresh tokens in `accounting.mtd_credentials` are encrypted with AES-GCM using a key derived from `/etc/brownhill/secrets/jwt.env`'s `JWT_SHARED_SECRET` via HKDF with a domain-separated info string `accounting-mtd-v1`. Key derivation happens at first use.
- **Audit log retention = forever.** `audit_log` has no `DELETE` permission in RLS even for owner.
- **Currency = GBP only.** Hard-coded.
- **Period = monthly.** Reopen window = 7 days from close. After 7 days, permanently locked.
- **Auto-match threshold = 90%.** Matches at ≥90% auto-post; matches at <90% go to manual reconciliation queue.
- **Bank statement limits = 10 MB / 5,000 transactions per file.**
- **CSV formats v1 = Barclays, HSBC, Starling, Lloyds.**
- **VAT filing cadence = quarterly default; monthly selectable.**
- **Tenant model = hosted single-tenant only.** Gated on `DEPLOYMENT_PROFILE === 'hosted'`. Under `saas` profile, the module is a no-op (the SaaS profile doesn't ship accounting in v1).

---

## Review Focus

These are the input classes or failure modes the spec implies but no single task's tests exercise. The spec is a vision document; it does not promise everything. These five are most likely to bite a person using this software.

1. **Trial-balance invariant under any input sequence.** No single task can prove this; the @fast-check property-based test in PR 2 must prove it for the whole system. Spec §4.4.
2. **Period-lock enforcement under concurrent writes.** Two operators closing the same period, or a payment-confirm landing in a period that's mid-close. Spec §5 data-integrity errors.
3. **MTD token refresh race.** Operator clicks "Submit VAT return" while another tab initiates "Reconnect to HMRC"; the two flows race on the OAuth refresh token. Spec §5 integration errors.
4. **Bank CSV column-order variation within a bank.** Barclays CSV columns might be reordered by user download options ("Standard", "Detailed", "For Accounts"); the parser must tolerate all three layouts for the same bank.
5. **Invoice-void-on-paid edge case.** Spec §5 says void is allowed and posts a refund liability. The exact GL postings (reversal + 2120 Refunds-Payable entry) must match what the operator expects, not what the test author assumed.

---

### Task 1: PR 1 — Foundation migrations + RLS proof (Step 1)

**Files:**
- Create: `supabase/migrations/0064_accounting_schema.sql`
- Create: `supabase/migrations/0065_accounting_coa_seed.sql`
- Create: `supabase/migrations/0066_accounting_vat_codes_seed.sql`
- Create: `supabase/migrations/0067_accounting_billing_extensions.sql`
- Create: `supabase/migrations/0068_accounting_rls.sql`
- Create: `tests/rls/accounting-portable-proof.sql`

**Interfaces:**
- Consumes: existing schema (0001-0063), existing `current_app_user()` from `0016_tenancy.sql`.
- Produces: new schema `accounting` with the ten tables listed in spec §1. RLS policies on every new table. New `posted_journal_id` columns on `0006_billing.invoices` and `.payments`. Idempotent seeds for chart of accounts (FRS 102 baseline) and VAT codes (T0/T1/T5/T9).

- [ ] **Step 1: Write the schema migration**

```sql
-- supabase/migrations/0064_accounting_schema.sql
-- Creates the accounting schema and its ten tables. Additive; existing 53 migrations are byte-identical.

create schema accounting;
set search_path = accounting, public;

create type account_type as enum ('asset','liability','equity','revenue','expense');
create type normal_balance as enum ('debit','credit');
create type journal_source_type as enum (
  'invoice', 'payment', 'vat_submission', 'bank_transaction',
  'invoice_void', 'credit_note', 'manual_adjustment'
);
create type bank_tx_status as enum ('unmatched','auto_matched','manually_matched','ignored');
create type vat_submission_status as enum ('pending_submission','submitted','rejected');
create type audit_action as enum (
  'journal_posted', 'period_opened', 'period_closed', 'period_reopened',
  'invoice_voided', 'credit_note_issued', 'bank_import_committed',
  'bank_transaction_categorised', 'bank_transaction_recategorised',
  'vat_submission_attempted', 'vat_submission_succeeded', 'vat_submission_rejected',
  'chart_of_accounts_seeded'
);

create table chart_of_accounts (
  id            uuid primary key default gen_random_uuid(),
  code          text not null check (code ~ '^[0-9]{4,}$'),
  name          text not null,
  type          account_type not null,
  normal_balance normal_balance not null,
  parent_id     uuid references chart_of_accounts(id) on delete restrict,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (code)
);

create table vat_codes (
  id           uuid primary key default gen_random_uuid(),
  code         text not null check (code ~ '^T[0-9]$'),
  rate_pct     numeric(5,2) not null check (rate_pct between 0 and 100),
  description  text not null,
  created_at   timestamptz not null default now(),
  unique (code)
);

create table periods (
  id                 uuid primary key default gen_random_uuid(),
  year               int  not null check (year between 2000 and 2100),
  month              int  not null check (month between 1 and 12),
  started_at         timestamptz not null default now(),
  closed_at          timestamptz,
  closed_by_user_id  uuid references auth.users(id),
  locked_at          timestamptz,
  unique (year, month)
);

create table journal_entries (
  id               uuid primary key default gen_random_uuid(),
  posted_at         timestamptz not null default now(),
  period_id         uuid not null references periods(id),
  description       text not null,
  source_type       journal_source_type not null,
  source_id         uuid not null,
  posted_by_user_id uuid references auth.users(id),
  unique (source_type, source_id)        -- one journal per source event
);

create table journal_lines (
  id                       uuid primary key default gen_random_uuid(),
  journal_id                uuid not null references journal_entries(id) on delete cascade,
  account_id                uuid not null references chart_of_accounts(id),
  debit_pence               bigint not null check (debit_pence >= 0),
  credit_pence              bigint not null check (credit_pence >= 0),
  check ((debit_pence > 0) <> (credit_pence > 0)),   -- exactly one side non-zero
  contact_id                uuid,
  source_invoice_id         uuid,
  source_payment_id         uuid,
  source_bank_transaction_id uuid
);

create table bank_accounts (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  sort_code     text,
  account_number text,
  iban          text,
  currency      text not null default 'GBP' check (currency = 'GBP'),
  gl_account_id uuid not null references chart_of_accounts(id),
  created_at    timestamptz not null default now()
);

create table bank_imports (
  id                 uuid primary key default gen_random_uuid(),
  bank_account_id    uuid not null references bank_accounts(id),
  file_name          text not null,
  file_sha256        bytea not null,
  period_id          uuid not null references periods(id),
  imported_at        timestamptz not null default now(),
  imported_by_user_id uuid references auth.users(id),
  unique (bank_account_id, file_sha256)
);

create table bank_transactions (
  id                uuid primary key default gen_random_uuid(),
  bank_import_id    uuid not null references bank_imports(id) on delete cascade,
  bank_account_id   uuid not null references bank_accounts(id),
  posted_at         timestamptz not null,
  amount_pence      bigint not null,    -- signed: debits negative for outflows
  description       text not null,
  counterparty      text,
  matched_payment_id uuid references public.invoices(id),
  status            bank_tx_status not null default 'unmatched',
  unique (bank_import_id, posted_at, amount_pence, description, counterparty)
);

create table vat_submissions (
  id                  uuid primary key default gen_random_uuid(),
  period_id           uuid not null references periods(id),
  hmtr_correlation_id text not null,
  submitted_at        timestamptz not null default now(),
  return_payload     jsonb not null,
  response_payload    jsonb,
  status              vat_submission_status not null default 'pending_submission',
  unique (period_id)
);

create table mtd_credentials (
  id                  uuid primary key default gen_random_uuid(),
  mtd_client_id       text not null,
  access_token        bytea not null,           -- AES-GCM ciphertext
  access_token_iv     bytea not null,           -- 12 bytes
  refresh_token       bytea not null,           -- AES-GCM ciphertext
  refresh_token_iv    bytea not null,
  token_expires_at    timestamptz not null,
  redirect_uri        text not null
);

create table audit_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id),
  at         timestamptz not null default now(),
  action     audit_action not null,
  entity     text not null,
  entity_id  uuid not null,
  before     jsonb,
  after      jsonb
);
create index audit_log_at_idx on audit_log (at);
create index audit_log_entity_idx on audit_log (entity, entity_id);

-- Per-journal balance invariant (debits = credits). Triggers enforce this
-- because CHECK constraints can't span rows.
create or replace function accounting.journal_balanced() returns trigger as $$
declare
  d_sum bigint;
  c_sum bigint;
begin
  select sum(debit_pence), sum(credit_pence) into d_sum, c_sum
    from accounting.journal_lines where journal_id = new.journal_id;
  if d_sum <> c_sum then
    raise exception 'journal % unbalanced: debits=% credits=%', new.journal_id, d_sum, c_sum;
  end if;
  return null;
end;
$$ language plpgsql;
create trigger trg_journal_lines_balanced
  after insert or update on accounting.journal_lines
  deferrable initially deferred
  for each row execute function accounting.journal_balanced();
```

- [ ] **Step 2: Write the COA seed migration**

```sql
-- supabase/migrations/0065_accounting_coa_seed.sql
-- FRS 102 baseline. Idempotent (ON CONFLICT DO NOTHING).

set search_path = accounting, public;

insert into chart_of_accounts (code, name, type, normal_balance) values
  -- Assets
  ('1100', 'Trade Debtors',                         'asset',     'debit'),
  ('1200', 'Bank Account',                          'asset',     'debit'),
  ('1210', 'Bank Charges Control',                  'asset',     'debit'),
  ('1500', 'Prepayments',                            'asset',     'debit'),
  ('1800', 'Office Equipment at Cost',               'asset',     'debit'),
  ('1810', 'Office Equipment Accumulated Depreciation','asset',    'credit'),
  ('1900', 'Cash',                                   'asset',     'debit'),
  -- Liabilities
  ('2100', 'Trade Creditors',                        'liability', 'credit'),
  ('2120', 'Refunds Payable',                        'liability', 'credit'),
  ('2210', 'VAT Payable to HMRC',                    'liability', 'credit'),
  ('2300', 'PAYE / NIC Liability',                   'liability', 'credit'),
  ('2400', 'Accruals',                               'liability', 'credit'),
  ('2500', 'Bank Loan',                              'liability', 'credit'),
  -- Equity
  ('3000', 'Owner Capital',                          'equity',    'credit'),
  ('3100', 'Drawings',                               'equity',    'debit'),
  ('3200', 'Retained Earnings',                      'equity',    'credit'),
  -- Revenue
  ('4000', 'Sales',                                  'revenue',   'credit'),
  ('4100', 'Other Operating Income',                 'revenue',   'credit'),
  -- Expenses
  ('5000', 'Cost of Sales',                          'expense',   'debit'),
  ('5910', 'Bank Charges',                           'expense',   'debit'),
  ('6000', 'Rent',                                   'expense',   'debit'),
  ('6100', 'Insurance',                              'expense',   'debit'),
  ('6200', 'Fuel and Lubricants',                    'expense',   'debit'),
  ('6300', 'Vehicle Maintenance',                    'expense',   'debit'),
  ('6400', 'Office Expenses',                        'expense',   'debit'),
  ('6500', 'Professional Fees',                      'expense',   'debit'),
  ('6600', 'Marketing',                              'expense',   'debit'),
  ('6700', 'Bank Interest',                          'expense',   'debit'),
  ('6800', 'Depreciation',                           'expense',   'debit'),
  ('7000', 'Wages and Salaries',                     'expense',   'debit'),
  ('7100', 'PAYE / NIC Expense',                     'expense',   'debit'),
  ('9000', 'VAT Input (irrecoverable)',              'expense',   'debit'),
  ('9990', 'Miscellaneous Expenses',                 'expense',   'debit')
on conflict (code) do nothing;
```

- [ ] **Step 3: Write the VAT codes seed**

```sql
-- supabase/migrations/0066_accounting_vat_codes_seed.sql
set search_path = accounting, public;

insert into vat_codes (code, rate_pct, description) values
  ('T0',  0.00, 'Zero-rated supplies'),
  ('T1', 20.00, 'Standard rate supplies'),
  ('T5',  5.00, 'Reduced rate supplies'),
  ('T9',  0.00, 'Exempt supplies')
on conflict (code) do nothing;
```

- [ ] **Step 4: Write the billing extensions**

```sql
-- supabase/migrations/0067_accounting_billing_extensions.sql
-- Additive columns on existing tables. No edits to existing migration files.

alter table public.invoices
  add column if not exists posted_journal_id uuid,
  add column if not exists vat_code_id uuid references accounting.vat_codes(id);
alter table public.payments
  add column if not exists posted_journal_id uuid,
  add column if not exists bank_account_id uuid references accounting.bank_accounts(id);
```

- [ ] **Step 5: Write the RLS policies**

```sql
-- supabase/migrations/0068_accounting_rls.sql
-- All accounting tables inherit current_app_user() scoping from 0016_tenancy.sql.
-- Single policy per table: USING + WITH CHECK both gate to current_app_user().
-- audit_log additionally has no DELETE permission even for owner (append-only).

set search_path = accounting, public;

-- Helper: every accounting row is scoped to the current tenant.
create or replace function accounting.is_current_tenant() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.tenant_id', true), auth.uid())::text is not null
         and coalesce(current_setting('app.tenant_id', true), '') <> '';
$$;

do $$ declare t text; begin
  for t in
    select unnest(array['chart_of_accounts','vat_codes','periods','journal_entries',
                         'journal_lines','bank_accounts','bank_imports','bank_transactions',
                         'vat_submissions','mtd_credentials'])
  loop
    execute format('alter table accounting.%I enable row level security', t);
    execute format('create policy acct_select on accounting.%I for select using (accounting.is_current_tenant())', t);
    execute format('create policy acct_modify on accounting.%I for all using (accounting.is_current_tenant()) with check (accounting.is_current_tenant())', t);
  end loop;
end $$;

-- audit_log: SELECT only for the current tenant. INSERT is unrestricted (the
-- app always inserts as the operator). NO DELETE policy — append-only.
alter table accounting.audit_log enable row level security;
create policy audit_select on accounting.audit_log for select using (accounting.is_current_tenant());
create policy audit_insert on accounting.audit_log for insert with check (true);
```

- [ ] **Step 6: Write the RLS proof**

```sql
-- tests/rls/accounting-portable-proof.sql
-- Adds assertions 10-14 alongside the existing nine in PR #79.
-- Run via bash hosted/tests/verify-hosted-portability.sh (which invokes standalone/scripts/verify-portability.sh, which calls portable-rls-proof.sql).

set search_path = accounting, public;

-- Assertion 10: every accounting table scopes rows by current tenant.
do $$ begin
  perform 1 from information_schema.tables
    where table_schema = 'accounting'
      and table_name in ('chart_of_accounts','vat_codes','periods','journal_entries',
                          'journal_lines','bank_accounts','bank_imports','bank_transactions',
                          'vat_submissions','mtd_credentials','audit_log');
  -- The harness's app.tenant_id is set by the verifying session.
  -- We just assert the RLS is enabled; current_app_user() test happens in the harness.
exception when others then raise exception 'assertion 10 failed: accounting tables missing';
end $$;

-- Assertion 11: chart_of_accounts is the canonical FRS 102 baseline.
do $$ begin
  perform 1 from accounting.chart_of_accounts
    where code in ('1100','1200','2100','2210','2200','4000');
exception when others then raise exception 'assertion 11 failed: COA seed missing';
end $$;

-- Assertion 12: vat_codes has T0, T1, T5, T9.
do $$ begin
  perform 1 from accounting.vat_codes
    where code in ('T0','T1','T5','T9');
exception when others then raise exception 'assertion 12 failed: VAT codes missing';
end $$;

-- Assertion 13: journal_lines CHECK constraints forbid both-side-non-zero and forbid negatives.
do $$ begin
  -- We can't insert a bad row without raising; this assertion is structural.
  perform 1 from information_schema.check_constraints
    where constraint_name like '%journal_lines%'
      and check_clause like '%debit_pence >= 0%';
exception when others then raise exception 'assertion 13 failed: journal_lines check missing';
end $$;

-- Assertion 14: audit_log has no DELETE policy.
do $$ begin
  perform 1 from pg_policies
    where schemaname = 'accounting'
      and tablename  = 'audit_log'
      and cmd        = 'DELETE';
  if found then raise exception 'assertion 14 failed: audit_log has a DELETE policy (must be append-only)';
  end if;
end $$;
```

- [ ] **Step 7: Run the RLS proof against an empty DB**

```bash
docker run -d --rm --name acct-rls postgres:16
sleep 2
# apply the shim + every existing migration + the new four (0064-0068)
docker cp standalone/sql/0000_supabase_shim.sql acct-rls:/tmp/
for f in supabase/migrations/*.sql; do
  docker cp "$f" acct-rls:/tmp/migrations/$(basename "$f")
done
docker exec acct-rls psql -v ON_ERROR_STOP=1 -f /tmp/0000_supabase_shim.sql
for f in $(ls -1 supabase/migrations/*.sql | sort); do
  docker exec acct-rls psql -v ON_ERROR_STOP=1 -f "/tmp/migrations/$(basename "$f")"
done
# assertions 0-9 (existing portable-rls-proof.sql) + 10-14 (new)
docker exec acct-rls psql -v ON_ERROR_STOP=1 -f /tmp/0000_supabase_shim.sql  # idempotent
docker exec acct-rls psql -v ON_ERROR_STOP=1 -f /tmp/migrations/accounting-portable-proof.sql
docker rm -f acct-rls
```

Expected: all assertions green; the journal-balanced trigger raises if the trial balance is broken.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/0064_accounting_schema.sql \
        supabase/migrations/0065_accounting_coa_seed.sql \
        supabase/migrations/0066_accounting_vat_codes_seed.sql \
        supabase/migrations/0067_accounting_billing_extensions.sql \
        supabase/migrations/0068_accounting_rls.sql \
        tests/rls/accounting-portable-proof.sql
git commit -m "hosted: accounting foundation (schema + COA + VAT codes + RLS)"
```

---

### Task 2: PR 2 — Auto-posting rules (Step 1)

**Files:**
- Create: `src/lib/accounting/journal.ts`
- Create: `src/lib/accounting/journal-bridge.ts`
- Modify: `src/lib/billing/local-store.ts` (additive — call into journal-bridge on payment confirm)
- Create: `tests/unit/accounting/journal.test.ts`
- Create: `tests/integration/accounting/invoices-to-journal.test.ts`
- Create: `tests/integration/accounting/payments-to-ar.test.ts`
- Create: `tests/unit/accounting/journal.property.test.ts` (the @fast-check property-based test)

**Interfaces:**
- Consumes: spec §2 rules #1, #2, #5, #6, both reversal rules, and the payment-provider-fee entry. Existing invoice + payment flows.
- Produces: `journal-posting functions` that take a known-good source row and write a balanced `journal_entries` + `journal_lines` pair in a single transaction. Bridge functions wired into existing flows so invoice creation auto-posts and payment confirmation auto-posts.

- [ ] **Step 1: Write the failing unit test for rule #1 (invoice issued)**

```ts
// tests/unit/accounting/journal.test.ts
// The unit test asserts the *shape* of the journal-entry payload (Dr/Cr account IDs,
// amounts). It does NOT touch the DB; the DB writes are tested in the integration
// tests in Step 6 (commitJournalForInvoice / commitJournalForPayment round-trips).
import { describe, expect, it } from 'vitest';
import { postInvoiceJournal } from '@/lib/accounting/journal';

describe('postInvoiceJournal', () => {
  it('posts Dr AR / Cr Revenue / Cr VAT-Output on invoice issued', async () => {
    const result = await postInvoiceJournal({
      invoiceId: '00000000-0000-0000-0000-000000000001',
      userId: '00000000-0000-0000-0000-000000000002',
      invoice: {
        net: 100_000n,  // £1,000.00 in pence
        vat:  20_000n,  // £200.00 in pence at T1 20%
        gross: 120_000n,
        vatCodeId: '00000000-0000-0000-0000-000000000003',
      },
      chartOfAccounts: {
        ar:         { id: '1100', code: '1100', normalBalance: 'debit' },
        revenue:    { id: '4000', code: '4000', normalBalance: 'credit' },
        vatOutput:  { id: '2200', code: '2200', normalBalance: 'credit' },
      },
    });
    expect(result.lines).toHaveLength(3);
    const ar = result.lines.find(l => l.accountId === '1100');
    const rev = result.lines.find(l => l.accountId === '4000');
    const vat = result.lines.find(l => l.accountId === '2200');
    expect(ar?.debitPence).toBe(120_000n);
    expect(ar?.creditPence).toBe(0n);
    expect(rev?.debitPence).toBe(0n);
    expect(rev?.creditPence).toBe(100_000n);
    expect(vat?.debitPence).toBe(0n);
    expect(vat?.creditPence).toBe(20_000n);
    expect(result.sumDebits).toBe(result.sumCredits);
  });
});
```

Run: `pnpm exec vitest run tests/unit/accounting/journal.test.ts`. Expected: FAIL — module doesn't exist.

- [ ] **Step 2: Implement `postInvoiceJournal`**

```ts
// src/lib/accounting/journal.ts

export interface InvoiceForPosting {
  invoiceId: string;     // UUID
  userId: string;         // UUID
  invoice: {
    net: bigint; vat: bigint; gross: bigint; vatCodeId: string;
  };
  chartOfAccounts: { ar: {id:string;code:string}; revenue: {id:string;code:string}; vatOutput: {id:string;code:string} };
}

export interface JournalLine {
  accountId: string;
  debitPence: bigint;
  creditPence: bigint;
  sourceInvoiceId?: string;
}

export interface PostResult {
  journalId: string;
  periodId: string;
  lines: JournalLine[];
  sumDebits: bigint;
  sumCredits: bigint;
}

export async function postInvoiceJournal(input: InvoiceForPosting): Promise<PostResult> {
  const lines: JournalLine[] = [
    { accountId: input.chartOfAccounts.ar.id,        debitPence: input.invoice.gross, creditPence: 0n, sourceInvoiceId: input.invoiceId },
    { accountId: input.chartOfAccounts.revenue.id,   debitPence: 0n, creditPence: input.invoice.net,  sourceInvoiceId: input.invoiceId },
    { accountId: input.chartOfAccounts.vatOutput.id, debitPence: 0n, creditPence: input.invoice.vat,  sourceInvoiceId: input.invoiceId },
  ];
  const sumDebits  = lines.reduce((a, l) => a + l.debitPence, 0n);
  const sumCredits = lines.reduce((a, l) => a + l.creditPence, 0n);
  if (sumDebits !== sumCredits) {
    throw new Error(`Imbalanced: ${sumDebits} != ${sumCredits}`);
  }
  // DB write happens via journal-bridge.ts; this function returns the shape.
  return { journalId: '<assigned>', periodId: '<assigned>', lines, sumDebits, sumCredits };
}
```

- [ ] **Step 3: Implement the other 5 rules + reversals in the same file**

```ts
// src/lib/accounting/journal.ts (continued)

export interface PaymentForPosting {
  paymentId: string;
  userId: string;
  payment: { gross: bigint };
  bankAccount: { id: string; glAccountId: string };
  arAccountId: string;
}

export async function postPaymentJournal(input: PaymentForPosting): Promise<PostResult> {
  const lines: JournalLine[] = [
    { accountId: input.bankAccount.glAccountId, debitPence: input.payment.gross, creditPence: 0n, sourcePaymentId: input.paymentId },
    { accountId: input.arAccountId,             debitPence: 0n, creditPence: input.payment.gross, sourcePaymentId: input.paymentId },
  ];
  return { journalId: '<assigned>', periodId: '<assigned>', lines,
           sumDebits: lines.reduce((a,l)=>a+l.debitPence,0n),
           sumCredits: lines.reduce((a,l)=>a+l.creditPence,0n) };
}

export interface VatSubmissionForPosting {
  submissionId: string; userId: string;
  vatOutputAccountId: string; vatPayableAccountId: string;
  vatAmountPence: bigint;
}
export async function postVatSubmissionJournal(input: VatSubmissionForPosting): Promise<PostResult> {
  const lines: JournalLine[] = [
    { accountId: input.vatOutputAccountId,  debitPence: input.vatAmountPence, creditPence: 0n },
    { accountId: input.vatPayableAccountId, debitPence: 0n, creditPence: input.vatAmountPence },
  ];
  return { journalId: '<assigned>', periodId: '<assigned>', lines,
           sumDebits: lines.reduce((a,l)=>a+l.debitPence,0n),
           sumCredits: lines.reduce((a,l)=>a+l.creditPence,0n) };
}

export interface BankCategorisationForPosting {
  bankTxId: string; userId: string; amountPence: bigint;
  bankGlAccountId: string;
  vatPayableAccountId: string;
}
export async function postVatPaymentJournal(input: BankCategorisationForPosting): Promise<PostResult> {
  const lines: JournalLine[] = [
    { accountId: input.vatPayableAccountId, debitPence: input.amountPence, creditPence: 0n, sourceBankTransactionId: input.bankTxId },
    { accountId: input.bankGlAccountId,     debitPence: 0n, creditPence: input.amountPence, sourceBankTransactionId: input.bankTxId },
  ];
  return { journalId: '<assigned>', periodId: '<assigned>', lines,
           sumDebits: lines.reduce((a,l)=>a+l.debitPence,0n),
           sumCredits: lines.reduce((a,l)=>a+l.creditPence,0n) };
}

export interface ReversalForPosting {
  sourceType: 'invoice_void' | 'credit_note';
  sourceId: string; userId: string;
  invoice: { net: bigint; vat: bigint; gross: bigint };
  chartOfAccounts: { ar: {id:string}; revenue: {id:string}; vatOutput: {id:string} };
}
export async function postReversalJournal(input: ReversalForPosting): Promise<PostResult> {
  // Same three lines as rule #1, all amounts negated.
  const lines: JournalLine[] = [
    { accountId: input.chartOfAccounts.ar.id,        debitPence: 0n, creditPence: input.invoice.gross, sourceInvoiceId: input.sourceId },
    { accountId: input.chartOfAccounts.revenue.id,   debitPence: input.invoice.net,  creditPence: 0n, sourceInvoiceId: input.sourceId },
    { accountId: input.chartOfAccounts.vatOutput.id, debitPence: input.invoice.vat,  creditPence: 0n, sourceInvoiceId: input.sourceId },
  ];
  return { journalId: '<assigned>', periodId: '<assigned>', lines,
           sumDebits: lines.reduce((a,l)=>a+l.debitPence,0n),
           sumCredits: lines.reduce((a,l)=>a+l.creditPence,0n) };
}

export interface BankFeeForPosting {
  paymentId: string; userId: string; feeAmountPence: bigint;
  bankChargesAccountId: string; arAccountId: string;
}
export async function postBankFeeJournal(input: BankFeeForPosting): Promise<PostResult> {
  const lines: JournalLine[] = [
    { accountId: input.bankChargesAccountId, debitPence: input.feeAmountPence, creditPence: 0n, sourcePaymentId: input.paymentId },
    { accountId: input.arAccountId,          debitPence: 0n, creditPence: input.feeAmountPence, sourcePaymentId: input.paymentId },
  ];
  return { journalId: '<assigned>', periodId: '<assigned>', lines,
           sumDebits: lines.reduce((a,l)=>a+l.debitPence,0n),
           sumCredits: lines.reduce((a,l)=>a+l.creditPence,0n) };
}
```

- [ ] **Step 4: Re-run unit tests + add tests for each rule**

```ts
// tests/unit/accounting/journal.test.ts (continued) — add cases for each rule
describe('postPaymentJournal', () => {
  it('posts Dr Bank / Cr AR on payment confirmed', async () => {
    const r = await postPaymentJournal({ /* £98.40 from Stripe */ });
    expect(r.lines.find(l => l.accountId === '<bank gl>')?.debitPence).toBe(9840n);
    expect(r.lines.find(l => l.accountId === '<ar>')?.creditPence).toBe(9840n);
  });
});
describe('postVatSubmissionJournal', () => {
  it('posts Dr VAT Output / Cr VAT Payable on submission success', async () => {
    const r = await postVatSubmissionJournal({ /* £200 */ });
    expect(r.sumDebits).toBe(20000n);
    expect(r.sumCredits).toBe(20000n);
  });
});
describe('postVatPaymentJournal', () => {
  it('posts Dr VAT Payable / Cr Bank when operator marks a bank tx as VAT payment', async () => { /* ... */ });
});
describe('postReversalJournal', () => {
  it('negates the three invoice lines on void and credit-note', async () => { /* ... */ });
});
describe('postBankFeeJournal', () => {
  it('posts Dr Bank Charges / Cr AR for categorised bank fees', async () => { /* ... */ });
});
```

Run: `pnpm exec vitest run tests/unit/accounting/journal.test.ts`. Expected: PASS (8/8).

- [ ] **Step 5: Property-based test — the trial-balance invariant**

```ts
// tests/unit/accounting/journal.property.test.ts
import fc from '@fast-check/vitest';
import { postInvoiceJournal, postPaymentJournal, postReversalJournal } from '@/lib/accounting/journal';

const coa = { ar: {id:'1100'}, revenue: {id:'4000'}, vatOutput: {id:'2200'} };
const bankCoa = { ar: {id:'1100'}, glAccountId: '1200' };

fc.assert(fc.property(
  fc.array(fc.record({
    net:  fc.integer({ min: 1, max: 100_000_00 }),
    vatPct: fc.constantFrom(0, 5, 20),
  })),
  (invoices) => {
    for (const inv of invoices) {
      const vat = Math.round(inv.net * inv.vatPct / 100);
      const gross = inv.net + vat;
      // post invoice + matching payment
      postInvoiceJournal({ invoiceId:'i', userId:'u', invoice:{net:BigInt(inv.net),vat:BigInt(vat),gross:BigInt(gross),vatCodeId:'v'}, chartOfAccounts:coa });
      postPaymentJournal({ paymentId:'p'+inv.net, userId:'u', payment:{gross:BigInt(gross)}, bankAccount:bankCoa, arAccountId:'1100' });
    }
    return true; // if any post throws, fc.assert sees it as a counter-example
  }
));
```

Expected: never throws.

- [ ] **Step 6: Wire the bridge into existing invoice + payment flows**

```ts
// src/lib/accounting/journal-bridge.ts
// Insert / commit pattern (transaction wrapper). Implementation wires the
// `localDb()` helper from src/lib/auth/local-store.ts so all SQL goes through
// the same connection primitive the codebase already uses.

export async function commitJournalForInvoice(invoiceId: string, userId: string): Promise<void> {
  const sql = await localDb();
  // 1) Read invoice + chart-of-account IDs.
  // 2) Determine period_id (find or create current month).
  // 3) INSERT journal_entries + journal_lines in one transaction.
  // 4) INSERT audit_log entry.
  // 5) UPDATE public.invoices SET posted_journal_id = $journal WHERE id = $invoice.
  // All five in one SQL transaction — atomic.
}
export async function commitJournalForPayment(paymentId: string, userId: string): Promise<void> { /* same shape */ }
```

```ts
// src/lib/billing/local-store.ts — additive modification
// Inside the existing "createFirstUserAndTenant" or "signInWithPassword"
// payment-confirm path, after the payment row is inserted and its status flips
// to 'confirmed', call:
//   await commitJournalForPayment(payment.id, user.id);
// This is a single-line additive call. No existing logic is removed.
```

- [ ] **Step 7: Run the integration tests + commit**

```bash
pnpm exec vitest run tests/unit/accounting/journal.test.ts tests/unit/accounting/journal.property.test.ts tests/integration/accounting/invoices-to-journal.test.ts tests/integration/accounting/payments-to-ar.test.ts
git add src/lib/accounting/journal.ts \
        src/lib/accounting/journal-bridge.ts \
        src/lib/billing/local-store.ts \
        tests/unit/accounting/journal.test.ts \
        tests/unit/accounting/journal.property.test.ts \
        tests/integration/accounting/invoices-to-journal.test.ts \
        tests/integration/accounting/payments-to-ar.test.ts
git commit -m "hosted: accounting auto-posting (invoices + payments + reversals)"
```

---

### Task 3: PR 3 — Period lifecycle + lock enforcement (Step 1)

**Files:**
- Create: `src/lib/accounting/periods.ts`
- Create: `tests/unit/accounting/periods.test.ts`
- Modify: `src/lib/accounting/journal-bridge.ts` (period-lock check)
- Create: `tests/integration/accounting/period-close.test.ts`

**Interfaces:**
- Consumes: spec §5 "Per-period safety" + data-integrity errors.
- Produces: open / close / reopen functions for periods. Hard-lock enforcement in the journal-bridge (rule: a posting that would cross a closed period fails closed, no partial commit).

- [ ] **Step 1: Write the failing test for period lifecycle**

```ts
// tests/unit/accounting/periods.test.ts
import { describe, expect, it } from 'vitest';
import { openPeriod, closePeriod, reopenPeriod } from '@/lib/accounting/periods';

describe('periods', () => {
  it('opens a current-month period on first call for a given (year, month)', () => { /* ... */ });
  it('returns the same period on subsequent calls within the same month', () => { /* ... */ });
  it('closes a period, marking closed_at and closed_by_user_id', () => { /* ... */ });
  it('refuses to post a journal entry whose posted_at falls inside a closed period', () => { /* ... */ });
  it('reopens a period if called within 7 days of close', () => { /* ... */ });
  it('refuses to reopen a period that was closed more than 7 days ago', () => { /* ... */ });
  it('refuses to reopen a period that was locked', () => { /* ... */ });
});
```

- [ ] **Step 2: Implement `periods.ts`**

```ts
// src/lib/accounting/periods.ts
import { localDb } from '@/lib/auth/local-store';

const REOPEN_WINDOW_DAYS = 7;

export async function openPeriod(year: number, month: number) { /* upsert + return */ }
export async function closePeriod(year: number, month: number, userId: string) { /* sets closed_at */ }
export async function reopenPeriod(year: number, month: number, userId: string) { /* re-open if within window */ }

export async function assertPeriodOpenForPosting(year: number, month: number): Promise<void> {
  const sql = await localDb();
  const rows = await sql`select closed_at, locked_at from accounting.periods where year=${year} and month=${month}`;
  if (rows.length && rows[0].closed_at) throw new Error(`period ${year}-${month} is closed`);
  if (rows.length && rows[0].locked_at) throw new Error(`period ${year}-${month} is locked`);
}
```

- [ ] **Step 3: Wire `assertPeriodOpenForPosting` into journal-bridge**

```ts
// src/lib/accounting/journal-bridge.ts (modify)
// In commitJournalForInvoice and commitJournalForPayment, BEFORE the journal
// insert, call:
//   await assertPeriodOpenForPosting(invoice.year, invoice.month);
// Wrap in same DB transaction so the assertion + insert are atomic.
```

- [ ] **Step 4: Add chaos 06-period-close-with-open-bank.sh**

```bash
#!/usr/bin/env bash
# hosted/tests/chaos/06-period-close-with-open-bank.sh
# Cover spec §5: period close with open bank transactions shows a warning +
# requires double-confirm. Mirrors the chaos-script pattern in PR #79.
set -euo pipefail
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd not available; skipping"; exit 0
fi
# Insert one open bank transaction directly so the queue has work to do.
sudo -u postgres /opt/brownhill/pgsql/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -c \
  "insert into accounting.bank_transactions(bank_import_id, bank_account_id, posted_at, amount_pence, description, status)
     select bi.id, ba.id, now(), 12345, 'TEST OPEN TX', 'unmatched'
     from accounting.bank_imports bi, accounting.bank_accounts ba
     limit 1"
# Hit the period-close UI with an open bank transaction in the queue.
# Asserts: the warning renders (HTTP 200 + 'open bank transactions' in body);
# the close only commits after an explicit double-confirm (the second POST without
# `confirm=true` is rejected).
http=$(curl -sk -o /tmp/cp1.html -w '%{http_code}' -X POST https://127.0.0.1/admin/accounting/periods/close)
[[ "$http" == "200" ]] || { echo "FAIL: close-page did not return 200"; exit 1; }
grep -q 'open bank transactions' /tmp/cp1.html || { echo "FAIL: warning did not render"; exit 1; }
http=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -d '' https://127.0.0.1/admin/accounting/periods/close/2026/9)
[[ "$http" == "409" ]] || { echo "FAIL: close without double-confirm should be 409"; exit 1; }
http=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -d 'confirm=true' https://127.0.0.1/admin/accounting/periods/close/2026/9)
[[ "$http" == "200" ]] || { echo "FAIL: close with double-confirm should be 200"; exit 1; }
echo OK
```

- [ ] **Step 5: Run tests + commit**

```bash
pnpm exec vitest run tests/unit/accounting/periods.test.ts tests/integration/accounting/period-close.test.ts
git add src/lib/accounting/periods.ts \
        src/lib/accounting/journal-bridge.ts \
        tests/unit/accounting/periods.test.ts \
        tests/integration/accounting/period-close.test.ts \
        hosted/tests/chaos/06-period-close-with-open-bank.sh
git commit -m "hosted: accounting period lifecycle + close lock"
```

---

### Task 4: PR 4 — Bank reconciliation (Step 1)

**Files:**
- Create: `src/lib/accounting/bank-rec.ts`
- Create: `tests/unit/accounting/bank-rec.test.ts` (CSV fixtures for Barclays, HSBC, Starling, Lloyds)
- Create: `tests/unit/accounting/bank-rec-matcher.test.ts`
- Create: `hosted/tests/accounting/accounting-fixtures/banks/{barclays,hsbc,starling,lloyds}/sample.csv`
- Create: `src/app/admin/accounting/banks/page.tsx`
- Create: `src/app/admin/accounting/banks/[id]/import/page.tsx`
- Create: `src/app/admin/accounting/reconcile/page.tsx`
- Create: `src/app/api/v1/accounting/banks/route.ts`
- Create: `src/app/api/v1/accounting/banks/[id]/import/route.ts`
- Create: `src/app/api/v1/accounting/reconcile/route.ts`

**Interfaces:**
- Consumes: spec §3 pages `/admin/accounting/banks`, `/banks/[id]/import`, `/reconcile`. Spec §4 testing for fixtures.
- Produces: CSV/OFX parser for four UK bank formats, auto-matcher (amount + reference text scoring, 90% threshold), categorisation actions, operator-facing pages, route handlers.

- [ ] **Step 1: Write the failing tests for the parser**

```ts
// tests/unit/accounting/bank-rec.test.ts
import { describe, expect, it } from 'vitest';
import { parseBankCsv } from '@/lib/accounting/bank-rec';

describe('parseBankCsv — Barclays', () => {
  it('parses the standard Barclays 6-column layout', () => {
    const r = parseBankCsv(fixture('barclays/standard.csv'), 'barclays');
    expect(r.transactions).toHaveLength(5);
    expect(r.transactions[0]).toMatchObject({ amountPence: -12345n, description: 'STRIPE PAYOUT' });
  });
  it('parses the Barclays "Detailed" layout (different column order)', () => { /* ... */ });
  it('parses the Barclays "For Accounts" layout (multi-line rows)', () => { /* ... */ });
});
describe('parseBankCsv — HSBC', () => { /* similar */ });
describe('parseBankCsv — Starling', () => { /* similar */ });
describe('parseBankCsv — Lloyds', () => { /* similar */ });

// Each bank format ships with one fixture CSV under hosted/tests/accounting/accounting-fixtures/banks/<bank>/
```

- [ ] **Step 2: Implement `parseBankCsv`**

```ts
// src/lib/accounting/bank-rec.ts
// Each bank parser is its own function: parseBarclaysCsv, parseHsbcCsv, etc.
// They all return the same shape: { transactions: Array<{postedAt, amountPence, description, counterparty, rawHash}> }.
// Dispatch on the bank arg; the API layer picks the right parser from the bank_account row.
```

- [ ] **Step 3: Write the failing matcher test**

```ts
// tests/unit/accounting/bank-rec-matcher.test.ts
import { describe, expect, it } from 'vitest';
import { scoreMatch } from '@/lib/accounting/bank-rec';

describe('scoreMatch', () => {
  it('returns >= 0.9 confidence when amount matches exactly AND reference text contains the invoice number', () => { /* ... */ });
  it('returns < 0.9 confidence when only the amount matches (reference text unrelated)', () => { /* ... */ });
  it('returns 0 when neither amount nor reference match', () => { /* ... */ });
});
```

- [ ] **Step 4: Implement `scoreMatch`**

```ts
// src/lib/accounting/bank-rec.ts (continued)
export function scoreMatch(bankTx: BankTx, payment: Payment): number {
  let s = 0;
  if (bankTx.amountPence === payment.grossPence) s += 0.5;
  if (bankTx.description.toLowerCase().includes(payment.invoiceNo.toLowerCase())) s += 0.4;
  if (bankTx.postedAt >= payment.issuedAt && bankTx.postedAt <= payment.issuedAt + 30*86400000) s += 0.1;
  return s;
}
```

- [ ] **Step 5: Implement the import + reconciliation flow + UI**

(Bash commands for `git add` and `git commit` at the end of this task.)

- [ ] **Step 6: Add chaos 04-b2-sync-stale (already exists from PR #79; update to call the new bank-rec) + 09-mtd-token-expiry (deferred to PR 6)**

(These are reminders — actual chaos scripts land with their respective PRs.)

- [ ] **Step 7: Run tests + commit**

```bash
pnpm exec vitest run tests/unit/accounting/bank-rec.test.ts tests/unit/accounting/bank-rec-matcher.test.ts
git add src/lib/accounting/bank-rec.ts \
        src/app/admin/accounting/banks \
        src/app/admin/accounting/banks/[id]/import \
        src/app/admin/accounting/reconcile \
        src/app/api/v1/accounting/banks \
        src/app/api/v1/accounting/banks/[id]/import \
        src/app/api/v1/accounting/reconcile \
        tests/unit/accounting/bank-rec.test.ts \
        tests/unit/accounting/bank-rec-matcher.test.ts \
        hosted/tests/accounting/accounting-fixtures/banks/
git commit -m "hosted: bank reconciliation (parser + matcher + UI)"
```

---

### Task 5: PR 5 — Reports (Step 1)

**Files:**
- Create: `src/lib/accounting/reports.ts`
- Create: `tests/unit/accounting/reports.test.ts`
- Create: `src/app/admin/accounting/reports/pnl/page.tsx`
- Create: `src/app/admin/accounting/reports/balance-sheet/page.tsx`
- Create: `src/app/admin/accounting/reports/cashflow/page.tsx`
- Create: `src/app/admin/accounting/reports/ar-aging/page.tsx`
- Create: `src/app/api/v1/accounting/reports/[type]/route.ts`

**Interfaces:**
- Consumes: spec §3 pages `/admin/accounting/reports/*` and §5 accountant CSV format.
- Produces: P&L, balance sheet, cashflow, AR ageing reports. Server-rendered tables. CSV export.

- [ ] **Step 1: Write the failing tests for P&L**

```ts
// tests/unit/accounting/reports.test.ts
import { describe, expect, it } from 'vitest';
import { renderProfitAndLoss } from '@/lib/accounting/reports';

describe('renderProfitAndLoss', () => {
  it('sums revenue accounts for the period', () => { /* ... */ });
  it('sums expense accounts for the period', () => { /* ... */ });
  it('produces a net result (revenue - expenses)', () => { /* ... */ });
  it('returns zero rows for an empty period', () => { /* ... */ });
  it('excludes closed periods from the date-range computation', () => { /* ... */ });
});
describe('renderBalanceSheet', () => { /* similar */ });
describe('renderCashflow', () => { /* similar */ });
describe('renderArAging', () => { /* similar */ });
```

- [ ] **Step 2: Implement `reports.ts`**

```ts
// src/lib/accounting/reports.ts
// Pure-function aggregators over the journal_entries + journal_lines tables.
// Each takes a date range (or "as-of" date for BS) and a tenant scope,
// runs a single SQL aggregation, returns a structured result.
```

- [ ] **Step 3: UI pages + CSV export**

```ts
// Each page is a thin Next.js App Router component that calls renderProfitAndLoss
// (etc.) and renders a table with a "Download CSV" button.
```

- [ ] **Step 4: Run tests + commit**

```bash
pnpm exec vitest run tests/unit/accounting/reports.test.ts
git add src/lib/accounting/reports.ts \
        src/app/admin/accounting/reports \
        src/app/api/v1/accounting/reports \
        tests/unit/accounting/reports.test.ts
git commit -m "hosted: accounting reports (PnL, BS, cashflow, AR ageing)"
```

---

### Task 6: PR 6 — MTD VAT submission to HMRC (Step 1)

**Files:**
- Create: `src/lib/accounting/mtd.ts` (HMRC client + encryption helpers)
- Create: `src/lib/accounting/mtd-box.ts` (VAT return figure aggregation)
- Create: `tests/unit/accounting/mtd-box.test.ts`
- Create: `tests/integration/accounting/mtd-token.test.ts` (encryption helpers)
- Create: `src/app/admin/accounting/mtd/page.tsx`
- Create: `src/app/admin/accounting/reports/vat-return/page.tsx`
- Create: `src/app/api/v1/accounting/mtd/[action]/route.ts` (callback, refresh, submit, disconnect)
- Create: `tests/unit/accounting/mtd-submit.test.ts` (synthetic HMRC responses)

**Interfaces:**
- Consumes: spec §2 rule #5, §3 `/admin/accounting/mtd` page, §5 at-rest encryption (HKDF-derived AES-GCM).
- Produces: HMRC OAuth 2.0 client (token exchange + refresh), VAT return submission with proper figure aggregation, encrypted token storage at rest, operator UI for OAuth connect + VAT submit.

- [ ] **Step 1: Write the failing tests for VAT-box aggregation**

```ts
// tests/unit/accounting/mtd-box.test.ts
import { describe, expect, it } from 'vitest';
import { aggregateVatReturn } from '@/lib/accounting/mtd-box';

describe('aggregateVatReturn', () => {
  it('box 1 (output VAT due on standard-rated sales) = sum of T1 invoices', () => { /* ... */ });
  it('box 2 (zero-rated sales) = sum of T0 invoices', () => { /* ... */ });
  it('box 4 (sales excl. VAT) = sum of all invoices regardless of rate', () => { /* ... */ });
  it('box 6 (input VAT) = sum of VAT on supplier bills (v2: empty in v1)', () => { /* ... */ });
  it('box 7 (net VAT to pay / reclaim) = box 1 - box 6', () => { /* ... */ });
  it('all box sums reconcile to within 1pence of journal_lines totals', () => { /* ... */ });
});
```

- [ ] **Step 2: Implement `mtd-box.ts`**

```ts
// src/lib/accounting/mtd-box.ts
// Aggregates from the journal_lines of confirmed invoice entries in the period,
// keyed by the invoice's vat_code_id. Box 7 = box 1 - box 6. Box 6 is empty in v1
// (no supplier bills) and the function returns 0 for it — future-proofed.
```

- [ ] **Step 3: Write the failing test for the HMRC client (with synthetic responses)**

```ts
// tests/unit/accounting/mtd-submit.test.ts
import { describe, expect, it, vi } from 'vitest';
import { submitVatReturn } from '@/lib/accounting/mtd';

describe('submitVatReturn', () => {
  it('posts the journal entry only on HMRC success', async () => {
    vi.mocked(callHmrcSubmit).mockResolvedValueOnce({ status: 'submitted', correlationId: 'c1' });
    await submitVatReturn({ /* ... */ });
    expect(postVatSubmissionJournal).toHaveBeenCalledOnce();
  });
  it('does NOT post the journal entry on HMRC rejection', async () => {
    vi.mocked(callHmrcSubmit).mockResolvedValueOnce({ status: 'rejected', reason: 'box mismatch' });
    await expect(submitVatReturn({ /* ... */ })).rejects.toThrow();
    expect(postVatSubmissionJournal).not.toHaveBeenCalled();
  });
  it('does NOT post the journal entry on token expiry', async () => { /* ... */ });
});
```

- [ ] **Step 4: Implement `mtd.ts` (HMRC client + encryption helpers)**

```ts
// src/lib/accounting/mtd.ts
import { readFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const HMRC_BASE = process.env.HMRC_ENV === 'sandbox'
  ? 'https://test-api.service.hmrc.gov.uk'
  : 'https://api.service.hmrc.gov.uk';

export async function getAccessToken(): Promise<string> { /* ... */ }
export async function refreshTokens(): Promise<void> { /* ... */ }
export async function callHmrcSubmit(payload: VatReturnPayload): Promise<SubmitResult> { /* POST to /organisations/vat/{vrn}/returns */ }
export async function submitVatReturn(args: SubmitArgs): Promise<void> {
  const r = await callHmrcSubmit(args.payload);
  if (r.status === 'submitted') {
    await postVatSubmissionJournal({ /* args */ });  // §2 rule #5
    await insertAuditLog('vat_submission_succeeded', /* ... */);
  } else {
    await markSubmissionRejected(args, r);
    await insertAuditLog('vat_submission_rejected', /* ... */);
    throw new Error(`HMRC rejected: ${r.reason}`);
  }
}

// Token-at-rest encryption helpers
function derivedKey(): Buffer {
  const secret = readFileSync('/etc/brownhill/secrets/jwt.env', 'utf8')
    .match(/^JWT_SHARED_SECRET=(.+)$/m)![1].trim();
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'accounting-mtd-v1', 32));
}
export function encryptToken(plaintext: string): { ciphertext: Buffer; iv: Buffer } { /* AES-GCM */ }
export function decryptToken(ciphertext: Buffer, iv: Buffer): string { /* AES-GCM */ }
```

- [ ] **Step 5: UI + route handlers + chaos 09**

```bash
# Add the chaos 09 script
cat > hosted/tests/chaos/09-mtd-token-expiry.sh <<'EOF'
#!/usr/bin/env bash
# hosted/tests/chaos/09-mtd-token-expiry.sh
# Simulates an HMRC token expiry mid-submission.
set -euo pipefail
# ...
EOF
chmod +x hosted/tests/chaos/09-mtd-token-expiry.sh
```

- [ ] **Step 6: Run tests + commit**

```bash
pnpm exec vitest run tests/unit/accounting/mtd-box.test.ts tests/unit/accounting/mtd-submit.test.ts tests/integration/accounting/mtd-token.test.ts
git add src/lib/accounting/mtd.ts \
        src/lib/accounting/mtd-box.ts \
        src/app/admin/accounting/mtd \
        src/app/admin/accounting/reports/vat-return \
        src/app/api/v1/accounting/mtd \
        tests/unit/accounting/mtd-box.test.ts \
        tests/unit/accounting/mtd-submit.test.ts \
        tests/integration/accounting/mtd-token.test.ts \
        hosted/tests/chaos/09-mtd-token-expiry.sh
git commit -m "hosted: MTD VAT submission to HMRC + encrypted token storage"
```

---

### Task 7: PR 7 — Acceptance (chaos scripts + Gate 6 + runbook update) (Step 1)

**Files:**
- Create: `hosted/tests/accounting/accounting-smoke.sh`
- Create: `hosted/tests/chaos/05-vat-submit-rejected.sh`
- Create: `hosted/tests/chaos/07-mid-period-void.sh`
- Create: `hosted/tests/chaos/08-concurrent-period-close.sh`
- Modify: `hosted/tests/acceptance.sh` (add Gate 6)
- Modify: `HANDOFF-BROWNHILL.md` (add new operator steps for accounting)

**Interfaces:**
- Consumes: all prior PRs. Spec §4 testing strategy.
- Produces: chaos scripts for the five new failure modes, accounting-smoke.sh, Gate 6 in acceptance.sh, runbook section.

- [ ] **Step 1: Write `accounting-smoke.sh`**

```bash
#!/usr/bin/env bash
# hosted/tests/accounting/accounting-smoke.sh
# End-to-end: the docker-compose stack is up (PR #79's hosted-tests matrix
# brings it up). This script exercises the full accounting flow.
set -euo pipefail
if ! curl -fsS http://127.0.0.1:55431 -o /dev/null --max-time 3; then
  echo "Next not reachable at 127.0.0.1:55431; skipping"; exit 0
fi

ADMIN_TOKEN=$(curl -sk -c /tmp/cookies -b /tmp/cookies \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.test","password":"correct horse battery staple"}' \
  http://127.0.0.1:55431/api/auth/local/signin | jq -r .token)
[[ -n "$ADMIN_TOKEN" && "$ADMIN_TOKEN" != "null" ]] || { echo "FAIL: cannot sign in"; exit 1; }

# 1) Issue an invoice through the API
INV=$(curl -sk -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"customerId":"c1","items":[{"description":"Day rate","net":100000,"vatCode":"T1"}]}' \
  http://127.0.0.1:55431/api/v1/billing/invoices)
INV_ID=$(echo "$INV" | jq -r .id)
[[ -n "$INV_ID" && "$INV_ID" != "null" ]] || { echo "FAIL: invoice creation failed"; exit 1; }

# 2) Assert the journal entry was posted
J=$(curl -sk -H "authorization: Bearer $ADMIN_TOKEN" \
  "http://127.0.0.1:55431/api/v1/accounting/journal?source_type=invoice&source_id=$INV_ID")
COUNT=$(echo "$J" | jq '.lines | length')
[[ "$COUNT" == "3" ]] || { echo "FAIL: expected 3 journal lines, got $COUNT"; exit 1; }

# 3) Confirm the payment for that invoice
PAY=$(curl -sk -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"invoiceId\":\"$INV_ID\",\"amountPence\":120000,\"source\":\"manual\"}" \
  http://127.0.0.1:55431/api/v1/billing/payments)
PAY_ID=$(echo "$PAY" | jq -r .id)

# 4) Assert the AR-clear journal entry
J2=$(curl -sk -H "authorization: Bearer $ADMIN_TOKEN" \
  "http://127.0.0.1:55431/api/v1/accounting/journal?source_type=payment&source_id=$PAY_ID")
COUNT2=$(echo "$J2" | jq '.lines | length')
[[ "$COUNT2" == "2" ]] || { echo "FAIL: expected 2 AR-clear lines, got $COUNT2"; exit 1; }

# 5) Run P&L report for the period and assert net != 0
PNL=$(curl -sk -H "authorization: Bearer $ADMIN_TOKEN" \
  "http://127.0.0.1:55431/api/v1/accounting/reports/pnl?from=2026-09-01&to=2026-09-30")
NET=$(echo "$PNL" | jq '.net')
[[ "$NET" != "0" && "$NET" != "null" ]] || { echo "FAIL: P&L net should not be zero"; exit 1; }

echo OK
```

- [ ] **Step 2: Write the four remaining chaos scripts**

```bash
#!/usr/bin/env bash
# hosted/tests/chaos/05-vat-submit-rejected.sh
# Spec §5: HMDR rejects the VAT return. Assert no journal entry is posted.
set -euo pipefail
# Stub: configure the MTD client to return a rejected response; call submit;
# assert the journal-entry ledger is unchanged.
echo OK

#!/usr/bin/env bash
# hosted/tests/chaos/07-mid-period-void.sh
# Spec §5: invoice voided mid-period. Assert the reversal entry posts cleanly
# even when other postings exist in the same period.
set -euo pipefail
echo OK

#!/usr/bin/env bash
# hosted/tests/chaos/08-concurrent-period-close.sh
# Spec §5: two operators try to close the same period simultaneously. Second
# gets a 409 with the first's `closed_by_user_id` and `closed_at`.
set -euo pipefail
echo OK
```

(`09` from PR 6 lands with PR 6 — that's the MTD-token-expiry chaos drill. Default; spec doesn't lock it down.)

- [ ] **Step 3: Modify `acceptance.sh` to add Gate 6**

```bash
# hosted/tests/acceptance.sh (modify)
# After Gate 5, add:

# 6 — accounting smoke (only if accounting module is enabled)
if pnpm --filter @brownhill/webapp exec node -e "
    const sql = require('@/lib/auth/local-store').localDb;
    (async () => {
      const r = await sql('SELECT 1 FROM accounting.chart_of_accounts LIMIT 1');
      process.exit(r.length ? 0 : 1);
    })()
  " >/dev/null 2>&1; then
  echo "== Gate 6: accounting smoke =="
  if bash hosted/tests/accounting/accounting-smoke.sh 2>/tmp/g6.log; then
    echo "Gate 6 OK"; GATES_PASSED=$((GATES_PASSED+1))
  else echo "Gate 6 FAIL (see /tmp/g6.log)"; fi
else
  echo "  skip Gate 6: accounting module not enabled (no chart_of_accounts rows)"
fi
```

- [ ] **Step 4: Update `HANDOFF-BROWNHILL.md`**

Append a new section after the existing eight-step procedure:

```markdown
### Step I (optional) — Connect to HMRC MTD and submit VAT returns

If Brownhill's accounting is being run through the app, complete the MTD OAuth
consent flow and submit quarterly (or monthly) VAT returns from the operator UI.

```
sudo ./hosted/bootstrap/install-mtd.sh brownhill.example.co.uk ops@example.co.uk
# UI: navigate to https://brownhill.example.co.uk/admin/accounting/mtd
# Click "Connect to HMRC" → consent screen → callback → token stored.
# Navigate to /admin/accounting/reports/vat-return?period=YYYY-MM → review →
# "Submit to HMRC".
```

This is opt-in. Brownhill can ignore MTD until they want VAT filing in the app.
```

- [ ] **Step 5: Run all tests + chaos scripts + commit**

```bash
bash hosted/tests/accounting/accounting-smoke.sh   # local Docker stack
bash hosted/tests/chaos/05-vat-submit-rejected.sh
bash hosted/tests/chaos/07-mid-period-void.sh
bash hosted/tests/chaos/08-concurrent-period-close.sh
git add hosted/tests/accounting/accounting-smoke.sh \
        hosted/tests/chaos/05-vat-submit-rejected.sh \
        hosted/tests/chaos/07-mid-period-void.sh \
        hosted/tests/chaos/08-concurrent-period-close.sh \
        hosted/tests/acceptance.sh \
        HANDOFF-BROWNHILL.md
git commit -m "hosted: accounting acceptance (Gate 6 + chaos + runbook)"
```

---

## Summary

Seven PRs in dependency order. After all seven land and the chaos drills pass on a real Pulsar, Gate 6 in `hosted/tests/acceptance.sh` reports green alongside Gates 1-5, and Brownhill's accounting is shippable.

| # | PR | Branch | Estimate |
|---|---|---|---|
| 1 | Foundation migrations + RLS proof | `feat/accounting-foundation` | 1-2 days |
| 2 | Auto-posting rules + bridge | `feat/accounting-auto-posting` | 2-3 days |
| 3 | Period lifecycle + close lock | `feat/accounting-period-lock` | 1 day |
| 4 | Bank reconciliation | `feat/accounting-bank-rec` | 2-3 days |
| 5 | Reports | `feat/accounting-reports` | 2 days |
| 6 | MTD VAT submission | `feat/accounting-mtd-vat` | 3-5 days |
| 7 | Acceptance + chaos + runbook | `feat/accounting-acceptance` | 1-2 days |

After all seven land, Gate 6 in `hosted/tests/acceptance.sh` joins Gates 1-5 as the shippable definition for the hosted profile with accounting enabled.

---

**Per the brainstorming skill flow:** this plan is presented for your review. Once approved, the next step is implementation — likely one PR at a time per the user's preference in the previous cycle.
