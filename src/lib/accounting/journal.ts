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
  vatCodeId: string;
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
// Same three lines as Rule #1, all amounts negated.

export interface ReversalForPosting {
  sourceId: string;
  sourceType: 'invoice_void' | 'credit_note';
  invoice: { net: Pounds; vat: Pounds; gross: Pounds };
  chartOfAccounts: { ar: { id: string }; revenue: { id: string }; vatOutput: { id: string } };
}

export function postReversalJournal(input: ReversalForPosting): PostResult {
  const { ar, revenue, vatOutput } = input.chartOfAccounts;
  const lines: JournalLine[] = [
    { accountId: ar.id,       debitPence: 0n,        creditPence: input.invoice.gross, sourceInvoiceId: input.sourceId },
    { accountId: revenue.id,  debitPence: input.invoice.net,  creditPence: 0n,     sourceInvoiceId: input.sourceId },
    { accountId: vatOutput.id, debitPence: input.invoice.vat,  creditPence: 0n,     sourceInvoiceId: input.sourceId },
  ];
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
