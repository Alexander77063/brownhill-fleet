/**
 * IANA time-zone validation. An owner's timezone drives their night window and
 * the local time printed in every alert; a bad value used to throw inside
 * message formatting and silently kill delivery. Validate at the edges and
 * fall back to UTC when formatting anything.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function safeTimeZone(tz: unknown, fallback = 'UTC'): string {
  return isValidTimeZone(tz) ? tz : fallback;
}
