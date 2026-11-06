// tests/unit/accounting/reports-route.test.ts
//
// The accounting reports API: what it answers, and what it refuses.
//
// WHY THIS FILE EXISTS
// --------------------
// The four report routes answered 500, every time, for every tenant:
//
//     GET /api/v1/accounting/reports/pnl          → 500
//     GET /api/v1/accounting/reports/balance-sheet → 500
//     GET /api/v1/accounting/reports/cashflow     → 500
//     GET /api/v1/accounting/reports/ar-aging     → 500
//
// with the body `{"error":"Do not know how to serialize a BigInt"}`.
//
// Every pence figure in the accounting module is a BigInt — money is not a
// float — and `NextResponse.json` calls `JSON.stringify`, which THROWS on a
// BigInt. The operator's own screens under src/app/admin/accounting/reports
// are server-rendered and format the figures themselves, so the human view of
// the books was never broken. The JSON API was dead, and the accountant
// export flow that is meant to read it had nothing to read.
//
// The fix is at the WIRE BOUNDARY: a pence figure crosses the wire as a
// string, which is the convention the void route already used and the one the
// bank import's own client component already expected.
//
// The database is faked. What is under test is the route's ANSWER — that it
// answers 200, and that the money in the body is in a shape JSON can carry.
// The report arithmetic itself is tested against a real database in
// tests/integration/accounting/.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const TENANT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444333333';

const requirePermission = vi.fn<(perm: string) => Promise<{ userId: string; tenantId: string }>>();
requirePermission.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });

vi.mock('@/lib/auth/context', () => ({
  requirePermission: (perm: string) => requirePermission(perm),
}));

// The reports come back with money in them, as BigInt — that is the point.
// The fakes return exactly the shapes src/lib/accounting/reports.ts returns.
//
// They are `vi.fn()`s rather than plain async functions so a test can make one
// of them fail on demand.
const h = vi.hoisted(() => ({
  renderProfitAndLoss: vi.fn(async () => ({
    fromDate: new Date('2026-01-01T00:00:00.000Z'),
    toDate: new Date('2026-12-31T00:00:00.000Z'),
    rows: [
      { accountCode: '4000', accountName: 'Revenue', accountType: 'revenue', amountPence: 250_000n },
      { accountCode: '5910', accountName: 'Bank charges', accountType: 'expense', amountPence: 1_500n },
    ],
    totalRevenuePence: 250_000n,
    totalExpensePence: 1_500n,
    netResultPence: 248_500n,
  })),
  renderBalanceSheet: vi.fn(async () => ({
    asOfDate: new Date('2026-12-31T00:00:00.000Z'),
    rows: [
      { accountCode: '1100', accountName: 'Trade debtors', accountClass: 'asset', amountPence: 120_000n },
      { accountCode: '1200', accountName: 'Bank account', accountClass: 'asset', amountPence: 30_000n },
    ],
    totalAssetsPence: 150_000n,
    totalLiabilitiesPence: 20_000n,
    totalEquityPence: 130_000n,
    imbalancePence: 0n,
  })),
  renderCashflow: vi.fn(async () => ({
    fromDate: new Date('2026-01-01T00:00:00.000Z'),
    toDate: new Date('2026-12-31T00:00:00.000Z'),
    operating: {
      label: 'Operating',
      rows: [{ accountCode: '4000', accountName: 'Revenue', amountPence: 250_000n }],
      subtotalPence: 250_000n,
    },
    investing: { label: 'Investing', rows: [], subtotalPence: 0n },
    financing: { label: 'Financing', rows: [], subtotalPence: 0n },
    netChangePence: 248_500n,
  })),
  renderArAging: vi.fn(async () => ({
    asOfDate: new Date('2026-12-31T00:00:00.000Z'),
    buckets: [{ label: '0-30 days', totalPence: 120_000n, customerCount: 2 }],
    rows: [
      { customerId: 'c1', customerName: 'Alex Smith', outstandingPence: 120_000n, bucket: '0-30' },
    ],
    totalOutstandingPence: 120_000n,
  })),
}));

vi.mock('@/lib/accounting/reports', () => h);

import { GET } from '@/app/api/v1/accounting/reports/[type]/route';

function reportRequest(type: string, query: Record<string, string> = {}): NextRequest {
  const url = new URL(`http://localhost/api/v1/accounting/reports/${type}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new NextRequest(url);
}

function call(type: string, query: Record<string, string> = {}) {
  return GET(reportRequest(type, query), { params: Promise.resolve({ type }) });
}

describe('the accounting reports route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
  });

  it('answers 200 for the profit and loss', async () => {
    const res = await call('pnl', { from: '2026-01-01', to: '2026-12-31' });
    expect(res.status).toBe(200);
  });

  it('answers 200 for the balance sheet', async () => {
    const res = await call('balance-sheet', { as_of: '2026-12-31' });
    expect(res.status).toBe(200);
  });

  it('answers 200 for the cashflow', async () => {
    const res = await call('cashflow', { from: '2026-01-01', to: '2026-12-31' });
    expect(res.status).toBe(200);
  });

  it('answers 200 for the AR aging', async () => {
    const res = await call('ar-aging', { as_of: '2026-12-31' });
    expect(res.status).toBe(200);
  });

  it('carries the money as strings, so the body survives JSON', async () => {
    const res = await call('pnl', { from: '2026-01-01', to: '2026-12-31' });
    const body = await res.json();

    expect(body.totalRevenuePence).toBe('250000');
    expect(body.totalExpensePence).toBe('1500');
    expect(body.netResultPence).toBe('248500');
    // And inside the rows — a converter that only looked at the top level
    // would have thrown here.
    expect(body.rows[0].amountPence).toBe('250000');
    expect(body.rows[1].amountPence).toBe('1500');
    // The non-money fields are untouched.
    expect(body.rows[0].accountCode).toBe('4000');
    expect(body.rows[0].accountType).toBe('revenue');
  });

  it('carries the balance sheet money as strings', async () => {
    const res = await call('balance-sheet', { as_of: '2026-12-31' });
    const body = await res.json();

    expect(body.totalAssetsPence).toBe('150000');
    expect(body.totalLiabilitiesPence).toBe('20000');
    expect(body.totalEquityPence).toBe('130000');
    expect(body.imbalancePence).toBe('0');
    expect(body.rows[0].amountPence).toBe('120000');
  });

  it('carries the cashflow money as strings', async () => {
    const res = await call('cashflow', { from: '2026-01-01', to: '2026-12-31' });
    const body = await res.json();

    expect(body.netChangePence).toBe('248500');
    expect(body.operating.subtotalPence).toBe('250000');
    expect(body.operating.rows[0].amountPence).toBe('250000');
  });

  it('carries the AR aging money as strings', async () => {
    const res = await call('ar-aging', { as_of: '2026-12-31' });
    const body = await res.json();

    expect(body.totalOutstandingPence).toBe('120000');
    expect(body.buckets[0].totalPence).toBe('120000');
    expect(body.rows[0].outstandingPence).toBe('120000');
  });

  it('carries the dates as ISO strings', async () => {
    const res = await call('pnl', { from: '2026-01-01', to: '2026-12-31' });
    const body = await res.json();
    expect(body.fromDate).toBe('2026-01-01T00:00:00.000Z');
    expect(body.toDate).toBe('2026-12-31T00:00:00.000Z');
  });

  it('answers 400 when the range a report needs is missing', async () => {
    const pnl = await call('pnl');
    expect(pnl.status).toBe(400);

    const bs = await call('balance-sheet');
    expect(bs.status).toBe(400);
  });

  it('answers 404 for a report type that does not exist', async () => {
    const res = await call('trial-balance');
    expect(res.status).toBe(404);
  });

  it('answers 403 for a caller without reports.operational', async () => {
    // A refusal is a refusal, not a server error. The gate's throw used to
    // escape the handler, so a caller without the permission was told the
    // server was broken — while the rest of the accounting API answers 403
    // for exactly this situation.
    requirePermission.mockRejectedValue(
      new Error("You don't have permission to do this (reports.operational)."),
    );

    const res = await call('pnl', { from: '2026-01-01', to: '2026-12-31' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('reports.operational');
  });

  it('answers 500 with the message when the report itself fails', async () => {
    // A failure inside the report must not become an unhandled rejection that
    // takes the whole request down with an empty body.
    h.renderProfitAndLoss.mockRejectedValueOnce(new Error('ledger unavailable'));

    const res = await call('pnl', { from: '2026-01-01', to: '2026-12-31' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('ledger unavailable');
  });
});
