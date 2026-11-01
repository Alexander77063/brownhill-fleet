// tests/unit/accounting/reconcile-queue.test.ts
//
// The reconciliation queue offers the operator the invoices a bank line can be
// matched against. `outstandingPence` decides which invoices those are.
//
// The arithmetic matters: an invoice that is already settled in full must not
// be offered as a match target, because allocating a payment to it would
// either be rejected by the `check_allocation` trigger or leave the invoice
// over-allocated. And a part-paid invoice must show what is LEFT, not what
// it was worth originally — otherwise the operator matches a receipt against
// an amount that is already in the bank.
//
// THE SHAPE OF `issued_on`
// -----------------------
// The issue day is a STRING — 'YYYY-MM-DD' — because the console slices it
// with `.slice(0, 10)`. It was not always: the loader used to select the raw
// `date` column, which postgres.js hands back as a JavaScript Date, and
// `.slice` does not exist on a Date, so both reconciliation consoles 500d.
//
// The loader now casts the column, and the fixture below matches what the
// loader really returns. The test that proves the loader really returns it
// is tests/integration/accounting/reconcile-queue-dates.test.ts, which reads
// through the database rather than through a fixture.

import { describe, expect, it } from 'vitest';
import { outstandingPence, type OpenInvoiceRow } from '@/lib/accounting/reconcile-queue';

function invoice(gross: string, allocated: string): OpenInvoiceRow {
  return {
    id: 'inv-1',
    number: 'INV-001',
    issued_on: '2026-10-01',
    gross_pence: gross,
    allocated_pence: allocated,
  };
}

describe('outstandingPence', () => {
  it('is the whole gross when nothing has been allocated', () => {
    expect(outstandingPence(invoice('120000', '0'))).toBe(120_000n);
  });

  it('is what is left after a part payment', () => {
    expect(outstandingPence(invoice('120000', '50000'))).toBe(70_000n);
  });

  it('is zero when the invoice is settled in full', () => {
    expect(outstandingPence(invoice('120000', '120000'))).toBe(0n);
  });

  it('never goes negative when the allocation exceeds the gross', () => {
    // Over-allocated data must not produce a negative balance that would
    // then be offered as a match target.
    expect(outstandingPence(invoice('120000', '130000'))).toBe(0n);
  });
});

describe('the invoice row the console renders', () => {
  it('carries the issue day as a string the console can slice', () => {
    // The exact expression src/components/accounting/ReconcileQueue.tsx runs
    // on the row the loader hands it.
    const row = invoice('120000', '0');
    expect(typeof row.issued_on).toBe('string');
    expect(row.issued_on.slice(0, 10)).toBe('2026-10-01');
  });
});
