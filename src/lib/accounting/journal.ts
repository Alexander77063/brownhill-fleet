// src/lib/accounting/journal.ts
// Pure-function generators for every GL posting the Brownhill Fleet hosted
// accounting module emits. Each function returns the *shape* of the journal
// entry (the rows that should be written); the DB write happens in
// `journal-bridge.ts` in a single transaction with the audit log entry.
//
// All amounts are in pence (bigint) — never floats. All functions are pure:
// they don't read the DB or call any side-effecting API. Tests can assert
// the shapes without mocks.

export type Pounds = bigint;

export interface JournalLine {
  accountId: string;
  debitPence: Pounds;
  creditPence: Pounds;
  sourceInvoiceId?: string;
  sourcePaymentId?: string;
  sourceBankTransactionId?: string;
}

export interface PostResult {
  lines: JournalLine[];
  sumDebits: Pounds;
  sumCredits: Pounds;
  sourceType:
    | 'invoice'
    | 'payment'
    | 'vat_submission'
    | 'bank_transaction'
    | 'bank_receipt'
    | 'bank_fee'
    | 'invoice_void'
    | 'credit_note';
  sourceId: string;
}

function sum(arr: Pounds[]): Pounds {
  let acc = 0n;
  for (const v of arr) acc += v;
  return acc;
}

function assertBalanced(r: PostResult): PostResult {
  if (r.sumDebits !== r.sumCredits) {
    throw new Error(`Imbalanced journal entry: debits=${r.sumDebits} credits=${r.sumCredits}`);
  }
  return r;
}

// ── Rule #1: invoice issued ────────────────────────────────────────────────
// Dr Trade Debtors (gross) / Cr Revenue (net) / Cr VAT Output (vat)

export interface InvoiceForPosting {
  invoiceId: string;
  net: Pounds;
  vat: Pounds;
  gross: Pounds;
  chartOfAccounts: { ar: { id: string }; revenue: { id: string }; vatOutput: { id: string } };
}

export function postInvoiceJournal(input: InvoiceForPosting): PostResult {
  const { ar, revenue, vatOutput } = input.chartOfAccounts;
  const lines: JournalLine[] = [
    { accountId: ar.id,       debitPence: input.gross, creditPence: 0n,     sourceInvoiceId: input.invoiceId },
    { accountId: revenue.id,  debitPence: 0n,        creditPence: input.net, sourceInvoiceId: input.invoiceId },
    { accountId: vatOutput.id, debitPence: 0n,       creditPence: input.vat, sourceInvoiceId: input.invoiceId },
  ];
  return assertBalanced({
    lines,
    sumDebits: sum(lines.map(l => l.debitPence)),
    sumCredits: sum(lines.map(l => l.creditPence)),
    sourceType: 'invoice',
    sourceId: input.invoiceId,
  });
}

// ── Rule #2: payment confirmed ────────────────────────────────────────────
// Dr Bank (the bank_account's GL account) / Cr Trade Debtors (gross)

export interface PaymentForPosting {
  paymentId: string;
  gross: Pounds;
  bankAccountGlId: string;
  arAccountId: string;
}

export function postPaymentJournal(input: PaymentForPosting): PostResult {
  const lines: JournalLine[] = [
    { accountId: input.bankAccountGlId, debitPence: input.gross, creditPence: 0n,    sourcePaymentId: input.paymentId },
    { accountId: input.arAccountId,     debitPence: 0n,        creditPence: input.gross, sourcePaymentId: input.paymentId },
  ];
  return assertBalanced({
    lines,
    sumDebits: sum(lines.map(l => l.debitPence)),
    sumCredits: sum(lines.map(l => l.creditPence)),
    sourceType: 'payment',
    sourceId: input.paymentId,
  });
}

// ── Rule #5: VAT return submission to HMRC ─────────────────────────────────
// Dr VAT Output (vat for the period) / Cr VAT Payable to HMRC (same)

export interface VatSubmissionForPosting {
  submissionId: string;
  vatAmount: Pounds;
  vatOutputAccountId: string;
  vatPayableAccountId: string;
}

export function postVatSubmissionJournal(input: VatSubmissionForPosting): PostResult {
  // A net VAT position below zero is a REIMBURSEMENT: the mirror image of a
  // payment. The original code posted a negative amount, which
  // `journal_lines`' `check (debit_pence >= 0)` rejected, so every VAT
  // reclaim — exactly the case a fleet operator hits after a bad quarter —
  // failed to post.
  const reclaim = input.vatAmount < 0n;
  const amount = reclaim ? -input.vatAmount : input.vatAmount;
  if (amount === 0n) {
    throw new Error('Nothing to post: the VAT position for this period is zero.');
  }
  const lines: JournalLine[] = reclaim
    ? [
        { accountId: input.vatPayableAccountId,  debitPence: amount, creditPence: 0n },
        { accountId: input.vatOutputAccountId,   debitPence: 0n,     creditPence: amount },
      ]
    : [
        { accountId: input.vatOutputAccountId,   debitPence: amount, creditPence: 0n },
        { accountId: input.vatPayableAccountId,  debitPence: 0n,     creditPence: amount },
      ];
  return assertBalanced({
    lines,
    sumDebits: sum(lines.map(l => l.debitPence)),
    sumCredits: sum(lines.map(l => l.creditPence)),
    sourceType: 'vat_submission',
    sourceId: input.submissionId,
  });
}

// ── Rule #6: operator marks a bank tx as VAT payment ───────────────────────
// Dr VAT Payable / Cr Bank (the bank_account's GL account)

export interface BankVatPaymentForPosting {
  bankTxId: string;
  amount: Pounds;
  vatPayableAccountId: string;
  bankGlAccountId: string;
}

export function postVatPaymentJournal(input: BankVatPaymentForPosting): PostResult {
  const lines: JournalLine[] = [
    { accountId: input.vatPayableAccountId, debitPence: input.amount, creditPence: 0n,     sourceBankTransactionId: input.bankTxId },
    { accountId: input.bankGlAccountId,     debitPence: 0n,          creditPence: input.amount, sourceBankTransactionId: input.bankTxId },
  ];
  return assertBalanced({
    lines,
    sumDebits: sum(lines.map(l => l.debitPence)),
    sumCredits: sum(lines.map(l => l.creditPence)),
    sourceType: 'bank_transaction',
    sourceId: input.bankTxId,
  });
}

// ── Reversals (void + credit note) ─────────────────────────────────────────
//
// The mirror of Rule #1 — with ONE exception, and the exception is forced by
// arithmetic rather than chosen.
//
// WHY THE CREDIT SIDE IS SPLIT
// -----------------------------
// The invoice DEBITED Trade Debtors (1100) for the gross.
//
// If nothing has been received, that debt is still there, and the reversal
// credits the account by the whole gross: the debt is cancelled, and the
// account is back where it was. Correct.
//
// If the money HAS been received, the payment posting CREDITED Trade Debtors
// for the same gross — so the account is already back at zero. A reversal
// that credited it again would leave the account at MINUS the gross: a
// negative asset, which is not a thing that can be true. What IS true is
// that the operator is holding money that belongs to the customer. That is a
// liability, and the chart of accounts has one: 2120 Refunds Payable.
//
// So the credit side of a void is SPLIT:
//   * the part still owed  → Cr Trade Debtors (1100)
//   * the part already got → Cr Refunds Payable (2120)
// and the two always add up to the gross.
//
// A part-paid invoice gets both lines. A paid invoice gets only the refund.
// An unpaid invoice gets only the debtors.
//
// The alternative — mirroring Rule #1 blindly and leaving the paid case to
// sort itself out — puts a negative receivable in the trial balance and calls
// it a day. The split is the version that is arithmetically true.

export interface ReversalForPosting {
  sourceId: string;
  sourceType: 'invoice_void' | 'credit_note';
  invoice: { net: Pounds; vat: Pounds; gross: Pounds };
  chartOfAccounts: {
    ar: { id: string };
    revenue: { id: string };
    vatOutput: { id: string };
    /**
     * 2120 Refunds Payable.
     *
     * Required whenever `receivedPence` is above zero: without it there is
     * no account to carry the refund, and quietly crediting Trade Debtors
     * instead would leave the ledger wrong with nothing saying so. So the
     * posting stops instead.
     */
    refundsPayable?: { id: string };
  };
  /**
   * How much of the invoice has been received and allocated to it.
   *
   * Defaults to zero — an invoice nothing has been paid against.
   */
  receivedPence?: Pounds;
}

export function postReversalJournal(input: ReversalForPosting): PostResult {
  const { ar, revenue, vatOutput } = input.chartOfAccounts;
  const received = input.receivedPence ?? 0n;

  if (received < 0n) {
    throw new Error('Cannot reverse an invoice: the amount received cannot be negative.');
  }
  if (received > input.invoice.gross) {
    throw new Error(
      `Cannot reverse an invoice worth ${input.invoice.gross}p: ${received}p has been received, ` +
        'which is more than the invoice is worth.',
    );
  }

  const stillOwed = input.invoice.gross - received;
  const lines: JournalLine[] = [];

  // The part still owed: the debt is cancelled.
  //
  // A zero line is not written at all. `journal_lines` carries
  //   check ((debit_pence > 0) <> (credit_pence > 0))
  // so a line that is zero on BOTH sides is not an empty line — it is an
  // ILLEGAL one, and the bridge drops zero lines for that reason.
  if (stillOwed > 0n) {
    lines.push({
      accountId: ar.id,
      debitPence: 0n,
      creditPence: stillOwed,
      sourceInvoiceId: input.sourceId,
    });
  }

  // The part already received: money the operator still owes back.
  if (received > 0n) {
    const refunds = input.chartOfAccounts.refundsPayable;
    if (!refunds) {
      throw new Error(
        'Chart of accounts: no account with code 2120 (Refunds Payable). ' +
          'A paid invoice cannot be voided without an account to carry the refund.',
      );
    }
    lines.push({
      accountId: refunds.id,
      debitPence: 0n,
      creditPence: received,
      sourceInvoiceId: input.sourceId,
    });
  }

  // The revenue and the VAT are reversed in full either way: the invoice was
  // issued for that money and it is not being charged for.
  lines.push({
    accountId: revenue.id,
    debitPence: input.invoice.net,
    creditPence: 0n,
    sourceInvoiceId: input.sourceId,
  });
  lines.push({
    accountId: vatOutput.id,
    debitPence: input.invoice.vat,
    creditPence: 0n,
    sourceInvoiceId: input.sourceId,
  });

  return assertBalanced({
    lines,
    sumDebits: sum(lines.map(l => l.debitPence)),
    sumCredits: sum(lines.map(l => l.creditPence)),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
  });
}

// ── Payment-provider-fee categorisation ────────────────────────────────────
// Dr Bank Charges (5910) / Cr Trade Debtors (1100) for the fee amount.
//
// The source is the BANK TRANSACTION, not a payment. The previous version
// built a synthetic id — `bank-fee-<uuid>` — and used it as both the journal
// source id and the source of `journal_lines.source_payment_id`. That string
// is not a uuid, and `accounting.journal_entries.source_id` is a uuid column,
// so every bank-fee posting died with 22P02 (invalid input syntax for type
// uuid) before it ever reached the ledger.

export interface BankFeeForPosting {
  bankTxId: string;
  feeAmount: Pounds;
  bankChargesAccountId: string;
  arAccountId: string;
}

export function postBankFeeJournal(input: BankFeeForPosting): PostResult {
  const lines: JournalLine[] = [
    { accountId: input.bankChargesAccountId, debitPence: input.feeAmount, creditPence: 0n,     sourceBankTransactionId: input.bankTxId },
    { accountId: input.arAccountId,          debitPence: 0n,           creditPence: input.feeAmount, sourceBankTransactionId: input.bankTxId },
  ];
  return assertBalanced({
    lines,
    sumDebits: sum(lines.map(l => l.debitPence)),
    sumCredits: sum(lines.map(l => l.creditPence)),
    sourceType: 'bank_fee',
    sourceId: input.bankTxId,
  });
}

// ── Bank receipt (auto-matched to an invoice) ───────────────────────────────
// Dr Bank (the bank account's GL account) / Cr Trade Debtors (gross).
//
// Same shape as the payment posting, but the source is the bank transaction
// that the CSV importer matched to an invoice — there is no `public.payments`
// row behind it. Posting it as a `payment` put a bank-transaction id into
// `journal_lines.source_payment_id` and left the bank transaction with no
// pointer to the journal entry it produced.
//
// 'bank_receipt' is its own source type because the journal idempotency key
// is (tenant_id, source_type, source_id) and one bank transaction can also
// carry a VAT-payment or bank-fee posting.

export interface BankReceiptForPosting {
  bankTxId: string;
  gross: Pounds;
  bankAccountGlId: string;
  arAccountId: string;
}

export function postBankReceiptJournal(input: BankReceiptForPosting): PostResult {
  const lines: JournalLine[] = [
    { accountId: input.bankAccountGlId, debitPence: input.gross, creditPence: 0n,    sourceBankTransactionId: input.bankTxId },
    { accountId: input.arAccountId,     debitPence: 0n,        creditPence: input.gross, sourceBankTransactionId: input.bankTxId },
  ];
  return assertBalanced({
    lines,
    sumDebits: sum(lines.map(l => l.debitPence)),
    sumCredits: sum(lines.map(l => l.creditPence)),
    sourceType: 'bank_receipt',
    sourceId: input.bankTxId,
  });
}
