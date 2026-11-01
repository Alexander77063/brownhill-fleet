// tests/unit/accounting/period-close-route.test.ts
//
// The period-close route: what it answers, and what it refuses.
//
// WHY THIS FILE EXISTS
// --------------------
// The Close button closed a month with one click and no warning. The spec
// asks for "Close period (warns: locks all postings; shows affected counts;
// confirm modal)". Nothing warned, nothing counted, and nothing confirmed,
// so an operator closing October with uncategorised bank lines and an unfiled
// VAT return found out afterwards, when a posting came back 409 and the
// month was already shut.
//
// This file is about the WIRING, which is exactly what breaks silently:
//
//   * A close must not run without an explicit confirmation. A gate that
//     cannot fail is not a gate — so the route REFUSES, and the refusal
//     carries the counts the operator needs to decide.
//   * A close must not run while there are warnings the operator has not
//     acknowledged. If a bank line lands while the dialog is open, the
//     operator must see it before the month shuts.
//   * A close of an already-closed period must be a 409 that names the
//     period and who closed it — the same typed refusal the reconcile route
//     answers with (tests/unit/accounting/reconcile-period-refusal.test.ts).
//   * A caller without `billing.write` must get 403, not a close.
//
// The database is faked: what is under test is the route's answer, not the
// ledger. The counts themselves are read from a real database in
// tests/integration/accounting/close-preflight.test.ts.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { AccountingPeriodError } from '@/lib/accounting/periods';
import type { ClosePreflight } from '@/lib/accounting/close-preflight';

const TENANT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444333333';
const CLOSER_ID = '66666666-6666-6666-6666-666666666666';

/** The preflight the faked database returns. */
const PREFLIGHT: ClosePreflight = {
  period: '2026-10',
  year: 2026,
  month: 10,
  status: 'open',
  canClose: true,
  blockedBy: null,
  closedAt: null,
  closedByUserId: null,
  lockedAt: null,
  warnings: [
    {
      code: 'open_bank_items',
      count: 3,
      amountPence: 45_000,
      message:
        'There are 3 open bank transactions dated in 2026-10 that have not been ' +
        'categorised yet (£450). Categorise them before closing.',
    },
  ],
  counts: {
    journalEntries: 12,
    openBankItems: 3,
    openBankItemsPence: 45_000,
    openInvoices: 1,
    openInvoicesPence: 12_000,
    netVatPence: 0,
    vatSubmission: 'none',
  },
};

// ── the fakes ──────────────────────────────────────────────────────────────
//
// The argument lists are spelled out so the fakes have the same shape as the
// functions they stand in for. A `vi.fn()` with no signature is typed as a
// zero-argument function, so calling it with the real arguments would be a
// type error — which is how a fake quietly stops matching the code.

const closePeriod =
  vi.fn<(tenantId: string, year: number, month: number, userId: string) => Promise<unknown>>();
const ensurePeriod =
  vi.fn<(tenantId: string, year: number, month: number, userId: string | null) => Promise<unknown>>();
const preflightPeriodClose =
  vi.fn<(tenantId: string, year: number, month: number) => Promise<ClosePreflight>>();
const requirePermission =
  vi.fn<(perm: string) => Promise<{ userId: string; tenantId: string }>>();

requirePermission.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
preflightPeriodClose.mockResolvedValue(PREFLIGHT);

vi.mock('@/lib/auth/context', () => ({
  requirePermission: (perm: string) => requirePermission(perm),
}));

vi.mock('@/lib/accounting/close-preflight', () => ({
  preflightPeriodClose: (tenantId: string, year: number, month: number) =>
    preflightPeriodClose(tenantId, year, month),
}));

// `periodRefusal` and `AccountingPeriodError` stay REAL — the route's job is
// to turn the typed refusal into the right answer, and a faked refusal would
// only prove the route can format a mock.
vi.mock('@/lib/accounting/periods', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/accounting/periods')>();
  return {
    ...actual,
    ensurePeriod: (
      tenantId: string,
      year: number,
      month: number,
      userId: string | null = null,
    ) => ensurePeriod(tenantId, year, month, userId),
    closePeriod: (tenantId: string, year: number, month: number, userId: string) =>
      closePeriod(tenantId, year, month, userId),
  };
});

import { POST } from '@/app/api/v1/accounting/periods/close/route';

function closeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/v1/accounting/periods/close', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('the period-close route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
    preflightPeriodClose.mockResolvedValue(PREFLIGHT);
    ensurePeriod.mockResolvedValue({ id: 'p1', year: 2026, month: 10 });
    closePeriod.mockResolvedValue({
      id: 'p1',
      year: 2026,
      month: 10,
      closedAt: new Date('2026-11-01T09:00:00.000Z'),
      closedByUserId: USER_ID,
      lockedAt: null,
    });
  });

  // ── the gate ─────────────────────────────────────────────────────────────

  it('refuses a close that has not been confirmed', async () => {
    const res = await POST(closeRequest({ period: '2026-10' }));

    expect(res.status).toBe(428);
    const body = await res.json();
    expect(body.code).toBe('confirmation_required');
    // The counts travel with the refusal: the operator has to be able to
    // see what they are about to strand in order to confirm.
    expect(body.preflight.counts.openBankItems).toBe(3);
    expect(body.preflight.warnings[0].message).toContain('open bank transactions');
    // And nothing was closed.
    expect(closePeriod).not.toHaveBeenCalled();
  });

  it('refuses a close whose warnings have not been acknowledged', async () => {
    // The operator confirmed — but a bank line landed while the dialog was
    // open, so there is now a warning they have not seen.
    const res = await POST(closeRequest({ period: '2026-10', confirm: true }));

    expect(res.status).toBe(428);
    const body = await res.json();
    expect(body.code).toBe('confirmation_required');
    expect(body.preflight.warnings[0].code).toBe('open_bank_items');
    expect(closePeriod).not.toHaveBeenCalled();
  });

  it('closes the period once the warnings are acknowledged', async () => {
    const res = await POST(
      closeRequest({
        period: '2026-10',
        confirm: true,
        acknowledge: ['open_bank_items'],
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.closed).toBe(true);
    expect(body.period).toBe('2026-10');
    expect(body.closedByUserId).toBe(USER_ID);
    // The close is made against the caller's tenant and the caller's user.
    expect(closePeriod).toHaveBeenCalledWith(TENANT_ID, 2026, 10, USER_ID);
  });

  it('answers 409 with the period and its closer when the period is already closed', async () => {
    closePeriod.mockRejectedValue(
      new AccountingPeriodError(
        'period_already_closed',
        2026,
        10,
        new Date('2026-11-01T09:00:00.000Z'),
        CLOSER_ID,
      ),
    );

    const res = await POST(
      closeRequest({ period: '2026-10', confirm: true, acknowledge: ['open_bank_items'] }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('period_already_closed');
    expect(body.period).toBe('2026-10');
    expect(body.closedByUserId).toBe(CLOSER_ID);
  });

  // ── the request ──────────────────────────────────────────────────────────

  it('answers 400 for a period that is not YYYY-MM', async () => {
    for (const period of ['2026-13', 'October 2026', '2026-10-01', '', 'last-month']) {
      const res = await POST(closeRequest({ period, confirm: true }));
      expect(res.status, `period ${JSON.stringify(period)} should be refused`).toBe(400);
    }
    expect(closePeriod).not.toHaveBeenCalled();
  });

  it('answers 403 for a caller without billing.write', async () => {
    requirePermission.mockRejectedValue(
      new Error("You don't have permission to do this (billing.write)."),
    );

    const res = await POST(
      closeRequest({ period: '2026-10', confirm: true, acknowledge: ['open_bank_items'] }),
    );

    expect(res.status).toBe(403);
    expect(closePeriod).not.toHaveBeenCalled();
  });

  it('answers 409 when the period cannot be closed at all', async () => {
    // The preflight knows the period is closed. There is nothing to confirm.
    preflightPeriodClose.mockResolvedValue({
      ...PREFLIGHT,
      status: 'closed' as const,
      canClose: false,
      blockedBy: 'Period 2026-10 is already closed.',
    });

    const res = await POST(
      closeRequest({ period: '2026-10', confirm: true, acknowledge: ['open_bank_items'] }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.period).toBe('2026-10');
    expect(closePeriod).not.toHaveBeenCalled();
  });
});
