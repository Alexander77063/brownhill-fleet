// tests/unit/accounting/bank-rec.test.ts
// Pure-function parser tests for the four UK bank formats.
// Each test uses a minimal CSV that exercises the parser's expected columns.

import { describe, expect, it } from 'vitest';
import { parseBankCsv, scoreMatch, bestMatch } from '@/lib/accounting/bank-rec';

const BARCLAYS_CSV = `Date,Type,Description,Value,Balance,Account Name,Account Number
2026-09-01,DD,STRIPE PAYOUT REF INV-001,1234.56,1234.56,Alex Smith,12345678
2026-09-02,CR,REFUND ACME LTD,-50.00,1184.56,Alex Smith,12345678`;

const HSBC_CSV = `Date,Description,Amount,Balance,Account
01/09/2026,FASTER PAYMENTS REF INV-002,500.00,500.00,Alex Smith`;

const STARLING_CSV = `Date,Type,Counterparty,Reference,Amount,Balance,Account
2026-09-03,FPI,Stripe,INV-003,750.00,750.00,Alex Smith`;

const LLOYDS_CSV = `Transaction Date,Type,Description,Amount,Balance,Account Name
03/09/2026,DEB,SUPPLIER PAYMENT INV-004,-200.00,-200.00,Alex Smith`;

describe('parseBankCsv — Barclays', () => {
  it('parses 7-column Barclays layout (date type desc value bal acct acct#)', async () => {
    const r = await parseBankCsv(BARCLAYS_CSV);
    expect(r.format).toBe('barclays');
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({
      amountPence: 123_456n,            // £1,234.56 in pence
      description: 'STRIPE PAYOUT REF INV-001',
    });
    expect(r.transactions[1].amountPence).toBe(-5_000n); // -£50.00
  });
});

describe('parseBankCsv — HSBC', () => {
  it('parses DD/MM/YYYY format and 4-column HSBC layout', async () => {
    const r = await parseBankCsv(HSBC_CSV);
    expect(r.format).toBe('hsbc');
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0].amountPence).toBe(50_000n);  // £500.00
  });
});

describe('parseBankCsv — Starling', () => {
  it('parses Starling ISO-date + 7-column layout', async () => {
    const r = await parseBankCsv(STARLING_CSV);
    expect(r.format).toBe('starling');
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0].amountPence).toBe(75_000n);  // £750.00
  });
});

describe('parseBankCsv — Lloyds', () => {
  it('parses DD/MM/YYYY + 5-column Lloyds layout', async () => {
    const r = await parseBankCsv(LLOYDS_CSV);
    expect(r.format).toBe('lloyds');
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0].amountPence).toBe(-20_000n); // -£200.00
  });
});

describe('parseBankCsv — error reporting', () => {
  it('rejects an unrecognised format', async () => {
    await expect(parseBankCsv('foo,bar\n1,2')).rejects.toThrow(/Unrecognised/);
  });
  it('rejects malformed amount with row number in the error', async () => {
    await expect(parseBankCsv(
      `Date,Type,Description,Value,Balance,Account Name,Account Number
2026-09-01,DD,Test,NOT_A_NUMBER,0,Alex,1234`,
    )).rejects.toThrow(/row 2/);
  });
});

describe('parseBankCsv — rawHash uniqueness', () => {
  it('produces the same hash for the same input', async () => {
    const a = await parseBankCsv(BARCLAYS_CSV);
    const b = await parseBankCsv(BARCLAYS_CSV);
    expect(a.rawHash).toBe(b.rawHash);
    expect(a.rawHash).toHaveLength(64);
  });
});

describe('scoreMatch', () => {
  const candidate = {
    paymentId: 'p1',
    grossPence: 123_456n,
    invoiceNo: 'INV-001',
    issuedAt: new Date('2026-08-30T00:00:00Z'),
  };
  it('returns >= 0.9 when amount matches exactly AND reference text contains invoice number', () => {
    const s = scoreMatch(
      { postedAt: new Date('2026-09-01'), amountPence: 123_456n, description: 'STRIPE PAYOUT REF INV-001', counterparty: 'Stripe' },
      candidate,
    );
    expect(s).toBeGreaterThanOrEqual(0.9);
  });
  it('returns < 0.9 when only the amount matches (reference text unrelated)', () => {
    const s = scoreMatch(
      { postedAt: new Date('2026-09-01'), amountPence: 123_456n, description: 'UNKNOWN PAYMENT', counterparty: 'Other' },
      candidate,
    );
    expect(s).toBeLessThan(0.9);
  });
  it('returns < 0.9 when only the reference matches (amount differs)', () => {
    const s = scoreMatch(
      { postedAt: new Date('2026-09-01'), amountPence: 99_999n, description: 'STRIPE PAYOUT REF INV-001', counterparty: 'Stripe' },
      candidate,
    );
    expect(s).toBeLessThan(0.9);
  });
});

describe('bestMatch', () => {
  const candidates = [
    { paymentId: 'p1', grossPence: 123_456n, invoiceNo: 'INV-001', issuedAt: new Date('2026-08-30') },
    { paymentId: 'p2', grossPence: 99_999n,  invoiceNo: 'INV-002', issuedAt: new Date('2026-08-30') },
  ];
  it('returns the highest-confidence candidate above threshold', () => {
    const m = bestMatch(
      { postedAt: new Date('2026-09-01'), amountPence: 123_456n, description: 'STRIPE PAYOUT REF INV-001', counterparty: 'Stripe' },
      candidates,
    );
    expect(m?.paymentId).toBe('p1');
  });
  it('returns null when no candidate reaches threshold', () => {
    const m = bestMatch(
      { postedAt: new Date('2026-09-01'), amountPence: 1n, description: 'no match', counterparty: 'X' },
      candidates,
    );
    expect(m).toBeNull();
  });
});
