// tests/unit/accounting/reconcile-permission.test.ts
//
// The reconciliation route, when the caller does not hold the permission.
//
// WHY THIS FILE EXISTS
// --------------------
// The reconcile route was one of two accounting routes that called
// `requirePermission` bare, letting its refusal escape as an unhandled error
// — a 500 with an empty body:
//
//     POST /api/v1/accounting/reconcile  (no billing.write)  → 500
//
// Its four siblings in src/app/api/v1/accounting/ all wrap the call and answer
// 403:
//
//     banks/import   periods/close   mtd/[action]   invoices/[id]/void
//
// A 500 says "the server is broken". A 403 says "you may not do this", and it
// is the answer the operator's browser should get — the reconcile route is a
// form POST from the accounting console, so this is what a user with the
// wrong role sees when the button is pressed.
//
// The database is faked, and the fake REFUSES to be called: the gate has to
// fire before any ledger work, and the test proves it rather than assuming it.
//
// The permission is the thing under test here, so the session is faked — the
// same division of labour the closed-period test file uses.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const TENANT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const BANK_TX_ID = '55555555-5555-5555-5555-555555555555';
const INVOICE_ID = '99999999-9999-9999-9999-999999999999';

const requirePermission = vi.fn<(perm: string) => Promise<{ userId: string; tenantId: string }>>();
requirePermission.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });

vi.mock('@/lib/auth/context', () => ({
  requirePermission: (perm: string) => requirePermission(perm),
}));

// Any database access is a failure. The gate has to fire first, and the
// assertion that it does is `expect(h.localDb).not.toHaveBeenCalled()`.
const h = vi.hoisted(() => ({
  localDb: vi.fn(async () => {
    throw new Error('the database must not be reached when the permission is refused');
  }),
}));

vi.mock('@/lib/auth/local-store', () => ({ localDb: h.localDb }));

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

describe('the reconciliation route, when the permission is refused', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
  });

  it('answers 403, not 500', async () => {
    requirePermission.mockRejectedValueOnce(
      new Error("You don't have permission to do this (billing.write)."),
    );

    const res = await POST(reconcileRequest('match', { invoiceId: INVOICE_ID }));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('billing.write');
  });

  it('answers 403 for every action, not only the one that was pressed', async () => {
    for (const action of ['match', 'vat', 'fee', 'ignore']) {
      requirePermission.mockRejectedValueOnce(new Error('refused'));

      const res = await POST(reconcileRequest(action, { invoiceId: INVOICE_ID }));

      expect(res.status, `action "${action}" should be refused with 403`).toBe(403);
    }
  });

  it('refuses before it touches the ledger', async () => {
    requirePermission.mockRejectedValueOnce(new Error('refused'));

    await POST(reconcileRequest('vat'));

    // The gate fires first: no bank line is read, no journal is written.
    expect(h.localDb).not.toHaveBeenCalled();
  });
});
