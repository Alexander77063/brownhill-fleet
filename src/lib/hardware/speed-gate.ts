/**
 * The safety rule on the last hop (NG-3 §6, user decision): an engine cut is
 * sent only when the vehicle is known to be stopped or crawling — a recent
 * position at or under the console's speed ceiling. Release is never gated:
 * giving the engine back cannot hurt anyone.
 */
export interface GateSettings {
  'hardware.immobilise_max_speed_kph': number;
  'hardware.position_max_age_minutes': number;
}

export type GateResult = { ok: true; speedKph: number | null } | { ok: false; reason: 'no-recent-position' | 'moving'; speedKph: number | null };

const MPH_TO_KPH = 1.609344;

export function speedGate(
  latest: { speedMph: number | null; recordedAt: string } | null,
  now: Date,
  settings: GateSettings,
  action: 'immobilise' | 'release',
): GateResult {
  const speedKph = latest?.speedMph == null ? null : Math.round(latest.speedMph * MPH_TO_KPH * 10) / 10;
  if (action === 'release') return { ok: true, speedKph };
  if (!latest) return { ok: false, reason: 'no-recent-position', speedKph: null };
  const ageMs = now.getTime() - Date.parse(latest.recordedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > settings['hardware.position_max_age_minutes'] * 60_000) {
    return { ok: false, reason: 'no-recent-position', speedKph };
  }
  // A recent fix without a speed reading: the device is talking; treat as stopped.
  if (speedKph != null && speedKph > settings['hardware.immobilise_max_speed_kph']) return { ok: false, reason: 'moving', speedKph };
  return { ok: true, speedKph };
}

export function gateReasonText(reason: 'no-recent-position' | 'moving', settings: GateSettings): string {
  return reason === 'moving'
    ? `The vehicle is moving faster than ${settings['hardware.immobilise_max_speed_kph']} km/h. Wait until it stops.`
    : `No position in the last ${settings['hardware.position_max_age_minutes']} minutes. The tracker must be reporting before an engine cut is sent.`;
}
