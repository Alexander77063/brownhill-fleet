// tests/integration/accounting/chart-of-accounts.test.ts
//
// The chart of accounts the ledger posts into, against a real postgres.
//
// WHY THIS FILE EXISTS
// --------------------
// The ledger posts to accounts by CODE — '1100' for trade debtors, '2210' for
// VAT payable, '2200' for VAT output. Those codes are the contract between
// the journal and the schema, and nothing in the database enforced them: the
// seed migration simply inserted whatever accounts it listed, and the
// product simply asked for whatever code it wanted.
//
// Two accounts the ledger posts to were never seeded. '2200' VAT Output is
// the important one: the design spec (§5, rules 1 and 5) posts the VAT side
// of an invoice and the whole of a VAT return to it, and the seed created 33
// accounts without it. The VAT submission read
//
//   select id from accounting.chart_of_accounts where code = '2200'
//
// and then `[0].id` — so with the account missing it threw
//
//   TypeError: Cannot read properties of undefined (reading 'id')
//
// before the journal was reached. A return HMRC had already accepted never
// reached the ledger, and the error named no account.
//
// WHAT THIS FILE PROVES
// ---------------------
//   1. Every account the ledger posts to exists, with the right type and
//      normal balance — including 2200 'VAT Output', which did not.
//   2. A global code can only be used once. Migration 0069 dropped the
//      global `unique (code)` constraint and replaced it with
//      `unique (tenant_id, code)` — and because NULLs are distinct in a
//      unique index, the global rows (tenant_id IS NULL) stopped being
//      covered by it at all. A second global '2200' could have been inserted,
//      and a lookup by code would then have had two rows to choose between.
//   3. A tenant's own account wins over the global one, and the global one
//      is the fallback. This is what the per-tenant constraint is for.
//
// IT NEEDS A DATABASE
// -------------------
// A real postgres with the migrations applied. Without DATABASE_URL the whole
// file is skipped, OUT LOUD — a skipped check and a passing check look the
// same in a build log.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It creates its own tenant and its own accounts, and removes them
// afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import {
  MissingChartOfAccountsError,
  findAccountId,
  requireAccountId,
} from '@/lib/accounting/chart-of-accounts';
import { integrationEnv } from '../../helpers/integration-env';

// This file talks straight to postgres and never through the service
// client, so it asks for the database alone.
//
// `integrationEnv` is the repository's rule for this, and it is the rule that
// matters: it SKIPS, out loud, when the job has not asked for the
// integration tests, and it FAILS when the job has set REQUIRE_INTEGRATION=1
// and the database is not there. The hand-rolled guard this replaced skipped
// in BOTH cases — so a build with REQUIRE_INTEGRATION=1 could report this
// file's tests as skipped and still be green. A test that did not run is not
// a test that passed.
const env = integrationEnv({ app: false });

/**
 * Every account the ledger posts to, and what it has to be.
 *
 * `debit`/`credit` is the NORMAL balance: what the account's own side is.
 * A debit-normal account increases on the debit side, so the ledger debits
 * it (an asset, an expense); a credit-normal account is credited (a
 * liability, a revenue).
 */
const REQUIRED_ACCOUNTS: Array<{
  code: string;
  name: string;
  type: string;
  normal_balance: string;
}> = [
  { code: '1100', name: 'Trade Debtors', type: 'asset', normal_balance: 'debit' },
  { code: '1200', name: 'Bank Account', type: 'asset', normal_balance: 'debit' },
  { code: '2100', name: 'Trade Creditors', type: 'liability', normal_balance: 'credit' },
  { code: '2200', name: 'VAT Output', type: 'liability', normal_balance: 'credit' },
  { code: '2210', name: 'VAT Payable to HMRC', type: 'liability', normal_balance: 'credit' },
  { code: '4000', name: 'Sales', type: 'revenue', normal_balance: 'credit' },
  { code: '5910', name: 'Bank Charges', type: 'expense', normal_balance: 'debit' },
];

describe.skipIf(!env)('the chart of accounts the ledger posts into', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const slug = `coa-${tenantId.slice(0, 8)}`;

  /** A global account created by this test, to be removed afterwards. */
  const scratchCode = '8801';
  /** The tenant's own copy of trade debtors. */
  const tenantArCode = '1100';

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantId}::uuid, 'Chart of accounts test', ${slug})
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from accounting.chart_of_accounts where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.chart_of_accounts where code = ${scratchCode}`;
    await sql`delete from public.tenants where id = ${tenantId}::uuid`;
  });

  // ── the accounts themselves ───────────────────────────────────────────────

  it('seeds every account the ledger posts to', async () => {
    // The GLOBAL rows: `tenant_id is null`. A tenant may have its own copy of
    // a code, and this file creates one for '1100' — so the assertion has to
    // name the global seed, or it depends on which test ran first.
    const rows = (await sql`
      select code, name, type::text as type, normal_balance::text as normal_balance
        from accounting.chart_of_accounts
       where tenant_id is null
         and code in ${sql(
           REQUIRED_ACCOUNTS.map((a) => a.code),
         )}
    `) as Array<{ code: string; name: string; type: string; normal_balance: string }>;

    for (const required of REQUIRED_ACCOUNTS) {
      const found = rows.find((r) => r.code === required.code);
      expect(
        found,
        `chart of accounts is missing ${required.code} ${required.name} — the ledger posts to it`,
      ).toBeDefined();
      expect(found!.name).toBe(required.name);
      expect(found!.type).toBe(required.type);
      expect(found!.normal_balance).toBe(required.normal_balance);
    }
  });

  it('seeds the VAT Output account the invoice and VAT postings need', async () => {
    // Spelled out on its own because it is the one that was missing, and
    // because it is the account the VAT return posts the whole VAT charge
    // to. A missing account here is not a missing report line — it is a
    // return that HMRC has accepted and the ledger has never seen.
    const rows = (await sql`
      select code, name, type::text as type, normal_balance::text as normal_balance
        from accounting.chart_of_accounts
       where code = '2200'
         and tenant_id is null
    `) as Array<{ code: string; name: string; type: string; normal_balance: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('VAT Output');
    expect(rows[0].type).toBe('liability');
    expect(rows[0].normal_balance).toBe('credit');
  });

  // ── the uniqueness invariant ──────────────────────────────────────────────

  it('refuses a second account with the same global code', async () => {
    // Migration 0069 dropped `chart_of_accounts_code_key` — the global
    // `unique (code)` — and replaced it with `unique (tenant_id, code)`.
    // NULLs are distinct in a unique index, so every global row
    // (tenant_id IS NULL) fell outside the constraint entirely.
    //
    // The consequence: two global '2200' rows, and a lookup by code with no
    // tenant filter picking one of them at random.
    await sql`
      insert into accounting.chart_of_accounts (code, name, type, normal_balance)
      values (${scratchCode}, 'Scratch global account', 'expense', 'debit')
    `;

    let error: unknown = null;
    try {
      await sql`
        insert into accounting.chart_of_accounts (code, name, type, normal_balance)
        values (${scratchCode}, 'Scratch global account again', 'expense', 'debit')
      `;
    } catch (e) {
      error = e;
    }

    expect(error, 'a duplicate global chart-of-accounts code was accepted').not.toBeNull();
    expect((error as { code?: string }).code).toBe('23505');
  });

  // ── the lookup ────────────────────────────────────────────────────────────

  it('resolves a global account', async () => {
    const id = await requireAccountId(sql, '1100');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('prefers the tenant’s own account over the global one', async () => {
    const own = (await sql`
      insert into accounting.chart_of_accounts (code, name, type, normal_balance, tenant_id)
      values (${tenantArCode}, 'Trade Debtors (this tenant)', 'asset', 'debit', ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;

    expect(await requireAccountId(sql, tenantArCode, tenantId)).toBe(own[0].id);
    // And the global one is still what a lookup without a tenant gets.
    expect(await requireAccountId(sql, tenantArCode)).not.toBe(own[0].id);
  });

  it('names the missing account instead of crashing on undefined', async () => {
    // The old shape read `[0].id` on an empty result, which is a TypeError
    // that names neither the code nor the table.
    let error: unknown = null;
    try {
      await requireAccountId(sql, '9999');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(MissingChartOfAccountsError);
    expect((error as Error).message).toContain('9999');
  });

  it('reports a missing account as absent rather than as an error', async () => {
    expect(await findAccountId(sql, '9999')).toBeNull();
    expect(await findAccountId(sql, '1100')).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
