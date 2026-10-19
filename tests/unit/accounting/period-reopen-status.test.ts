// tests/unit/accounting/period-reopen-status.test.ts
// Pure-function tests for the reopen-window rule. The /admin/accounting/periods
// and /accounts/accounting/periods pages both render a "Reopen" button when
// this returns 'open'. Keeping it pure lets us assert the 7-day window edge
// cases without touching the DB.

import { describe, expect, it } from 'vitest';
import { reopenStatus, reopenDeadline, REOPEN_WINDOW_DAYS } from '@/lib/accounting/periods';

const NOW = new Date('2026-09-15T12:00:00Z');
const ONE_DAY = 24 * 3600 * 1000;

describe('reopenStatus', () => {
  it('returns "open" when closed 30 minutes ago', () => {
    const closedAt = new Date(NOW.getTime() - 30 * 60 * 1000);
    expect(reopenStatus(closedAt, null, NOW)).toBe('open');
  });

  it('returns "open" at the 7-day boundary minus one second', () => {
    const closedAt = new Date(NOW.getTime() - (REOPEN_WINDOW_DAYS * ONE_DAY) + 1000);
    expect(reopenStatus(closedAt, null, NOW)).toBe('open');
  });

  it('returns "elapsed" once the 7-day window has fully run out', () => {
    const closedAt = new Date(NOW.getTime() - (REOPEN_WINDOW_DAYS * ONE_DAY) - 1);
    expect(reopenStatus(closedAt, null, NOW)).toBe('elapsed');
  });

  it('returns "locked" if the period was locked, even within the window', () => {
    const closedAt = new Date(NOW.getTime() - ONE_DAY);
    const lockedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    expect(reopenStatus(closedAt, lockedAt, NOW)).toBe('locked');
  });

  it('returns "no_close" when the period has never been closed', () => {
    expect(reopenStatus(null, null, NOW)).toBe('no_close');
  });

  it('returns "no_close" when locked but never closed (orphan lock, defensive)', () => {
    const lockedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    expect(reopenStatus(null, lockedAt, NOW)).toBe('no_close');
  });
});

describe('reopenDeadline', () => {
  it('returns closedAt + REOPEN_WINDOW_DAYS days', () => {
    const closedAt = new Date('2026-09-01T00:00:00Z');
    const expected = new Date(closedAt.getTime() + REOPEN_WINDOW_DAYS * ONE_DAY);
    expect(reopenDeadline(closedAt)?.toISOString()).toBe(expected.toISOString());
  });

  it('returns null when closedAt is null', () => {
    expect(reopenDeadline(null)).toBeNull();
  });
});