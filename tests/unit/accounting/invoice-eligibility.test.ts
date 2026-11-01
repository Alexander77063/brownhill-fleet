// tests/unit/accounting/invoice-eligibility.test.ts
//
// Which invoices may still receive money.
//
// The rule is written down once, in src/lib/accounting/invoice-eligibility.ts,
// and three callers depend on them agreeing: the reconciliation queue decides
// what the operator is offered, the reconcile API decides what it accepts, and
// the payment ingest decides what it pays down. If they disagree, an invoice
// can be offered and then refused — or, worse, refused nowhere and paid
// against a cancelled invoice.
//
// `void` is the state that disqualifies an invoice on its own: the invoice has
// been cancelled, so nothing is owed on it. `paid` is disqualified because
// nothing is outstanding. The other three states all mean "this invoice still
// owes money", and `overdue` is the one an operator most needs to be able to
// match a receipt against — an invoice that has gone overdue is exactly the
// one a late payment arrives for.

import { describe, expect, it } from 'vitest';
import {
  ALLOCATABLE_INVOICE_STATUSES,
  invoiceAllocationRejection,
  isAllocatableInvoiceStatus,
} from '@/lib/accounting/invoice-eligibility';

describe('ALLOCATABLE_INVOICE_STATUSES', () => {
  it('is exactly the states that still owe money', () => {
    // Pinned as a literal, not as the constant itself, so that widening or
    // narrowing the set has to be a deliberate change here too.
    expect([...ALLOCATABLE_INVOICE_STATUSES]).toEqual(['open', 'part_paid', 'overdue']);
  });
});

describe('isAllocatableInvoiceStatus', () => {
  it('accepts an open invoice', () => {
    expect(isAllocatableInvoiceStatus('open')).toBe(true);
  });

  it('accepts a part-paid invoice — money is still owed on it', () => {
    expect(isAllocatableInvoiceStatus('part_paid')).toBe(true);
  });

  it('accepts an overdue invoice — a late payment still clears it', () => {
    expect(isAllocatableInvoiceStatus('overdue')).toBe(true);
  });

  it('refuses a void invoice — it has been cancelled, so nothing is owed', () => {
    expect(isAllocatableInvoiceStatus('void')).toBe(false);
  });

  it('refuses a paid invoice — nothing is outstanding', () => {
    expect(isAllocatableInvoiceStatus('paid')).toBe(false);
  });

  it('refuses a status it does not recognise', () => {
    expect(isAllocatableInvoiceStatus('settled')).toBe(false);
  });

  it('refuses a missing status', () => {
    expect(isAllocatableInvoiceStatus(null)).toBe(false);
    expect(isAllocatableInvoiceStatus(undefined)).toBe(false);
    expect(isAllocatableInvoiceStatus('')).toBe(false);
  });

  it('is case-sensitive, because the column is an enum', () => {
    // `invoice_status` is a PostgreSQL enum, so the database can only ever
    // hand back one of these exact spellings. If a caller passes 'Open', it
    // is not a value the column can hold — treating it as allocatable would
    // mean trusting something the database would never produce.
    expect(isAllocatableInvoiceStatus('Open')).toBe(false);
  });
});

describe('invoiceAllocationRejection', () => {
  it('has nothing to say about an allocatable invoice', () => {
    expect(invoiceAllocationRejection('open')).toBeNull();
    expect(invoiceAllocationRejection('part_paid')).toBeNull();
    expect(invoiceAllocationRejection('overdue')).toBeNull();
  });

  it('says the invoice was voided, and says nothing about the money', () => {
    const message = invoiceAllocationRejection('void');
    expect(message).toBe('That invoice has been voided and cannot receive a payment.');
    expect(message).not.toMatch(/pence|£|amount|balance/i);
  });

  it('says the invoice is already settled', () => {
    expect(invoiceAllocationRejection('paid')).toBe('That invoice is already settled in full.');
  });

  it('gives a generic refusal for a status it does not recognise', () => {
    expect(invoiceAllocationRejection('settled')).toBe('That invoice cannot receive a payment.');
    expect(invoiceAllocationRejection(null)).toBe('That invoice cannot receive a payment.');
  });
});
