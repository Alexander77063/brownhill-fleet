// tests/integration/accounting/bank-transaction-period.test.ts
//
// Which month a bank line posts into.
//
// WHY THIS FILE EXISTS
// --------------------
// `bankTransactionPeriod` reads `accounting.bank_transactions.posted_at` —
// a timestamptz — and turns it into the accounting year/month that the
// journal entry lands in. It used to declare `posted_at` as a `string`.
//
// It got away with it, because `new Date(aDate)` copies the instant just
// fine. But the declaration was a lie, and a lie in a type is a trap: the
// next person to reach for a string method on it (`posted_at.slice(0, 7)`,
// `posted_at.startsWith('2026')`) gets "posted_at.slice is not a function"
// at run time — on the code path that decides which month a payment lands
// in, which is the kind of bug that shows up as a receipt in the wrong
// month and nothing else.
//
// The runtime behaviour was already right. This file is what makes the
// DECLARATION true and keeps it true: it asserts the driver really does
// hand over a Date, and it asserts the month the line lands in for the
// cases where an off-by-one or a tenant leak would show up.
//
// WHAT THIS FILE PROVES
// ----------------------
//   1. `posted_at` comes back from postgres.js as a Date — the type the
//      function declares.
//   2. A line posted in October lands in October.
//   3. A line posted on 31 January lands in January, not February, and the
//      year rolls over correctly at the boundary.
//   4. Another tenant's bank line is not found — the query names the
//      tenant, because the accounting schema is not exposed by PostgREST
//      and the app connects as a superuser, which bypasses RLS.
//   5. A bank line that does not exist yields undefined rather than
//      throwing.
//
// IT NEEDS A DATABASE
// -------------------
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It creates its own tenants and its own rows, and removes them afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { openPeriod } from '@/lib/accounting/periods';
import { bankTransactionPeriod } from '@/lib/accounting/journal-bridge';
import { integrationEnv } from '../../helpers/integration-env';

// This file talks straight to postgres and never through the service
// client, so it asks for the database alone.
const env = integrationEnv({ app: false });

describe.skipIf(!env)('the month a bank line posts into', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const slug = `bankperiod-${tenantId.slice(0, 8)}`;
  const otherSlug = `bankperiod-other-${otherTenantId.slice(0, 8)}`;

  let octoberLineId: string;
  let januaryLineId: string;
  let otherTenantLineId: string;

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values
        (${tenantId}::uuid, 'Bank period test', ${slug}),
        (${otherTenantId}::uuid, 'Another tenant', ${otherSlug})
    `;

    // A bank line hangs off a bank account, which hangs off a GL account,
    // which hangs off an import, which hangs off an accounting period.
    const period = await openPeriod(tenantId, 2026, 10);
    const otherPeriod = await openPeriod(otherTenantId, 2026, 10);

    const bankAccount = (await sql`
      insert into accounting.bank_accounts (name, gl_account_id, tenant_id)
      select 'Bank Period Bank', coa.id, ${tenantId}::uuid
        from accounting.chart_of_accounts coa
       where coa.code = '1200' and coa.tenant_id is null
      returning id
    `) as Array<{ id: string }>;

    const otherBankAccount = (await sql`
      insert into accounting.bank_accounts (name, gl_account_id, tenant_id)
      select 'Other Bank Period Bank', coa.id, ${otherTenantId}::uuid
        from accounting.chart_of_accounts coa
       where coa.code = '1200' and coa.tenant_id is null
      returning id
    `) as Array<{ id: string }>;

    const importRow = (await sql`
      insert into accounting.bank_imports
        (bank_account_id, file_name, file_sha256, period_id, tenant_id)
      values (${bankAccount[0].id}::uuid, 'bankperiod.csv', ${'00aabbccddeeff11'}::bytea,
              ${period.id}::uuid, ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;

    const otherImport = (await sql`
      insert into accounting.bank_imports
        (bank_account_id, file_name, file_sha256, period_id, tenant_id)
      values (${otherBankAccount[0].id}::uuid, 'other-bankperiod.csv', ${'1122334455667788'}::bytea,
              ${otherPeriod.id}::uuid, ${otherTenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;

    const october = (await sql`
      insert into accounting.bank_transactions
        (bank_import_id, bank_account_id, posted_at, amount_pence, description,
         status, tenant_id)
      values (${importRow[0].id}::uuid, ${bankAccount[0].id}::uuid,
              '2026-10-14T09:00:00Z'::timestamptz, 45000, 'October rent receipt',
              'unmatched', ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;
    octoberLineId = october[0].id;

    // 31 January — the month boundary, and the year boundary two weeks
    // later. An off-by-one on the month, or a local-time reading instead of
    // UTC, shows up here.
    const january = (await sql`
      insert into accounting.bank_transactions
        (bank_import_id, bank_account_id, posted_at, amount_pence, description,
         status, tenant_id)
      values (${importRow[0].id}::uuid, ${bankAccount[0].id}::uuid,
              '2027-01-31T23:30:00Z'::timestamptz, 12000, 'January receipt',
              'unmatched', ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;
    januaryLineId = january[0].id;

    const other = (await sql`
      insert into accounting.bank_transactions
        (bank_import_id, bank_account_id, posted_at, amount_pence, description,
         status, tenant_id)
      values (${otherImport[0].id}::uuid, ${otherBankAccount[0].id}::uuid,
              '2026-10-11T09:00:00Z'::timestamptz, 999999, 'Another tenant receipt',
              'unmatched', ${otherTenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;
    otherTenantLineId = other[0].id;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from accounting.bank_transactions where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from accounting.bank_imports where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from accounting.bank_accounts where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from accounting.periods where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from accounting.audit_log where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from public.tenants where id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
  });

  it('hands over posted_at as a Date, not a string', async () => {
    // The whole point of the declaration. postgres.js parses a timestamptz
    // into a Date — so `posted_at` is a Date here, and code that reaches for
    // a string method on it is wrong. This assertion is what fails if
    // somebody "fixes" the type by casting the row to a string.
    const rows = (await sql`
      select posted_at
        from accounting.bank_transactions
       where id = ${octoberLineId}::uuid
    `) as Array<{ posted_at: Date }>;

    expect(rows[0].posted_at).toBeInstanceOf(Date);
    expect(rows[0].posted_at.getTime()).toBe(
      new Date('2026-10-14T09:00:00Z').getTime(),
    );
  });

  it('posts a line into the month the bank posted it', async () => {
    const period = await bankTransactionPeriod(sql, tenantId, octoberLineId);

    expect(period).toEqual({ year: 2026, month: 10 });
  });

  it('does not slip a January line into February, and rolls the year over', async () => {
    const period = await bankTransactionPeriod(sql, tenantId, januaryLineId);

    // 31 January is still January, and it is the year 2027 — not 2026.
    expect(period).toEqual({ year: 2027, month: 1 });
  });

  it('does not find another tenant’s bank line', async () => {
    // The query names the tenant because the accounting schema is not
    // exposed by PostgREST and the app connects as a superuser, so RLS
    // never filters it. Without the tenant in the SQL, this would return
    // the other tenant's October.
    const period = await bankTransactionPeriod(sql, tenantId, otherTenantLineId);

    expect(period).toBeUndefined();
  });

  it('returns undefined for a bank line that does not exist', async () => {
    const period = await bankTransactionPeriod(sql, tenantId, randomUUID());

    expect(period).toBeUndefined();
  });
});
