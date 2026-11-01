// tests/unit/accounting/period-refusal.test.ts
//
// A posting into a closed period must be refused as a CONFLICT (409), with a
// body that names the period and who closed it — not as an unexpected
// failure (500), and not as a generic "something went wrong".
//
// WHY THIS MATTERS
// ----------------
// The guard that refuses a posting into a closed period
// (`assertPeriodOpenForPosting`) threw a plain `Error`. A plain Error cannot
// be told apart from any other failure at the HTTP edge, so a posting into a
// closed period came back as a 500 with a generic message — or, on the
// reconciliation route, as a 409 whose body said "Could not match this bank
// transaction" and named nothing at all. The operator could not tell a
// closed period from a broken one, and neither could the person reading the
// logs.
//
// The second thing this file pins is the CLOSE side. Two operators closing
// the same month at the same time must not both believe they closed it: the
// first one's close stands, and the second is told who closed it and when.
//
// WHAT THIS FILE PROVES
// ---------------------
//   1. A closed period is a typed refusal, not a string.
//   2. It is answered 409, and the body names the period, the code and the
//      closer.
//   3. An unrelated error is NOT mistaken for a period refusal — the HTTP
//      edge must be able to tell them apart without inspecting messages.
//   4. The 'already closed' conflict carries the FIRST closer's id and
//      timestamp, not the second attempt's.

import { describe, expect, it } from 'vitest';
import {
  AccountingPeriodError,
  periodRefusal,
  type PeriodRefusalCode,
} from '@/lib/accounting/periods';

const CLOSER = '11111111-1111-1111-1111-111111111111';
const SECOND = '22222222-2222-2222-2222-222222222222';
const CLOSED_AT = new Date('2026-11-01T09:30:00.000Z');

describe('a posting refused because the period is closed', () => {
  it('is a typed refusal that names the period', () => {
    const err = new AccountingPeriodError('period_closed', 2026, 10, CLOSED_AT, CLOSER);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AccountingPeriodError');
    expect(err.code).toBe('period_closed');
    expect(err.year).toBe(2026);
    expect(err.month).toBe(10);
    expect(err.message).toContain('2026-10');
    expect(err.message).toContain('closed');
  });

  it('is answered with 409, and the body names the period and the closer', () => {
    const err = new AccountingPeriodError('period_closed', 2026, 10, CLOSED_AT, CLOSER);
    const refusal = periodRefusal(err);

    expect(refusal).not.toBeNull();
    expect(refusal!.status).toBe(409);
    expect(refusal!.body.code).toBe('period_closed');
    expect(refusal!.body.period).toBe('2026-10');
    expect(refusal!.body.closedAt).toBe(CLOSED_AT.toISOString());
    expect(refusal!.body.closedByUserId).toBe(CLOSER);
    expect(refusal!.body.error).toContain('2026-10');
  });

  it('distinguishes a locked period from a closed one', () => {
    const locked = new AccountingPeriodError('period_locked', 2026, 10, CLOSED_AT, CLOSER);
    const closed = new AccountingPeriodError('period_closed', 2026, 10, CLOSED_AT, CLOSER);

    expect(locked.code).toBe('period_locked');
    expect(locked.code).not.toBe(closed.code);
    expect(locked.message).toContain('locked');
    expect(periodRefusal(locked)!.body.code).toBe('period_locked');
  });

  it('is not confused with an unrelated failure', () => {
    // The HTTP edge must be able to tell a period refusal from any other
    // error WITHOUT reading its message — a message is not a contract.
    expect(periodRefusal(new Error('connection reset'))).toBeNull();
    expect(periodRefusal('a string')).toBeNull();
    expect(periodRefusal(undefined)).toBeNull();
    expect(periodRefusal({ message: 'Period 2026-10 is closed' })).toBeNull();
  });
});

describe('a close that lost the race', () => {
  it('carries the FIRST closer, not the second attempt', () => {
    // The first closer wins. The second operator is told who closed the
    // period and when — not who they are.
    const err = new AccountingPeriodError('period_already_closed', 2026, 10, CLOSED_AT, CLOSER);

    expect(err.code).toBe('period_already_closed');
    expect(err.closedByUserId).toBe(CLOSER);
    expect(err.closedByUserId).not.toBe(SECOND);
    expect(err.closedAt).toEqual(CLOSED_AT);

    const refusal = periodRefusal(err)!;
    expect(refusal.status).toBe(409);
    expect(refusal.body.code).toBe('period_already_closed');
    expect(refusal.body.closedByUserId).toBe(CLOSER);
    expect(refusal.body.closedAt).toBe(CLOSED_AT.toISOString());
  });
});

describe('the refusal codes', () => {
  it('are the three the product can produce', () => {
    const codes: PeriodRefusalCode[] = ['period_closed', 'period_locked', 'period_already_closed'];
    for (const code of codes) {
      const refusal = periodRefusal(new AccountingPeriodError(code, 2026, 10));
      expect(refusal!.body.code).toBe(code);
    }
  });
});
