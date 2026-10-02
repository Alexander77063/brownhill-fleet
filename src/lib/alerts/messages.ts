/**
 * What an alert says to the person who owns the car.
 *
 * One template per kind, under 160 characters so it is one SMS, naming the
 * vehicle and a place. The "meaning" line is the portal's plain-language
 * explanation. Copy addresses a person about their car — never "asset",
 * "unit" or "fleet".
 */
import type { Database } from '@/lib/supabase/database.types';
import { safeTimeZone } from '@/lib/timezone';

export type AlertKind = Database['public']['Enums']['alert_kind'];
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertMessageContext {
  kind: AlertKind;
  occurredAt: string;
  timezone: string;
  vehicle: { make: string; registration: string };
  lat: number | null;
  lng: number | null;
  speedKph: number | null;
  detail: Record<string, unknown>;
}

export const ALERT_KINDS: readonly AlertKind[] = [
  'speeding',
  'night_movement',
  'zone_exit',
  'device_offline',
  'immobilised',
  'released',
];

export const ALERT_LABEL: Record<AlertKind, string> = {
  speeding: 'Speeding',
  night_movement: 'Moved at night',
  zone_exit: 'Left its zone',
  device_offline: 'Tracker silent',
  immobilised: 'Immobilised',
  released: 'Released',
};

/** One sentence on what the alert means, for the feed. */
export const ALERT_MEANING: Record<AlertKind, string> = {
  speeding: 'The vehicle was driven faster than the limit you set.',
  night_movement: 'The vehicle moved during the hours you marked as night.',
  zone_exit: 'The vehicle left the home zone drawn for it.',
  device_offline: 'The tracker has not reported for longer than you allow. It may be off, unplugged or out of coverage.',
  immobilised: 'An immobilise command was issued for the vehicle.',
  released: 'The vehicle was released and can be driven again.',
};

function localTime(iso: string, timezone: string): string {
  // A bad zone on the owner row must never stop the message being sent.
  return new Intl.DateTimeFormat('en-GB', { timeZone: safeTimeZone(timezone), hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  );
}

function place(ctx: AlertMessageContext): string {
  const zone = typeof ctx.detail.zoneName === 'string' ? ctx.detail.zoneName : null;
  const near = typeof ctx.detail.near === 'string' ? ctx.detail.near : null;
  if (near) return `near ${near}`;
  if (zone && ctx.kind !== 'zone_exit') return `near ${zone}`;
  if (ctx.lat != null && ctx.lng != null) return `near ${ctx.lat.toFixed(3)},${ctx.lng.toFixed(3)}`;
  return '';
}

/** The SMS / push body for an alert. Always ≤ 160 characters. */
export function alertMessage(ctx: AlertMessageContext): string {
  const veh = `${ctx.vehicle.make} ${ctx.vehicle.registration}`.trim();
  const t = localTime(ctx.occurredAt, ctx.timezone);
  const p = place(ctx);
  let text: string;
  switch (ctx.kind) {
    case 'speeding':
      text = `Your ${veh} was doing ${Math.round(ctx.speedKph ?? 0)} km/h ${p} at ${t}.`.replace(/\s+/g, ' ');
      break;
    case 'night_movement':
      text = `Your ${veh} moved at ${t} ${p}. Not you? Ask for help in the app.`.replace(/\s+/g, ' ');
      break;
    case 'zone_exit': {
      const zone = typeof ctx.detail.zoneName === 'string' ? ctx.detail.zoneName : 'its zone';
      text = `Your ${veh} left ${zone} at ${t}.`;
      break;
    }
    case 'device_offline': {
      const hours = typeof ctx.detail.silentHours === 'number' ? Math.round(ctx.detail.silentHours) : null;
      text = `Your ${veh}'s tracker has been silent${hours != null ? ` for ${hours} hours` : ''}. Check it is powered and in coverage.`;
      break;
    }
    case 'immobilised':
      // Until hardware confirms delivery, say what is true: a request was logged.
      text =
        ctx.detail.delivered === true
          ? `Your ${veh} was immobilised at ${t}.`
          : `An immobilise request for your ${veh} was logged at ${t}. It takes effect once the tracker confirms.`;
      break;
    case 'released':
      text =
        ctx.detail.delivered === true
          ? `Your ${veh} was released at ${t} and can be driven again.`
          : `A release request for your ${veh} was logged at ${t}.`;
      break;
  }
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}
