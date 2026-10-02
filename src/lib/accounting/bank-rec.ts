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
  if (h.includes('barclays') || h.includes('date') && h.includes('type') && h.includes('amount')) {
    // Barclays' standard export starts with "Date,Type,Description,Value,Balance,Account Name"
    return 'barclays';
  }
  if (h.includes('hsbc')) return 'hsbc';
  if (h.includes('starling')) return 'starling';
  if (h.includes('lloyds') || h.includes('transaction date') && h.includes('type') && h.includes('amount')) return 'lloyds';
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

/** Convenience: returns the best match candidate above threshold, or null. */
export function bestMatch(
  bankTx: ParsedTransaction,
  candidates: MatchCandidate[],
  threshold = 0.9,
): MatchCandidate | null {
  let best: { c: MatchCandidate; s: number } | null = null;
  for (const c of candidates) {
    const s = scoreMatch(bankTx, c);
    if (s >= threshold && (!best || s > best.s)) best = { c, s };
  }
  return best?.c ?? null;
}
