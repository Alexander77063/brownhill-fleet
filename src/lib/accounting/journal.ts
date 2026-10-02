// src/lib/accounting/journal.ts
// Pure-function generators for every GL posting the Brownhill Fleet hosted
// accounting module emits. Each function returns the *shape* of the journal
// entry (the rows that should be written); the DB write happens in
// `journal-bridge.ts` in a single transaction with the audit log entry.
//
// Every function takes `tenantId` as the first argument — the SaaS multi-tenant
// scoping. The `PostResult` echoes the tenantId back so the bridge can persist
// it on journal_entries.

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
  sourceType: 'invoice' | 'payment' | 'vat_submission' | 'bank_transaction' | 'invoice_void' | 'credit_note';
  sourceId: string;
  tenantId: string;
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
  tenantId: string;
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
    tenantId: input.tenantId,
  });
}

// ── Rule #2: payment confirmed ────────────────────────────────────────────
// Dr Bank (the bank_account's GL account) / Cr Trade Debtors (gross)

export interface PaymentForPosting {
  tenantId: string;
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
    tenantId: input.tenantId,
  });
}

// ── Rule #5: VAT return submission to HMRC ─────────────────────────────────
// Dr VAT Output (vat for the period) / Cr VAT Payable to HMRC (same)

export interface VatSubmissionForPosting {
  tenantId: string;
  submissionId: string;
  vatAmount: Pounds;
  vatOutputAccountId: string;
  vatPayableAccountId: string;
}

export function postVatSubmissionJournal(input: VatSubmissionForPosting): PostResult {
  const lines: JournalLine[] = [
    { accountId: input.vatOutputAccountId,    debitPence: input.vatAmount, creditPence: 0n },
    { accountId: input.vatPayableAccountId,  debitPence: 0n,             creditPence: input.vatAmount },
  ];
  return assertBalanced({
    lines,
    sumDebits: sum(lines.map(l => l.debitPence)),
    sumCredits: sum(lines.map(l => l.creditPence)),
    sourceType: 'vat_submission',
    sourceId: input.submissionId,
    tenantId: input.tenantId,
  });
}

// ── Rule #6: operator marks a bank tx as VAT payment ───────────────────────
// Dr VAT Payable / Cr Bank (the bank_account's GL account)

export interface BankVatPaymentForPosting {
  tenantId: string;
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
    tenantId: input.tenantId,
  });
}

// ── Reversals (void + credit note) ─────────────────────────────────────────
// Same three lines as Rule #1, all amounts negated.

export interface ReversalForPosting {
  tenantId: string;
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
    tenantId: input.tenantId,
  });
}

// ── Payment-provider-fee categorisation ────────────────────────────────────
// Dr Bank Charges (5910) / Cr Trade Debtors (1100) for the fee amount.

export interface BankFeeForPosting {
  tenantId: string;
  paymentId: string;
  feeAmount: Pounds;
  bankChargesAccountId: string;
  arAccountId: string;
}

export function postBankFeeJournal(input: BankFeeForPosting): PostResult {
  const lines: JournalLine[] = [
    { accountId: input.bankChargesAccountId, debitPence: input.feeAmount, creditPence: 0n,     sourcePaymentId: input.paymentId },
    { accountId: input.arAccountId,          debitPence: 0n,           creditPence: input.feeAmount, sourcePaymentId: input.paymentId },
  ];
  return assertBalanced({
    lines,
    sumDebits: sum(lines.map(l => l.debitPence)),
    sumCredits: sum(lines.map(l => l.creditPence)),
    sourceType: 'bank_transaction',
    sourceId: input.paymentId,
    tenantId: input.tenantId,
  });
}
