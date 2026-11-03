// tests/unit/accounting/bank-rec-date-window.test.ts
//
// The auto-matcher's 30-day date window.
//
// WHY THIS FILE EXISTS
// --------------------
// scoreMatch awards 0.1 to a receipt that arrives within 30 days of the
// invoice being issued. That term was dead in production: the importer built
// the issue date by concatenating, and the value it concatenated was a
// JavaScript Date rather than a day string.
//
//     new Date(c.issued_on + 'T00:00:00Z')
//
// `+` with a string on the right coerces the Date through toString(), so the
// result was "Sun Nov 01 2026 00:00:00 GMT+0000 (Greenwich Mean Time)T00:00:00Z"
// — not a date. `new Date(...)` of that is an Invalid Date, `daysAfter` was
// NaN, and `daysAfter >= 0 && daysAfter <= 30` never fired.
//
// The unit tests missed it because their fixtures were already strings, so
// they exercised a path the database has never produced. These fixtures use
// the value postgres.js actually hands over for a `date` column: a Date.

import { describe, expect, it } from 'vitest';
import * as bankRec from '@/lib/accounting/bank-rec';
import { scoreMatch, type MatchCandidate, type ParsedTransaction } from '@/lib/accounting/bank-rec';

/**
 * What postgres.js returns for `public.invoices.issued_on`, a `date` column:
 * a JavaScript Date at UTC midnight of the day the invoice was issued.
 */
const RAW_ISSUED_ON = new Date('2026-10-01T00:00:00.000Z');

const ISSUED_ON = '2026-10-01';

function receipt(daysAfterIssue: number): ParsedTransaction {
  const postedAt = new Date(RAW_ISSUED_ON.getTime() + daysAfterIssue * 24 * 3600 * 1000);
  return {
    postedAt,
    amountPence: 12000n,
    description: 'payment for INV-001',
    counterparty: 'INV-001',
  };
}

function candidate(issuedAt: Date): MatchCandidate {
  return {
    paymentId: 'inv-1',
    grossPence: 12000n,
    invoiceNo: 'INV-001',
    issuedAt,
  };
}

/**
 * The issue date, read from whatever the driver handed over.
 *
 * A namespace import on purpose: a missing export is `undefined` here, so
 * the test fails with a plain assertion rather than a module-resolution
 * error, and the failure says what is missing.
 */
function issuedAtFromDbValue(value: string | Date): Date {
  const fn = (
    bankRec as unknown as {
      issuedAtFromDbValue?: (value: string | Date) => Date;
    }
  ).issuedAtFromDbValue;
  expect(typeof fn, 'bank-rec.ts has no way to read an issue date out of a driver Date').toBe('function');
  return fn!(value);
}

describe('the invoice issue date the auto-matcher scores against', () => {
  it('reads a Date handed over by the driver as the day it names', () => {
    const issuedAt = issuedAtFromDbValue(RAW_ISSUED_ON);
    expect(Number.isNaN(issuedAt.getTime()), 'the issue date is not a date').toBe(false);
    expect(issuedAt.toISOString()).toBe(`${ISSUED_ON}T00:00:00.000Z`);
  });

  it('reads a day string the same way', () => {
    const issuedAt = issuedAtFromDbValue(ISSUED_ON);
    expect(Number.isNaN(issuedAt.getTime()), 'the issue date is not a date').toBe(false);
    expect(issuedAt.toISOString()).toBe(`${ISSUED_ON}T00:00:00.000Z`);
  });

  it('gives the 30-day window its 0.1 when the money arrived five days after issue', () => {
    const issuedAt = issuedAtFromDbValue(RAW_ISSUED_ON);
    // 0.5 exact amount + 0.4 invoice number in the description + 0.1 the
    // 30-day window.
    expect(scoreMatch(receipt(5), candidate(issuedAt))).toBeCloseTo(1.0, 5);
  });

  it('withholds the 30-day window when the money arrived fifty days after issue', () => {
    const issuedAt = issuedAtFromDbValue(RAW_ISSUED_ON);
    // The same receipt, outside the window: the date term does not apply.
    expect(scoreMatch(receipt(50), candidate(issuedAt))).toBeCloseTo(0.9, 5);
  });

  it('withholds the 30-day window when the money arrived before the invoice was issued', () => {
    const issuedAt = issuedAtFromDbValue(RAW_ISSUED_ON);
    expect(scoreMatch(receipt(-3), candidate(issuedAt))).toBeCloseTo(0.9, 5);
  });
});

describe('the concatenation the importer used to build the issue date', () => {
  it('produced no date at all', () => {
    // This is the expression the importer ran, with the value postgres.js
    // hands over for a `date` column. `+` with a string on the right coerces
    // the Date through toString(), and the result is not a date.
    //
    // It is kept here so the reason the date term was dead is written down in
    // something that runs, rather than in a comment nobody checks.
    const broken = new Date((RAW_ISSUED_ON as unknown as string) + 'T00:00:00Z');
    expect(Number.isNaN(broken.getTime())).toBe(true);
  });
});
