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
