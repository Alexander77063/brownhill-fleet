/**
 * Console forms post `datetime-local` values with no zone. The admin means the
 * customer's local time, so we pin the value to the region's zone rather than
 * the server's — a booking typed as 10:30 in Lagos must reach the installer
 * as 10:30 in Lagos wherever the function runs.
 */
export function localToISO(local: string, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) throw new Error('Pick a date and time.');
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  const guess = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  // Two passes handle a DST edge where the first offset guess is off by an hour.
  let utc = guess - offsetMinutes(guess, timeZone) * 60_000;
  utc = guess - offsetMinutes(utc, timeZone) * 60_000;
  return new Date(utc).toISOString();
}

/** Minutes east of UTC for `timeZone` at the given instant. */
export function offsetMinutes(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instantMs) / 60_000);
}

/** The `datetime-local` value for an ISO instant in `timeZone` (to pre-fill a form). */
export function isoToLocal(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  const shifted = new Date(ms + offsetMinutes(ms, timeZone) * 60_000);
  return shifted.toISOString().slice(0, 16);
}
