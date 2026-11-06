// tests/unit/accounting/reconcile-route.test.ts
//
// The reconciliation route: what it answers when the REQUEST is wrong.
//
// WHY THIS FILE EXISTS
// --------------------
// Two ordinary mistakes — a body the server cannot read, and a caller
// without the permission — both answered 500:
//
//     POST /api/v1/accounting/reconcile   (a JSON body)      → 500
//     POST /api/v1/accounting/reconcile   (no permission)    → 500
//
// A 500 says "the server is broken". Neither case is the server being
// broken: one is a malformed request and the other is a refusal. The rest
// of the accounting API already answers 400 and 403 for exactly these two
// situations — `periods/close` guards its permission the same way, and the
// bank import guards both — so the route that posts a bank line to the
// ledger was the odd one out.
//
// It is not cosmetic either. A 500 is what a browser shows the operator as
// "something went wrong", and the operator's only way out is to guess. A
// 400 says what was wrong with the request; a 403 says the request was
// refused.
//
// A refusal also has to happen BEFORE the ledger is touched. A route that
// opens a transaction and then refuses is a route that can leave a lock
// behind, and the ledger is the one thing on this box that must not be
// left half-done.
//
// The database is faked, and the fake RECORDS that it was reached: a
// refusal that touched the database would fail these tests. The session is
// faked for the same reason — the permission is not what is under test, the
// route's answer to it is.
//
// The happy path — a bank line that reconciles against an invoice — is
// exercised in tests/unit/accounting/reconcile-period-refusal.test.ts and
// against a real database in tests/integration/accounting/.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const TENANT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const BANK_TX_ID = '55555555-5555-5555-5555-555555555555';

const requirePermission = vi.fn<(perm: string) => Promise<{ userId: string; tenantId: string }>>();
requirePermission.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });

vi.mock('@/lib/auth/context', () => ({
  requirePermission: (perm: string) => requirePermission(perm),
}));

/**
 * The database, and the record that it was reached.
 *
 * The route must refuse a bad request and a caller without the permission
 * BEFORE it asks for anything. A route that queried first and refused
 * second would still answer 403 — and would still hold a transaction open
 * while it did.
 */
const h = vi.hoisted(() => ({ dbReached: 0 }));

vi.mock('@/lib/auth/local-store', () => ({
  localDb: async () => {
    h.dbReached += 1;
    throw new Error('the route must refuse before it reaches the database');
  },
}));

vi.mock('@/lib/accounting/journal-bridge', () => ({
  withJournalTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  commitJournalForBankTransaction: async () => {
    throw new Error('the route must refuse before it reaches the ledger');
  },
  commitJournalForPayment: async () => {
    throw new Error('the route must refuse before it reaches the ledger');
  },
}));

import { POST } from '@/app/api/v1/accounting/reconcile/route';

/** The request the operator's screen posts: a form. */
function reconcileForm(action = 'vat', extra: Record<string, string> = {}): NextRequest {
  const form = new FormData();
  form.set('bankTxId', BANK_TX_ID);
  form.set('action', action);
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return new NextRequest('http://localhost/api/v1/accounting/reconcile', {
    method: 'POST',
    body: form,
  });
}

/** The request a script or a mis-wired integration sends: JSON. */
function reconcileJson(payload: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/v1/accounting/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('the reconciliation route, when the request is wrong', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.dbReached = 0;
    requirePermission.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
  });

  it('answers 403 for a caller without billing.write', async () => {
    requirePermission.mockRejectedValue(
      new Error("You don't have permission to do this (billing.write)."),
    );

    const res = await POST(reconcileForm());

    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('billing.write');
  });

  it('answers 403 without touching the database', async () => {
    requirePermission.mockRejectedValue(
      new Error("You don't have permission to do this (billing.write)."),
    );

    await POST(reconcileForm());

    expect(h.dbReached).toBe(0);
  });

  it('answers 400 for a body it cannot read as a form', async () => {
    const res = await POST(reconcileJson({ bankTxId: BANK_TX_ID, action: 'vat' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/form/i);
  });

  it('answers 400 without touching the database', async () => {
    await POST(reconcileJson({ bankTxId: BANK_TX_ID, action: 'vat' }));

    expect(h.dbReached).toBe(0);
  });

  it('answers 400 for a request with no body at all', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/v1/accounting/reconcile', { method: 'POST' }),
    );

    expect(res.status).toBe(400);
  });
});
