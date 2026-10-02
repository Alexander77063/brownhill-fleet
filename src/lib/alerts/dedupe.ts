/**
 * One alert per episode, not per ping (spec §7.3).
 *
 * Each key names the episode an alert belongs to; `vehicle_alerts (tenant_id,
 * dedupe_key)` is unique, so a second ping inside the same episode is a no-op
 * insert — not an error, and nothing is sent. The evaluator stamps every
 * candidate with its key; the persistence layer never has to reason about
 * "have we already told the owner about this".
 */

const THIRTY_MIN_MS = 30 * 60 * 1000;
const ONE_MIN_MS = 60 * 1000;

/** Speeding: one alert per vehicle per 30-minute bucket of the ping's instant. */
export function speedingKey(vehicleId: string, at: Date): string {
  const bucket = Math.floor(at.getTime() / THIRTY_MIN_MS);
  return `speeding:${vehicleId}:${bucket}`;
}

/** Night movement: one alert per vehicle per LOCAL night (the owner's calendar date, YYYY-MM-DD). */
export function nightKey(vehicleId: string, localDate: string): string {
  return `night_movement:${vehicleId}:${localDate}`;
}

/**
 * Zone exit: one alert per vehicle per zone per minute of the exit. The exit is
 * already a state transition (inside → outside), so this only guards against
 * the same ping being processed twice.
 */
/**
 * Exit episodes bucket to 30 minutes, not a minute: a car parked on the zone
 * boundary jitters in and out with every fix, and the evaluator's hysteresis
 * already needs a real departure — the bucket is the second line of defence.
 */
export function zoneExitKey(vehicleId: string, zoneId: string, at: Date): string {
  const bucket = Math.floor(at.getTime() / THIRTY_MIN_MS);
  return `zone_exit:${vehicleId}:${zoneId}:${bucket}`;
}

/** Device offline: one alert per vehicle per UTC day of the sweep (YYYY-MM-DD). */
export function offlineKey(vehicleId: string, utcDate: string): string {
  return `device_offline:${vehicleId}:${utcDate}`;
}

/** Immobilise / release: one alert per command, whatever the retries. */
export function immobiliseKey(commandId: string): string {
  return `immobilised:${commandId}`;
}
