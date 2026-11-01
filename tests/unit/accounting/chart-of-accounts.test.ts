// tests/unit/accounting/chart-of-accounts.test.ts
//
// The chart-of-accounts lookup, as a contract.
//
// WHY THIS TEST EXISTS
// --------------------
// Six places in the product asked the database for an account by code, each
// with its own SQL and its own idea of what to do when the account was not
// there:
//
//   const rows = await sql`select id from accounting.chart_of_accounts where code = '2210'`;
//   const id = rows[0].id;
//
// Two things were wrong with that shape, and both of them bit:
//
//   1. `[0].id` on an empty array is `TypeError: Cannot read properties of
//      undefined (reading 'id')` — no code, no table, no clue. The VAT
//      submission did exactly this against code '2200', which was never
//      seeded.
//   2. A lookup by code alone cannot tell a tenant's own account from the
//      global one. Migration 0069 made the chart of accounts per-tenant
//      (`unique (tenant_id, code)`, global rows carrying tenant_id IS
//      NULL), so `where code = '1100'` can match two rows, and `[0]` takes
//      whichever the planner produced first.
//
// This file proves the one lookup the product now uses: it names the code as
// a PARAMETER (never as text spliced into the query), it asks for the
// tenant's own account first, and a missing account raises a typed error
// that names the code.
//
// It needs no database — the connection is a fake that records the query and
// returns rows.

import { describe, expect, it } from 'vitest';
import type { ISql } from 'postgres';
import {
  MissingChartOfAccountsError,
  findAccount,
  findAccountId,
  requireAccountId,
} from '@/lib/accounting/chart-of-accounts';

interface Recorded {
  text: string;
  values: unknown[];
}

/** A connection that records the queries it is given and answers with `rows`. */
function fakeDb(rows: Array<Record<string, unknown>>) {
  const calls: Recorded[] = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return rows;
  };
  return Object.assign(fn, { calls }) as unknown as ISql & { calls: Recorded[] };
}

const ACCOUNT = {
  id: '11111111-2222-3333-4444-555555555555',
  code: '2210',
  name: 'VAT Payable to HMRC',
  type: 'liability',
  normal_balance: 'credit',
};

describe('the chart-of-accounts lookup', () => {
  it('passes the account code as a parameter, not as text in the query', async () => {
    const db = fakeDb([ACCOUNT]);
    await requireAccountId(db, '2210');

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].values).toContain('2210');
    expect(db.calls[0].text).not.toContain('2210');
    expect(db.calls[0].text).toContain('from accounting.chart_of_accounts');
  });

  it('asks for the tenant’s own account before the global one', async () => {
    const db = fakeDb([ACCOUNT]);
    await requireAccountId(db, '2210', 'a-tenant-id');

    // The tenant is a parameter, and the ordering is in the query — so the
    // tenant's own account is the one that comes back, and the global one is
    // the fallback.
    expect(db.calls[0].values).toContain('a-tenant-id');
    expect(db.calls[0].text).toContain('order by tenant_id nulls last');
    expect(db.calls[0].text).toContain('limit 1');
  });

  it('returns the account it found', async () => {
    const db = fakeDb([ACCOUNT]);
    expect(await findAccount(db, '2210')).toEqual(ACCOUNT);
    expect(await findAccountId(db, '2210')).toBe(ACCOUNT.id);
  });

  it('reports a missing account as a typed error that names the code', async () => {
    const db = fakeDb([]);
    let error: unknown = null;
    try {
      await requireAccountId(db, '2200');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(MissingChartOfAccountsError);
    expect((error as Error).message).toContain('2200');
    expect((error as MissingChartOfAccountsError).code).toBe('2200');
  });

  it('reports a missing account as absent when the caller only wants to know', async () => {
    const db = fakeDb([]);
    expect(await findAccount(db, '2200')).toBeNull();
    expect(await findAccountId(db, '2200')).toBeNull();
  });
});
