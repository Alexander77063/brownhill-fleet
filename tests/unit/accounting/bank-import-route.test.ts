// tests/unit/accounting/bank-import-route.test.ts
//
// The bank CSV import route: what it answers on success.
//
// WHY THIS FILE EXISTS
// --------------------
// A SUCCESSFUL bank import answered 500.
//
//     POST /api/v1/accounting/banks/import  →  500
//     {"error":"Do not know how to serialize a BigInt"}
//
// with the rows already written, the money already in, and the bank line
// already pointing at the invoice it settled. The operator was told their
// import had failed when it had worked — so they imported it again, and the
// second import found the first import's rows and said something different
// again.
//
// Two things made it worse than a dead API:
//
//   * The success return sits OUTSIDE the route's try/catch, so the BigInt
//     error was not caught and shaped — it escaped as an unhandled throw.
//   * The client component already expected the right answer. Its TypeScript
//     says `amountPence: string`, its formatter calls `BigInt(p)`, and its
//     date cell calls `r.postedAt.slice(0, 10)`. The contract on both sides
//     of the wire was "pence as a string, dates as ISO strings". Only the
//     server broke it.
//
// The fix is at the WIRE BOUNDARY, the same place the report routes and the
// void route put theirs: a pence figure crosses the wire as a string.
//
// The database is faked. The CSV parser is REAL, because a summary of rows
// the parser cannot read is not the contract worth testing. What is under
// test is the route's ANSWER — 200, and a body the operator's browser can
// actually use.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const TENANT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444333333';
const BANK_ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';

/** An HSBC statement: date, description, amount, balance, account. */
const HSBC_CSV = `Date,Description,Amount,Balance,Account
01/09/2026,FASTER PAYMENTS REF INV-002,500.00,500.00,Alex Smith`;

/**
 * The faked database.
 *
 * The route names the table it is asking about in every statement, so the
 * fake answers on the table name. `begin` is here because the auto-match
 * path uses it — with no candidates there is nothing to match, so it is never
 * called, but the route has to be able to reach it without a TypeError.
 *
 * `bankAccountFound` is how a test says "this tenant has no such bank
 * account" — which is what another tenant's account looks like from here.
 */
const h = vi.hoisted(() => {
  const calls: string[] = [];
  const state = { bankAccountFound: true };
  const sql = (strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    calls.push(text);
    if (text.includes('from accounting.bank_accounts')) {
      return Promise.resolve(
        state.bankAccountFound
          ? [{ id: BANK_ACCOUNT_ID, name: 'Business current account', gl_account_id: 'gl-bank' }]
          : [],
      );
    }
    if (text.includes('from accounting.bank_imports')) return Promise.resolve([]);
    if (text.includes('into accounting.bank_imports')) return Promise.resolve([{ id: 'import-1' }]);
    if (text.includes('from accounting.periods')) return Promise.resolve([{ id: 'period-1' }]);
    return Promise.resolve([]);
  };
  (sql as unknown as { begin: (fn: (tx: unknown) => Promise<void>) => Promise<void> }).begin =
    async (fn) => fn(sql);
  return { sql, state, calls };
});

const requirePermission = vi.fn<(perm: string) => Promise<{ userId: string; tenantId: string }>>();
requirePermission.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });

const insertBankLines = vi.fn<
  (args: { lines: ReadonlyArray<unknown> }) => Promise<Map<number, string>>
>();
insertBankLines.mockResolvedValue(new Map([[0, 'bank-tx-1']]));

vi.mock('@/lib/auth/context', () => ({
  requirePermission: (perm: string) => requirePermission(perm),
}));

vi.mock('@/lib/auth/local-store', () => ({
  localDb: async () => h.sql,
}));

vi.mock('@/lib/accounting/bank-import', () => ({
  insertBankLines: (args: Parameters<typeof insertBankLines>[0]) => insertBankLines(args),
}));

vi.mock('@/lib/accounting/reconcile-queue', () => ({
  loadAutoMatchCandidates: async () => [],
}));

vi.mock('@/lib/accounting/chart-of-accounts', () => ({
  findAccountId: async () => 'ar-account-id',
}));

vi.mock('@/lib/accounting/journal', () => ({
  postBankReceiptJournal: () => ({ lines: [] }),
}));

vi.mock('@/lib/accounting/journal-bridge', () => ({
  commitJournalForBankTransaction: async () => 'journal-1',
}));

import { POST } from '@/app/api/v1/accounting/banks/import/route';

function importRequest(csv: string = HSBC_CSV, fileName = 'statement.csv'): NextRequest {
  const form = new FormData();
  form.append('bank_account_id', BANK_ACCOUNT_ID);
  form.append('file', new File([csv], fileName, { type: 'text/csv' }));
  return new NextRequest('http://localhost/api/v1/accounting/banks/import', {
    method: 'POST',
    body: form,
  });
}

describe('the bank import route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
    insertBankLines.mockResolvedValue(new Map([[0, 'bank-tx-1']]));
    h.state.bankAccountFound = true;
  });

  it('answers 200 for an import that worked', async () => {
    const res = await POST(importRequest());
    expect(res.status).toBe(200);
  });

  it('carries the summary the operator reads', async () => {
    const res = await POST(importRequest());
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.bankImportId).toBe('import-1');
    expect(body.inserted).toBe(1);
    expect(body.summary.format).toBe('hsbc');
    expect(body.summary.imported).toBe(1);
    expect(body.summary.autoMatched).toBe(0);
    expect(body.summary.stillUnmatched).toBe(1);
  });

  it('carries the money as a string, so the body survives JSON', async () => {
    const res = await POST(importRequest());
    const body = await res.json();

    // £500.00 — as the string the client component's `BigInt(p)` expects.
    expect(body.summary.rows[0].amountPence).toBe('50000');
  });

  it('carries the date as an ISO string, so the body survives JSON', async () => {
    const res = await POST(importRequest());
    const body = await res.json();

    // The client's date cell calls `r.postedAt.slice(0, 10)`.
    expect(typeof body.summary.rows[0].postedAt).toBe('string');
    expect(body.summary.rows[0].postedAt.slice(0, 10)).toBe('2026-09-01');
  });

  it('carries the description and the status', async () => {
    const res = await POST(importRequest());
    const body = await res.json();

    expect(body.summary.rows[0].description).toBe('FASTER PAYMENTS REF INV-002');
    expect(body.summary.rows[0].status).toBe('unmatched');
  });

  it('answers 400 for a request with no bank account', async () => {
    const form = new FormData();
    form.append('file', new File([HSBC_CSV], 'statement.csv', { type: 'text/csv' }));
    const res = await POST(
      new NextRequest('http://localhost/api/v1/accounting/banks/import', {
        method: 'POST',
        body: form,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('answers 400 for a file it cannot read, and imports nothing', async () => {
    const res = await POST(importRequest('not,a,bank,statement\n1,2,3,4'));
    expect(res.status).toBe(400);
    expect(insertBankLines).not.toHaveBeenCalled();
  });

  it('answers 403 for a caller without billing.write', async () => {
    requirePermission.mockRejectedValue(
      new Error("You don't have permission to do this (billing.write)."),
    );

    const res = await POST(importRequest());
    expect(res.status).toBe(403);
    expect(insertBankLines).not.toHaveBeenCalled();
  });

  it('answers 404 for a bank account that is not this tenant’s', async () => {
    // The faked database knows no bank account for this tenant — which is
    // what another tenant's account looks like from here.
    h.state.bankAccountFound = false;

    const res = await POST(importRequest());
    expect(res.status).toBe(404);
    expect(insertBankLines).not.toHaveBeenCalled();
  });
});
