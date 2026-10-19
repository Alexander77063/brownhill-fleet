// tests/unit/accounting/bank-import-summary.test.ts
// Pure-function summary that the /admin/accounting/banks/[id]/import and
// /accounts/accounting/banks/[id]/import pages render after a CSV commit.
// Splits parsed transactions into (auto-matched) and (still-unmatched)
// rows so the operator sees what landed in the reconcile queue.

import { describe, expect, it } from 'vitest';
import { summarizeImport } from '@/lib/accounting/bank-import-summary';
import type { ParsedStatement, ParsedTransaction } from '@/lib/accounting/bank-rec';

const TX = (over: Partial<ParsedTransaction>): ParsedTransaction => ({
  postedAt: new Date('2026-09-01T00:00:00Z'),
  amountPence: 1000n,
  description: 'TEST',
  counterparty: null,
  ...over,
});

function statement(txs: ParsedTransaction[], format: 'barclays' = 'barclays'): ParsedStatement {
  return { format, transactions: txs, rawHash: 'x'.repeat(64) };
}

describe('summarizeImport', () => {
  it('returns the detected format and zero totals when there are no transactions', () => {
    const s = summarizeImport(statement([]), new Map());
    expect(s.format).toBe('barclays');
    expect(s.imported).toBe(0);
    expect(s.autoMatched).toBe(0);
    expect(s.stillUnmatched).toBe(0);
    expect(s.rows).toHaveLength(0);
  });

  it('counts each parsed transaction as imported even with no matches', () => {
    const s = summarizeImport(statement([TX({})]), new Map());
    expect(s.imported).toBe(1);
    expect(s.autoMatched).toBe(0);
    expect(s.stillUnmatched).toBe(1);
    expect(s.rows[0].status).toBe('unmatched');
  });

  it('marks a row auto_matched when its index is in the matches map and surfaces the payment id', () => {
    const matches = new Map<number, { paymentId: string; score: number }>([
      [0, { paymentId: 'pay-1', score: 0.95 }],
    ]);
    const s = summarizeImport(statement([TX({})]), matches);
    expect(s.imported).toBe(1);
    expect(s.autoMatched).toBe(1);
    expect(s.stillUnmatched).toBe(0);
    expect(s.rows[0].status).toBe('auto_matched');
    expect(s.rows[0].matchedPaymentId).toBe('pay-1');
    expect(s.rows[0].score).toBeCloseTo(0.95);
  });

  it('mixes matched and unmatched rows in input order', () => {
    const matches = new Map<number, { paymentId: string; score: number }>([
      [1, { paymentId: 'pay-2', score: 0.91 }],
    ]);
    const s = summarizeImport(
      statement([
        TX({ description: 'A' }),
        TX({ description: 'B' }),
        TX({ description: 'C' }),
      ]),
      matches,
    );
    expect(s.imported).toBe(3);
    expect(s.autoMatched).toBe(1);
    expect(s.stillUnmatched).toBe(2);
    expect(s.rows.map((r) => r.description)).toEqual(['A', 'B', 'C']);
    expect(s.rows.map((r) => r.status)).toEqual(['unmatched', 'auto_matched', 'unmatched']);
  });

  it('preserves the signed amount on the row', () => {
    const s = summarizeImport(
      statement([TX({ amountPence: -12_345n, description: 'OUT' })]),
      new Map(),
    );
    expect(s.rows[0].amountPence).toBe(-12_345n);
  });
});