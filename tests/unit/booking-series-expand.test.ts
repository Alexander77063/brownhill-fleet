// tests/unit/booking-series-expand.test.ts
// Pure-function test for the recurrence rule on booking_series. The DB
// materialises each series into N rows of `bookings`; this helper tells
// the server action which dates to insert. Pinned in a unit test so the
// "weekly Mon/Wed/Fri" definition doesn't drift from "what the operator
// sees on the calendar".

import { describe, expect, it } from 'vitest';
import {
  expandSeries,
  DEFAULT_HORIZON_WEEKS,
  validateSeriesInput,
  type SeriesValidationError,
} from '@/lib/ops/booking-series';

describe('validateSeriesInput', () => {
  const ok = {
    startDate: '2026-09-01',
    endDate: null as string | null,
    daysOfWeek: [1, 3, 5] as number[],
    startTime: '08:00',
  };
  it('accepts a sensible weekly Mon/Wed/Fri series with no end date', () => {
    expect(validateSeriesInput(ok)).toBeNull();
  });
  it('rejects empty days_of_week', () => {
    const err = validateSeriesInput({ ...ok, daysOfWeek: [] });
    expect(err).toBe<SeriesValidationError>('days_empty');
  });
  it('rejects days_of_week values outside 0..6', () => {
    expect(validateSeriesInput({ ...ok, daysOfWeek: [7] })).toBe('days_invalid');
    expect(validateSeriesInput({ ...ok, daysOfWeek: [-1] })).toBe('days_invalid');
  });
  it('rejects end_date before start_date', () => {
    expect(validateSeriesInput({ ...ok, endDate: '2026-08-31' })).toBe('range_invalid');
  });
  it('accepts end_date equal to start_date', () => {
    expect(validateSeriesInput({ ...ok, endDate: '2026-09-01' })).toBeNull();
  });
  it('rejects a malformed start_time', () => {
    expect(validateSeriesInput({ ...ok, startTime: '25:99' })).toBe('time_invalid');
    expect(validateSeriesInput({ ...ok, startTime: 'not-a-time' })).toBe('time_invalid');
  });
  it('rejects a horizon_weeks below 1 or above 52', () => {
    expect(validateSeriesInput({ ...ok, horizonWeeks: 0 })).toBe('horizon_invalid');
    expect(validateSeriesInput({ ...ok, horizonWeeks: 100 })).toBe('horizon_invalid');
    expect(validateSeriesInput({ ...ok, horizonWeeks: 4 })).toBeNull();
  });
});

describe('expandSeries', () => {
  // Day-of-week map used to write these assertions:
  //   2026-09-01 = Tuesday (dow=2)
  //   2026-09-02 = Wednesday (dow=3)
  //   2026-09-03 = Thursday  (dow=4)
  //   2026-09-04 = Friday    (dow=5)
  //   2026-09-07 = Monday    (dow=1)
  //   2026-09-28 = Monday    (dow=1)
  //   2026-09-29 = Tuesday   (dow=2)
  //   2026-09-30 = Wednesday (dow=3)
  //   2026-10-02 = Friday    (dow=5)

  it('returns the matched weekday dates within the window', () => {
    const dates = expandSeries({
      startDate: '2026-09-01', // Tue
      endDate:   '2026-09-07', // Mon
      daysOfWeek: [1, 3, 5],  // Mon, Wed, Fri
    });
    expect(dates).toEqual(['2026-09-02', '2026-09-04', '2026-09-07']);
  });

  it('includes the start_date when its weekday matches', () => {
    const dates = expandSeries({
      startDate: '2026-09-02', // Wed (dow=3)
      endDate:   '2026-09-02',
      daysOfWeek: [3],
    });
    expect(dates).toEqual(['2026-09-02']);
  });

  it('returns an empty list when no weekday matches in the window', () => {
    const dates = expandSeries({
      startDate: '2026-09-01', // Tue
      endDate:   '2026-09-02', // Wed
      daysOfWeek: [0, 6],      // Sun, Sat
    });
    expect(dates).toEqual([]);
  });

  it('extends to the horizon when end_date is null', () => {
    const dates = expandSeries({
      startDate:   '2026-09-01', // Tue (dow=2)
      endDate:     null,
      daysOfWeek:  [2],          // every Tue
      horizonWeeks: 2,            // 14 days -> ends 2026-09-15 inclusive
    });
    expect(dates).toEqual(['2026-09-01', '2026-09-08', '2026-09-15']);
  });

  it('uses the default horizon of 4 weeks when no horizon is supplied', () => {
    expect(DEFAULT_HORIZON_WEEKS).toBe(4);
    const dates = expandSeries({
      startDate: '2026-09-01', // Tue (dow=2)
      endDate:   null,
      daysOfWeek: [2],         // every Tue
    });
    // Horizon = start_date + 28 days inclusive -> 2026-09-29. That window
    // contains 5 Tuesdays: 09-01, 09-08, 09-15, 09-22, 09-29. "4 weeks ahead"
    // is end-inclusive so a series created on the 1st gives bookings for
    // day 1, day 8, day 15, day 22, day 29.
    expect(dates).toEqual(['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']);
  });

  it('caps the open-ended series at the end of the horizon window', () => {
    const dates = expandSeries({
      startDate:   '2026-09-01',
      endDate:     null,
      daysOfWeek:  [3, 5],     // Wed, Fri
      horizonWeeks: 4,          // 28 days -> ends 2026-09-29 inclusive
    });
    // First match: 2026-09-02 (Wed). Last match: 2026-09-25 (Fri) — 2026-09-30 (Wed) is past end.
    expect(dates[0]).toBe('2026-09-02');
    expect(dates[dates.length - 1]).toBe('2026-09-25');
  });

  it('handles month rollover without skipping days', () => {
    const dates = expandSeries({
      startDate: '2026-09-28', // Mon (dow=1)
      endDate:   '2026-10-02', // Fri (dow=5)
      daysOfWeek: [1, 3, 5],  // Mon, Wed, Fri
    });
    // 09-28 Mon, 09-30 Wed, 10-02 Fri
    expect(dates).toEqual(['2026-09-28', '2026-09-30', '2026-10-02']);
  });

  it('de-duplicates repeated days in days_of_week', () => {
    const dates = expandSeries({
      startDate: '2026-09-01',
      endDate:   '2026-09-03',
      daysOfWeek: [2, 2, 2],   // Tuesday x3
    });
    expect(dates).toEqual(['2026-09-01']);
  });
});