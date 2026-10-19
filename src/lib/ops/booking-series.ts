// src/lib/ops/booking-series.ts
// Pure-function helpers for the booking_series recurrence rule. Lives
// outside any DB-touching code so unit tests can pin the date-expansion
// logic without a Postgres connection.
//
// The materialisation strategy is "expand then insert": when ops creates or
// refreshes a series, the server action calls `expandSeries` and inserts
// one `bookings` row per matching date in the window. The booking rows
// then flow through the same status / assignment / dispatch path as
// one-off bookings. To stop a series, ops sets status='paused' or
// 'cancelled'; the action can also delete the unstarted bookings.

/** Days of week: 0=Sunday, 1=Monday, ..., 6=Saturday — matches Postgres EXTRACT(dow). */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const DAYS_OF_WEEK: ReadonlyArray<DayOfWeek> = [0, 1, 2, 3, 4, 5, 6];

export const DAY_LABELS: Readonly<Record<DayOfWeek, string>> = {
  0: 'Sun',
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
};

export const DEFAULT_HORIZON_WEEKS = 4;

/** Validation error codes. The UI translates them to copy. */
export type SeriesValidationError =
  | 'days_empty'
  | 'days_invalid'
  | 'range_invalid'
  | 'time_invalid'
  | 'horizon_invalid';

export interface SeriesInput {
  startDate: string;            // YYYY-MM-DD
  endDate: string | null;       // YYYY-MM-DD or null = open-ended (horizon only)
  daysOfWeek: ReadonlyArray<number>;
  startTime?: string;           // HH:MM (24h) — checked for format when supplied
  horizonWeeks?: number;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateSeriesInput(input: SeriesInput): SeriesValidationError | null {
  if (!input.daysOfWeek || input.daysOfWeek.length === 0) return 'days_empty';
  for (const d of input.daysOfWeek) {
    if (!Number.isInteger(d) || d < 0 || d > 6) return 'days_invalid';
  }
  // duplicate days are fine but we de-dupe at expand time
  if (input.endDate && input.endDate < input.startDate) return 'range_invalid';
  if (input.startTime !== undefined && !TIME_RE.test(input.startTime)) return 'time_invalid';
  if (input.horizonWeeks !== undefined) {
    if (!Number.isInteger(input.horizonWeeks) || input.horizonWeeks < 1 || input.horizonWeeks > 52) {
      return 'horizon_invalid';
    }
  }
  return null;
}

export interface ExpandInput {
  startDate: string;            // YYYY-MM-DD
  endDate: string | null;
  daysOfWeek: ReadonlyArray<number>;
  horizonWeeks?: number;        // only used when endDate is null
}

/**
 * Walk the (startDate..endDate) window day by day and return every date
 * whose weekday is in `daysOfWeek`. Returns YYYY-MM-DD strings so the
 * caller can `new Date(d + 'T' + startTime)` to get a wall-clock timestamp.
 *
 * Open-ended series (endDate == null) walk forward by `horizonWeeks`
 * weeks (default 4) from startDate inclusive. Anything outside the
 * window is dropped.
 *
 * Days of week use Postgres EXTRACT(dow) semantics: 0 = Sunday.
 */
export function expandSeries(input: ExpandInput): string[] {
  const start = parseDate(input.startDate);
  const end = input.endDate
    ? parseDate(input.endDate)
    : addDays(start, (input.horizonWeeks ?? DEFAULT_HORIZON_WEEKS) * 7);
  const want = new Set<number>(input.daysOfWeek);

  const out: string[] = [];
  // Cap the loop at ~366 days so a 1-year horizon can't iterate into infinity
  // if the inputs are nonsense. Anything past 366 days is filtered out by
  // the end check anyway.
  for (let i = 0; i <= 366 && !past(start, end); i++) {
    const dow = start.getUTCDay();
    if (want.has(dow)) out.push(toIsoDate(start));
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return out;
}

function parseDate(yyyyMmDd: string): Date {
  // Parse as UTC midnight so the .getUTCDay() weekday math is independent
  // of the runtime's local timezone.
  const [y, m, d] = yyyyMmDd.split('-').map((s) => Number.parseInt(s, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function past(d: Date, end: Date): boolean {
  return d.getTime() > end.getTime();
}

function toIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}