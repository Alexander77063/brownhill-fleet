// tests/unit/accounting/journal.test.ts
// Pure-function domain tests for the GL posting rule generators. These assert
// the *shape* of each posting — which accounts, which side, what amounts —
// without touching the DB. The DB writes are tested in integration tests
// (in this PR we ship the unit-test layer; integration tests land when the
// SaaS team's app code is wired to call commitJournalForInvoice / etc.).
import { describe, expect, it } from 'vitest';
import {
  postInvoiceJournal, postPaymentJournal, postVatSubmissionJournal,
  postVatPaymentJournal, postReversalJournal, postBankFeeJournal,
  type InvoiceForPosting, type PaymentForPosting, type VatSubmissionForPosting,
  type BankVatPaymentForPosting, type ReversalForPosting, type BankFeeForPosting,
} from '@/lib/accounting/journal';

const COA = {
  ar:        { id: '1100-id' },
  revenue:   { id: '4000-id' },
  vatOutput: { id: '2200-id' },
  vatPayable:{ id: '2210-id' },
  bankGl:    { id: '1200-id' },
  bankCharges:{ id: '5910-id' },
  refundsPayable: { id: '2120-id' },
};

describe('postInvoiceJournal (Rule #1)', () => {
  it('posts Dr AR / Cr Revenue / Cr VAT-Output on invoice issued', () => {
    const input: InvoiceForPosting = {
      invoiceId: 'inv-1',
      net: 100_000n, vat: 20_000n, gross: 120_000n,
      chartOfAccounts: { ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput },
    };
    const r = postInvoiceJournal(input);
    expect(r.lines).toHaveLength(3);
    expect(r.lines.find(l => l.accountId === COA.ar.id)?.debitPence).toBe(120_000n);
    expect(r.lines.find(l => l.accountId === COA.ar.id)?.creditPence).toBe(0n);
    expect(r.lines.find(l => l.accountId === COA.revenue.id)?.debitPence).toBe(0n);
    expect(r.lines.find(l => l.accountId === COA.revenue.id)?.creditPence).toBe(100_000n);
    expect(r.lines.find(l => l.accountId === COA.vatOutput.id)?.debitPence).toBe(0n);
    expect(r.lines.find(l => l.accountId === COA.vatOutput.id)?.creditPence).toBe(20_000n);
    expect(r.sumDebits).toBe(120_000n);
    expect(r.sumCredits).toBe(120_000n);
    expect(r.sourceType).toBe('invoice');
    expect(r.sourceId).toBe('inv-1');
  });

  it('handles zero-rated invoices (£0 VAT)', () => {
    const r = postInvoiceJournal({
      invoiceId: 'inv-2',
      net: 50_000n, vat: 0n, gross: 50_000n,
      chartOfAccounts: { ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput },
    });
    expect(r.sumDebits).toBe(50_000n);
    expect(r.sumCredits).toBe(50_000n);
  });

  it('throws on an imbalanced invoice (defensive)', () => {
    expect(() => postInvoiceJournal({
      invoiceId: 'inv-3',
      net: 100_000n, vat: 20_000n, gross: 119_999n,  // off by 1
      chartOfAccounts: { ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput },
    })).toThrow(/Imbalanced/);
  });
});

describe('postPaymentJournal (Rule #2)', () => {
  it('posts Dr Bank / Cr AR on payment confirmed', () => {
    const input: PaymentForPosting = {
      paymentId: 'pay-1',
      gross: 120_000n,
      bankAccountGlId: COA.bankGl.id,
      arAccountId: COA.ar.id,
    };
    const r = postPaymentJournal(input);
    expect(r.lines).toHaveLength(2);
    expect(r.lines.find(l => l.accountId === COA.bankGl.id)?.debitPence).toBe(120_000n);
    expect(r.lines.find(l => l.accountId === COA.ar.id)?.creditPence).toBe(120_000n);
    expect(r.sumDebits).toBe(r.sumCredits);
    expect(r.sourceType).toBe('payment');
  });
});

describe('postVatSubmissionJournal (Rule #5)', () => {
  it('posts Dr VAT Output / Cr VAT Payable on HMRC submission success', () => {
    const input: VatSubmissionForPosting = {
      submissionId: 'sub-1',
      vatAmount: 200_000n,
      vatOutputAccountId: COA.vatOutput.id,
      vatPayableAccountId: COA.vatPayable.id,
    };
    const r = postVatSubmissionJournal(input);
    expect(r.lines).toHaveLength(2);
    expect(r.sumDebits).toBe(200_000n);
    expect(r.sumCredits).toBe(200_000n);
    expect(r.sourceType).toBe('vat_submission');
  });
});

describe('postVatPaymentJournal (Rule #6)', () => {
  it('posts Dr VAT Payable / Cr Bank when operator marks a bank tx as VAT payment', () => {
    const input: BankVatPaymentForPosting = {
      bankTxId: 'btx-1',
      amount: 200_000n,
      vatPayableAccountId: COA.vatPayable.id,
      bankGlAccountId: COA.bankGl.id,
    };
    const r = postVatPaymentJournal(input);
    expect(r.lines).toHaveLength(2);
    expect(r.sumDebits).toBe(200_000n);
    expect(r.sumCredits).toBe(200_000n);
    expect(r.sourceType).toBe('bank_transaction');
  });
});

describe('postReversalJournal (void + credit note)', () => {
  it('negates the three invoice lines on void', () => {
    const r = postReversalJournal({
      sourceId: 'inv-void-1',
      sourceType: 'invoice_void',
      invoice: { net: 100_000n, vat: 20_000n, gross: 120_000n },
      chartOfAccounts: { ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput },
    });
    expect(r.lines.find(l => l.accountId === COA.ar.id)?.creditPence).toBe(120_000n);
    expect(r.lines.find(l => l.accountId === COA.revenue.id)?.debitPence).toBe(100_000n);
    expect(r.lines.find(l => l.accountId === COA.vatOutput.id)?.debitPence).toBe(20_000n);
    expect(r.sumDebits).toBe(r.sumCredits);
  });

  it('produces identical shape on credit-note vs invoice-void (only sourceType differs)', () => {
    const void_ = postReversalJournal({
      sourceId: 'a', sourceType: 'invoice_void',
      invoice: { net: 100_000n, vat: 20_000n, gross: 120_000n },
      chartOfAccounts: { ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput },
    });
    const creditNote = postReversalJournal({
      sourceId: 'a', sourceType: 'credit_note',
      invoice: { net: 100_000n, vat: 20_000n, gross: 120_000n },
      chartOfAccounts: { ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput },
    });
    expect(void_.lines.map(l => `${l.accountId}:${l.debitPence}:${l.creditPence}`)).toEqual(
      creditNote.lines.map(l => `${l.accountId}:${l.debitPence}:${l.creditPence}`),
    );
    expect(void_.sourceType).toBe('invoice_void');
    expect(creditNote.sourceType).toBe('credit_note');
  });
});

describe('postReversalJournal — voiding an invoice', () => {
  // THE PAID CASE
  // ------------
  // The design spec (§ "Operational / UX errors") says a paid invoice can be
  // voided: "Void is allowed. Reversal entry plus a refund liability entry
  // against a 2120 Refunds-Payable account."
  //
  // The reason a plain mirror of rule #1 is wrong for a paid invoice is
  // arithmetic, not taste. The invoice DEBITED Trade Debtors for the gross
  // and the payment CREDITED it for the gross, so the account is already at
  // zero. A reversal that credits Trade Debtors again leaves it at MINUS the
  // gross — a negative asset — when what is actually true is that the money
  // has been received and is now owed back. That is a liability, and the
  // chart of accounts has one: 2120 Refunds Payable.
  //
  // So the credit side of a void is SPLIT: the part still owed goes back to
  // Trade Debtors, and the part already received becomes a refund the
  // operator still owes the customer.

  it('credits Trade Debtors with the whole invoice when nothing has been received', () => {
    const r = postReversalJournal({
      sourceId: 'inv-void-2',
      sourceType: 'invoice_void',
      invoice: { net: 100_000n, vat: 20_000n, gross: 120_000n },
      chartOfAccounts: {
        ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput,
        refundsPayable: COA.refundsPayable,
      },
      receivedPence: 0n,
    });
    expect(r.lines).toHaveLength(3);
    expect(r.lines.find(l => l.accountId === COA.ar.id)?.creditPence).toBe(120_000n);
    expect(r.lines.find(l => l.accountId === COA.refundsPayable.id)).toBeUndefined();
    expect(r.sumDebits).toBe(r.sumCredits);
  });

  it('credits Refunds Payable — not Trade Debtors — when the invoice has been paid', () => {
    const r = postReversalJournal({
      sourceId: 'inv-void-3',
      sourceType: 'invoice_void',
      invoice: { net: 100_000n, vat: 20_000n, gross: 120_000n },
      chartOfAccounts: {
        ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput,
        refundsPayable: COA.refundsPayable,
      },
      receivedPence: 120_000n,
    });
    // No Trade Debtors line at all: the account is already at zero.
    expect(r.lines.find(l => l.accountId === COA.ar.id)).toBeUndefined();
    expect(r.lines.find(l => l.accountId === COA.refundsPayable.id)?.creditPence).toBe(120_000n);
    // The revenue and the VAT are still reversed in full.
    expect(r.lines.find(l => l.accountId === COA.revenue.id)?.debitPence).toBe(100_000n);
    expect(r.lines.find(l => l.accountId === COA.vatOutput.id)?.debitPence).toBe(20_000n);
    expect(r.sumDebits).toBe(r.sumCredits);
  });

  it('splits the credit when the invoice is only part-paid', () => {
    const r = postReversalJournal({
      sourceId: 'inv-void-4',
      sourceType: 'invoice_void',
      invoice: { net: 100_000n, vat: 20_000n, gross: 120_000n },
      chartOfAccounts: {
        ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput,
        refundsPayable: COA.refundsPayable,
      },
      receivedPence: 50_000n,
    });
    expect(r.lines.find(l => l.accountId === COA.ar.id)?.creditPence).toBe(70_000n);
    expect(r.lines.find(l => l.accountId === COA.refundsPayable.id)?.creditPence).toBe(50_000n);
    expect(r.sumDebits).toBe(r.sumCredits);
    expect(r.sumCredits).toBe(120_000n);
  });

  it('refuses a reversal that claims more money than the invoice is worth', () => {
    expect(() =>
      postReversalJournal({
        sourceId: 'inv-void-5',
        sourceType: 'invoice_void',
        invoice: { net: 100_000n, vat: 20_000n, gross: 120_000n },
        chartOfAccounts: {
          ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput,
          refundsPayable: COA.refundsPayable,
        },
        receivedPence: 120_001n,
      }),
    ).toThrow(/received/i);
  });

  it('refuses to reverse a paid invoice when there is no Refunds Payable account', () => {
    // Silently crediting Trade Debtors instead would leave the ledger wrong
    // and nothing would say so. The posting has to stop.
    expect(() =>
      postReversalJournal({
        sourceId: 'inv-void-6',
        sourceType: 'invoice_void',
        invoice: { net: 100_000n, vat: 20_000n, gross: 120_000n },
        chartOfAccounts: {
          ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput,
        },
        receivedPence: 120_000n,
      }),
    ).toThrow(/2120/);
  });
});

describe('postBankFeeJournal (provider-fee categorisation)', () => {
  it('posts Dr Bank Charges / Cr AR for categorised bank fees', () => {
    const input: BankFeeForPosting = {
      bankTxId: 'bank-tx-fee-1',
      feeAmount: 160n,
      bankChargesAccountId: COA.bankCharges.id,
      arAccountId: COA.ar.id,
    };
    const r = postBankFeeJournal(input);
    expect(r.lines.find(l => l.accountId === COA.bankCharges.id)?.debitPence).toBe(160n);
    expect(r.lines.find(l => l.accountId === COA.ar.id)?.creditPence).toBe(160n);
    expect(r.sourceType).toBe('bank_fee');
    // The journal is keyed on the BANK TRANSACTION, not on a payment — a bank
    // charge is not a customer receipt, so there is no payment row behind it.
    expect(r.sourceId).toBe('bank-tx-fee-1');
    expect(r.lines.every(l => l.sourceBankTransactionId === 'bank-tx-fee-1')).toBe(true);
  });
});

describe('every rule produces a balanced entry', () => {
  it('rule #1: invoice', () => {
    const r = postInvoiceJournal({
      invoiceId: 'x', net: 99_999n, vat: 19_999n, gross: 119_998n,
      chartOfAccounts: { ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput },
    });
    expect(r.sumDebits).toBe(r.sumCredits);
  });
  it('rule #2: payment', () => {
    const r = postPaymentJournal({
      paymentId: 'y', gross: 1234n, bankAccountGlId: COA.bankGl.id, arAccountId: COA.ar.id,
    });
    expect(r.sumDebits).toBe(r.sumCredits);
  });
  it('rule #5: VAT submission', () => {
    const r = postVatSubmissionJournal({
      submissionId: 'z', vatAmount: 100n, vatOutputAccountId: COA.vatOutput.id, vatPayableAccountId: COA.vatPayable.id,
    });
    expect(r.sumDebits).toBe(r.sumCredits);
  });
  it('rule #6: VAT payment', () => {
    const r = postVatPaymentJournal({
      bankTxId: 'w', amount: 100n, vatPayableAccountId: COA.vatPayable.id, bankGlAccountId: COA.bankGl.id,
    });
    expect(r.sumDebits).toBe(r.sumCredits);
  });
  it('reversal', () => {
    const r = postReversalJournal({
      sourceId: 'q', sourceType: 'invoice_void',
      invoice: { net: 50n, vat: 10n, gross: 60n },
      chartOfAccounts: { ar: COA.ar, revenue: COA.revenue, vatOutput: COA.vatOutput },
    });
    expect(r.sumDebits).toBe(r.sumCredits);
  });
  it('bank fee', () => {
    const r = postBankFeeJournal({
      bankTxId: 'r', feeAmount: 5n, bankChargesAccountId: COA.bankCharges.id, arAccountId: COA.ar.id,
    });
    expect(r.sumDebits).toBe(r.sumCredits);
  });
});
