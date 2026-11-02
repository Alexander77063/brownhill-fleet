// src/lib/accounting/bank-rec.ts
// CSV/OFX parsing + auto-match for the four UK bank formats v1 supports.
// Per spec §4 default 7: Barclays / HSBC / Starling / Lloyds.
//
// Each bank parser is a separate function that takes the raw CSV text and
// returns a uniform `ParsedStatement` shape. The auto-matcher then scores
// each parsed transaction against the open payments in the DB and suggests
// matches above the 90% confidence threshold.

export type Pounds = bigint;

export type BankFormat = 'barclays' | 'hsbc' | 'starling' | 'lloyds' | 'unknown';

export interface ParsedTransaction {
  postedAt: Date;
  amountPence: Pounds;        // signed: debits negative for outflows
  description: string;
  counterparty: string | null;
}

export interface ParsedStatement {
  format: BankFormat;
  transactions: ParsedTransaction[];
  rawHash: string;            // sha-256 hex of the input bytes
}

// ── Format detection ────────────────────────────────────────────────────────

export function detectFormat(headerLine: string): BankFormat {
  const h = headerLine.toLowerCase();
  // Barclays' standard export: "Date,Type,Description,Value,Balance,Account Name,Account Number"
  // — the amount column is named "Value" (not "Amount") and the unique markers
  // are the "Account Name" + "Account Number" pair.
  if (h.includes('barclays') || (h.includes('value') && h.includes('account name') && h.includes('account number'))) {
    return 'barclays';
  }
  // HSBC: 4-column "Date,Description,Amount,Balance,Account" — Date, Description,
  // Amount, Balance all present in that order is the unique signature.
  if (h.includes('hsbc') || (h.startsWith('date,description,amount') && h.includes('balance') && h.includes('account'))) {
    return 'hsbc';
  }
  // Starling: 7-column with "Counterparty" and "Reference" columns (no other UK
  // bank exports carry Counterparty).
  if (h.includes('starling') || (h.includes('counterparty') && h.includes('reference') && h.includes('amount'))) {
    return 'starling';
  }
  // Lloyds: starts with "Transaction Date" (distinctive — others just say "Date").
  if (h.includes('lloyds') || (h.includes('transaction date') && h.includes('type') && h.includes('amount'))) {
    return 'lloyds';
  }
  return 'unknown';
}

// ── Per-bank parsers ────────────────────────────────────────────────────────
// Each parses the CSV text into the uniform ParsedStatement shape. Errors
// throw with a row number in the message so the operator can fix the file
// or skip the row.

function parseAmount(s: string): Pounds {
  // Accept £1,234.56 / -1,234.56 / 1234.56 etc.
  const cleaned = s.replace(/[£,\s]/g, '').trim();
  if (!cleaned) throw new Error('empty amount field');
  const sign = cleaned.startsWith('-') ? -1n : 1n;
  const positive = cleaned.replace(/^-/, '');
  const [intPart, decPart = ''] = positive.split('.');
  if (!/^\d{1,12}(?:\.\d{0,2})?$/.test(intPart + (decPart ? '.' + decPart : ''))) {
    throw new Error(`amount not numeric: ${s}`);
  }
  const pence = BigInt(intPart) * 100n + BigInt((decPart + '00').slice(0, 2));
  return sign * pence;
}

function parseDate(s: string): Date {
  // Accept DD/MM/YYYY or YYYY-MM-DD — UK banks vary.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00Z');
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`);
  throw new Error(`date not parseable: ${s}`);
}

async function sha256Hex(input: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// Split a CSV line respecting double-quoted fields. Tiny parser — good enough
// for the four formats we support; not a general CSV parser.
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQuote = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

export async function parseBankCsv(csv: string): Promise<ParsedStatement> {
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (!lines.length) throw new Error('CSV is empty');
  const format = detectFormat(lines[0]);
  if (format === 'unknown') throw new Error('Unrecognised bank format (no header marker matched)');

  const transactions: ParsedTransaction[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    try {
      transactions.push(parseRow(format, cells));
    } catch (e) {
      throw new Error(`row ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { format, transactions, rawHash: await sha256Hex(csv) };
}

function parseRow(format: BankFormat, cells: string[]): ParsedTransaction {
  // Each format's column order is documented inline. The columns we care
  // about are date / amount / description / counterparty.
  switch (format) {
    case 'barclays':
      // Date, Type, Description, Value, Balance, Account Name, Account Number
      return {
        postedAt: parseDate(cells[0]),
        amountPence: parseAmount(cells[3]),
        description: cells[2] ?? '',
        counterparty: cells[2] ?? null,
      };
    case 'hsbc':
      // Date, Description, Amount, Balance, Account
      return {
        postedAt: parseDate(cells[0]),
        amountPence: parseAmount(cells[2]),
        description: cells[1] ?? '',
        counterparty: cells[1] ?? null,
      };
    case 'starling':
      // Date, Type, Counterparty, Reference, Amount, Balance, Account
      return {
        postedAt: parseDate(cells[0]),
        amountPence: parseAmount(cells[4]),
        description: cells[2] ?? '',
        counterparty: cells[2] ?? null,
      };
    case 'lloyds':
      // Transaction Date, Type, Description, Amount, Balance, Account Name
      return {
        postedAt: parseDate(cells[0]),
        amountPence: parseAmount(cells[3]),
        description: cells[2] ?? '',
        counterparty: cells[2] ?? null,
      };
  }
  // Unreachable: detectFormat() guarantees `format` is never 'unknown' by the
  // time we reach here. The throw is a runtime safety net if that invariant
  // ever breaks (e.g. someone calls parseRow directly with a sentinel).
  throw new Error(`parseRow: unhandled format ${format}`);
}

// ── Auto-matcher ────────────────────────────────────────────────────────────
// Score a bank transaction against an open payment; return 0.0-1.0 confidence.
// ≥ 0.9 = auto-match (per spec §8 default 6); < 0.9 = queue for manual.

export interface MatchCandidate {
  paymentId: string;
  grossPence: Pounds;
  invoiceNo: string;
  issuedAt: Date;
}

/**
 * The issue date of an invoice, as the scorer needs it.
 *
 * `public.invoices.issued_on` is a `date` column, and postgres.js hands a raw
 * `date` back as a JavaScript Date. That value cannot be concatenated with
 * 'T00:00:00Z': `+` with a string on the right coerces the Date through
 * `toString()`, giving
 *
 *     "Sun Nov 01 2026 00:00:00 GMT+0000 (Greenwich Mean Time)T00:00:00Z"
 *
 * which is not a date at all. `new Date(...)` of it is an Invalid Date, the
 * days between the receipt and the invoice become NaN, and the 30-day window
 * in scoreMatch never fires.
 *
 * So the day is read here, from whichever shape the driver handed over: a
 * day string ('YYYY-MM-DD') or the Date it parses a `date` column into.
 */
export function issuedAtFromDbValue(value: string | Date): Date {
  if (value instanceof Date) {
    // A `date` column parses as UTC midnight, so the UTC calendar day is the
    // day the invoice was issued.
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  return new Date(`${value}T00:00:00Z`);
}

export function scoreMatch(bankTx: ParsedTransaction, payment: MatchCandidate): number {
  let s = 0;
  if (bankTx.amountPence === payment.grossPence) s += 0.5;
  const descLower = bankTx.description.toLowerCase();
  const invLower = payment.invoiceNo.toLowerCase();
  if (invLower.length > 0 && descLower.includes(invLower)) s += 0.4;
  // Date window: 30 days after invoice issue.
  const daysAfter = (bankTx.postedAt.getTime() - payment.issuedAt.getTime()) / (24 * 3600 * 1000);
  if (daysAfter >= 0 && daysAfter <= 30) s += 0.1;
  return s;
}

/**
 * Convenience: returns the best match candidate above threshold, or null.
 *
 * The candidate it returns carries the score it was matched at. The importer
 * shows that number beside every auto-matched line, and the score is the only
 * thing that tells the operator how sure the match was — so the score has to
 * be the real one, not the threshold. Every accepted line clears the threshold
 * by definition, so reporting the threshold reports the same number for every
 * line on the statement and says nothing at all.
 */
export function bestMatch(
  bankTx: ParsedTransaction,
  candidates: MatchCandidate[],
  threshold = 0.9,
): (MatchCandidate & { score: number }) | null {
  let best: { c: MatchCandidate; s: number } | null = null;
  for (const c of candidates) {
    const s = scoreMatch(bankTx, c);
    if (s >= threshold && (!best || s > best.s)) best = { c, s };
  }
  return best ? { ...best.c, score: best.s } : null;
}
