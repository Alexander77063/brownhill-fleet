// src/lib/accounting/bank-import-summary.ts
// Pure-function summary that the bank-import pages render after a CSV commit.
//
// Given the parsed statement and the auto-matcher decisions, produce the shape
// the operator/accountant page needs: per-row status (auto_matched | unmatched),
// the matched payment id when applicable, and totals. Kept pure so the unit
// tests stay fast and don't need a database.

import type { ParsedStatement, ParsedTransaction, Pounds, BankFormat } from './bank-rec';

export interface ImportSummaryRow {
  postedAt: Date;
  amountPence: Pounds;
  description: string;
  counterparty: string | null;
  status: 'auto_matched' | 'unmatched';
  matchedPaymentId?: string;
  score?: number;
}

export interface ImportSummary {
  format: BankFormat;
  imported: number;
  autoMatched: number;
  stillUnmatched: number;
  rows: ImportSummaryRow[];
}

export function summarizeImport(
  parsed: ParsedStatement,
  matches: ReadonlyMap<number, { paymentId: string; score: number }>,
): ImportSummary {
  let autoMatched = 0;
  const rows: ImportSummaryRow[] = parsed.transactions.map((tx: ParsedTransaction, idx) => {
    const m = matches.get(idx);
    if (m) {
      autoMatched++;
      return {
        postedAt: tx.postedAt,
        amountPence: tx.amountPence,
        description: tx.description,
        counterparty: tx.counterparty,
        status: 'auto_matched',
        matchedPaymentId: m.paymentId,
        score: m.score,
      };
    }
    return {
      postedAt: tx.postedAt,
      amountPence: tx.amountPence,
      description: tx.description,
      counterparty: tx.counterparty,
      status: 'unmatched',
    };
  });
  return {
    format: parsed.format,
    imported: parsed.transactions.length,
    autoMatched,
    stillUnmatched: parsed.transactions.length - autoMatched,
    rows,
  };
}