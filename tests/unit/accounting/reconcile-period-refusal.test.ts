// tests/unit/accounting/reconcile-period-refusal.test.ts
//
// The reconciliation route, when the ledger refuses a posting because the
// period is closed.
//
// WHY THIS FILE EXISTS
// --------------------
// A closed period must be a CONFLICT (409) that names the period, not a 500
// and not a 409 whose body says "Could not match this bank transaction" and
// names nothing. The three posting branches of the route — match, VAT
// payment, bank fee — each answer for themselves, and each of them used to
// let the refusal escape as an unexpected failure:
//
//   * 'vat' and 'fee' sat OUTSIDE any try/catch, so a closed period came
//     back as an unhandled 500.
//   * 'match' caught everything and answered with one generic message, so a
//     closed period was indistinguishable from a broken match.
//
// The guard that raises the refusal is exercised against a real database in
// tests/integration/accounting/period-close.test.ts. This file is about the
// other half: that the ROUTE turns the refusal into a 409 with the period in
// the body. That half is wiring, and wiring is exactly what breaks silently.
//
// The database is faked, because what is under test is the route's answer —
// not the ledger. The session is faked for the same reason.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { AccountingPeriodError } from '@/lib/accounting/periods';

const TENANT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const BANK_TX_ID = '55555555-5555-5555-5555-555555555555';
const CLOSER_ID = '66666666-6666-6666-6666-666666666666';

/** The bank line the operator is trying to categorise. */
const BANK_TX = {
  id: BANK_TX_ID,
  bank_account_id: '77777777-7777-7777-7777-777777777777',
  amount_pence: '12000',
  bank_gl_id: '88888888-8888-8888-8888-888888888888',
  description: 'VAT PAYABLE HMRC',
  posted_at: '2026-11-01T00:00:00.000Z',
  status: 'unmatched',
};

/** The invoice the operator picked, still owing money. */
const INVOICE = {
  id: '99999999-9999-9999-9999-999999999999',
  gross_pence: '12000',
  agreement_id: null,
  status: 'open',
  driver_id: null,
  allocated_pence: '0',
};

/**
 * A postgres.js-shaped fake: a tagged-template function whose answer depends
 * on the statement, plus `begin` for the transaction handle.
 */
function fakeSql(answer: (text: string) => unknown[]) {
  const handler = async (strings: TemplateStringsArray) => answer(strings.join(' '));
  const sql = handler as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  sql.begin = async (cb) => cb(handler);
  return sql;
}

/** The refusal the ledger raises for a closed period. */
function closedPeriodError(): AccountingPeriodError {
  return new AccountingPeriodError(
    'period_closed',
    2026,
    10,
    new Date('2026-11-01T09:00:00.000Z'),
    CLOSER_ID,
  );
}

// The database is faked: the bank line answers the first query, the invoice
// answers the second, and the chart-of-accounts lookup gets the bank line's
// id as a harmless stand-in.
vi.mock('@/lib/auth/local-store', () => ({
  localDb: async () =>
    fakeSql((text) => (text.includes('from public.invoices') ? [INVOICE] : [BANK_TX])),
}));

// The session is faked: the route is permission-gated, and the permission is
// not what is under test.
vi.mock('@/lib/auth/context', () => ({
  requirePermission: async () => ({ userId: USER_ID, tenantId: TENANT_ID }),
}));

// The ledger raises the refusal. Everything else about the posting is real.
vi.mock('@/lib/accounting/journal-bridge', () => ({
  withJournalTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  commitJournalForBankTransaction: async () => {
    throw closedPeriodError();
  },
  commitJournalForPayment: async () => {
    throw closedPeriodError();
  },
}));

import { POST } from '@/app/api/v1/accounting/reconcile/route';

function reconcileRequest(action: string, extra: Record<string, string> = {}): NextRequest {
  const form = new FormData();
  form.set('bankTxId', BANK_TX_ID);
  form.set('action', action);
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return new NextRequest('http://localhost/api/v1/accounting/reconcile', {
    method: 'POST',
    body: form,
  });
}

describe('the reconciliation route, when the period is closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 409 with the period and its closer, for a VAT payment', async () => {
    const res = await POST(reconcileRequest('vat'));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('period_closed');
    expect(body.period).toBe('2026-10');
    expect(body.closedByUserId).toBe(CLOSER_ID);
    expect(body.error).toContain('2026-10');
  });

  it('answers 409 with the period and its closer, for a bank fee', async () => {
    const res = await POST(reconcileRequest('fee'));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('period_closed');
    expect(body.period).toBe('2026-10');
    expect(body.closedByUserId).toBe(CLOSER_ID);
  });

  it('answers 409 with the period and its closer, for a match', async () => {
    const res = await POST(
      reconcileRequest('match', { invoiceId: '99999999-9999-9999-9999-999999999999' }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('period_closed');
    expect(body.period).toBe('2026-10');
    expect(body.closedByUserId).toBe(CLOSER_ID);
    // NOT the generic message: the operator has to be told which period.
    expect(body.error).not.toBe('Could not match this bank transaction.');
  });
});
