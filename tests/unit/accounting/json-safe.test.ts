// tests/unit/accounting/json-safe.test.ts
//
// The wire-boundary converter for the accounting module's money.
//
// WHY THIS FILE EXISTS
// --------------------
// Every pence figure in the accounting module is a BigInt, because money is
// not a float. `JSON.stringify` — which is what `NextResponse.json` calls —
// THROWS on a BigInt:
//
//     TypeError: Do not know how to serialize a BigInt
//
// So the four report routes and the bank-import route answered 500 with that
// message, every time, for every tenant. The operator's own screens are
// server-rendered and were never broken, which is exactly why nobody noticed
// that the JSON API was dead.
//
// `jsonSafe` is the one place that conversion happens: at the edge of the
// process, on the way out. A BigInt that never leaves the process is not a
// problem; a BigInt that reaches `JSON.stringify` is.
//
// The convention it establishes: a pence figure crosses the wire as a STRING.
// That is what the void route already did (`refundPence: …toString()`), what
// the bank import's own client component expects (`amountPence: string`), and
// what a consumer that divides by 100 needs — a value it cannot round.

import { describe, expect, it } from 'vitest';
import { jsonSafe } from '@/lib/accounting/json';

describe('jsonSafe', () => {
  it('turns a BigInt into a string', () => {
    expect(jsonSafe(12_000n)).toBe('12000');
  });

  it('keeps a negative BigInt negative', () => {
    expect(jsonSafe(-5_000n)).toBe('-5000');
  });

  it('leaves a plain number alone', () => {
    expect(jsonSafe(12_000)).toBe(12_000);
  });

  it('leaves strings, booleans and null alone', () => {
    expect(jsonSafe('4000')).toBe('4000');
    expect(jsonSafe(true)).toBe(true);
    expect(jsonSafe(null)).toBeNull();
  });

  it('walks into objects', () => {
    const safe = jsonSafe({ code: '4000', amountPence: 12_000n });
    expect(safe).toEqual({ code: '4000', amountPence: '12000' });
  });

  it('walks into arrays', () => {
    const safe = jsonSafe([1n, { nested: 2n }, 'three']);
    expect(safe).toEqual(['1', { nested: '2' }, 'three']);
  });

  it('walks into a whole report', () => {
    // The shape renderProfitAndLoss returns: BigInts at the top level AND
    // inside the rows. A converter that only looked at the top level would
    // still have thrown on the rows.
    const safe = jsonSafe({
      fromDate: new Date('2026-01-01T00:00:00.000Z'),
      rows: [{ accountCode: '4000', amountPence: 250_000n }],
      totalRevenuePence: 250_000n,
      totalExpensePence: 0n,
      netResultPence: 250_000n,
    });

    expect(safe).toEqual({
      fromDate: new Date('2026-01-01T00:00:00.000Z'),
      rows: [{ accountCode: '4000', amountPence: '250000' }],
      totalRevenuePence: '250000',
      totalExpensePence: '0',
      netResultPence: '250000',
    });
  });

  it('produces something JSON.stringify accepts — that is the whole point', () => {
    const safe = jsonSafe({ amountPence: 12_000n, rows: [{ amountPence: 1n }] });
    expect(() => JSON.stringify(safe)).not.toThrow();
    expect(JSON.parse(JSON.stringify(safe))).toEqual({
      amountPence: '12000',
      rows: [{ amountPence: '1' }],
    });
  });

  it('keeps a Date as a Date, so JSON.stringify can make it an ISO string', () => {
    const date = new Date('2026-09-01T00:00:00.000Z');
    const safe = jsonSafe({ postedAt: date });
    expect((safe as { postedAt: Date }).postedAt).toBeInstanceOf(Date);
    expect(JSON.parse(JSON.stringify(safe)).postedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('does not mutate the value it was given', () => {
    const original = { amountPence: 12_000n };
    jsonSafe(original);
    expect(original.amountPence).toBe(12_000n);
  });

  it('survives a null-prototype object', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.amountPence = 1n;
    expect(jsonSafe(bare)).toEqual({ amountPence: '1' });
  });
});
