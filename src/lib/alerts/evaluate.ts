/**
 * Pure alert evaluator for an owned vehicle (spec §7.2) — no I/O, no clock of
 * its own. `ingestPosition` calls it once per ping with the owner's thresholds,
 * the previous stored point and the new one; it answers with the alerts this
 * ping raises, each already stamped with the dedupe key that makes its insert
 * idempotent (§7.3). Because it is pure it can never fail an ingest (§11): bad
 * input degrades to fewer alerts, never to a throw.
 *
 * Three kinds live here — the ones judged per ping:
 *   - speeding:       device speed (mph in the schema) converted once, compared
 *                     to the owner's km/h limit; critical at limit + 30.
 *   - night_movement: ≥ 150 m of displacement while the owner's local clock is
 *                     inside their night window [night_from, night_to).
 *   - zone_exit:      the previous point was inside an owner zone and this one
 *                     is outside — a transition, so the previous point matters.
 *
 * `device_offline` is a sweep, not a per-ping rule (a silent tracker sends no
 * ping to evaluate): see `./offline.ts`. `immobilised` / `released` are raised
 * by the immobilise path itself, one per command.
 */
import { haversineMeters } from '@/lib/geo';
import { hmToMinutes, localMinutes } from '@/lib/tracking-rules';
import { mphToKph } from '@/lib/units';
import { nightKey, speedingKey, zoneExitKey } from './dedupe';

/** Ignore GPS jitter when parked — the same figure `tracking-rules.ts` uses. */
export const MOVEMENT_THRESHOLD_M = 150;
/** Speeding becomes critical this far over the owner's limit (km/h). */
export const CRITICAL_OVER_LIMIT_KPH = 30;
/** Metres beyond a zone's radius a point must be before it counts as "left". */
export const ZONE_HYSTERESIS_M = 50;

/** The alert-threshold columns of `vehicle_owners`. */
export interface OwnerAlertSettings {
  id: string;
  /** Postgres `time` — 'HH:MM:SS' from PostgREST, 'HH:MM' from a form. */
  night_from: string;
  night_to: string;
  /** IANA zone the night window is expressed in (defaults from the region pack at row creation). */
  timezone: string;
  speed_limit_kph: number;
}

/** A stored position: `vehicle_positions` / `vehicle_position_history` in camelCase. */
export interface Point {
  lat: number;
  lng: number;
  /** Device-reported and often null — most phone pings carry no speed. */
  speedMph: number | null;
  recordedAt: string;
}

/** An `owner_zones` row. `is_active` is optional because the query normally filters already. */
export interface Zone {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  is_active?: boolean;
}

export type PerPingAlertKind = 'speeding' | 'night_movement' | 'zone_exit';
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** What the persistence layer turns into a `vehicle_alerts` row. */
export interface AlertCandidate {
  kind: PerPingAlertKind;
  severity: AlertSeverity;
  /** ISO instant of the ping (or `now` when the ping's timestamp was unreadable). */
  occurredAt: string;
  lat: number;
  lng: number;
  /** The ping's speed in km/h to one decimal, or null when the device sent none. */
  speedKph: number | null;
  /** Kind-specific facts the message templates need (zone name, local time, …). */
  detail: Record<string, unknown>;
  dedupeKey: string;
}

export interface EvaluateInput {
  vehicleId: string;
  /** Null for an unowned fleet vehicle — the common SaaS case; nothing is evaluated. */
  owner: OwnerAlertSettings | null;
  /** The point stored before this ping, read before the upsert. Null on a vehicle's first ping. */
  prev: Point | null;
  curr: Point;
  zones: Zone[];
  /** The caller's clock: the fallback instant when `curr.recordedAt` is unreadable. */
  now: Date;
}

/** km/h to one decimal — what the owner sees, and precise enough to compare to an integer limit. */
function roundKph(kph: number): number {
  return Math.round(kph * 10) / 10;
}

function toKph(speedMph: number | null): number | null {
  if (speedMph === null || !Number.isFinite(speedMph)) return null;
  return roundKph(mphToKph(speedMph));
}

function instantOf(iso: string, fallback: Date): Date {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/** Local calendar date (YYYY-MM-DD) of an instant in an IANA zone. */
/** The calendar day before a 'YYYY-MM-DD' string. */
export function previousDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/**
 * True when `minutes` (since local midnight) falls inside the half-open window
 * [from, to). A window that wraps midnight (22:00 → 05:00) is the union of its
 * two halves; `from === to` is the empty window, i.e. night alerts switched off.
 *
 * Not `outsideWindow()` from tracking-rules inverted: that one is inclusive at
 * `to` (a permitted-hours window), and an owner whose night ends at 05:00 does
 * not want the 05:00 school run flagged.
 */
export function insideWindow(minutes: number, fromMin: number, toMin: number): boolean {
  if (fromMin === toMin) return false;
  if (fromMin < toMin) return minutes >= fromMin && minutes < toMin;
  return minutes >= fromMin || minutes < toMin;
}

interface LocalClock {
  minutes: number;
  date: string;
  hhmm: string;
}

/** The owner's wall clock at `at`, or null when the timezone name is not one Intl knows. */
function localClock(at: Date, timeZone: string): LocalClock | null {
  try {
    const minutes = localMinutes(at.toISOString(), timeZone);
    const date = localDate(at, timeZone);
    const h = String(Math.floor(minutes / 60)).padStart(2, '0');
    const m = String(minutes % 60).padStart(2, '0');
    return { minutes, date, hhmm: `${h}:${m}` };
  } catch {
    // An invalid IANA name must cost the ping its night rule, not its other alerts.
    return null;
  }
}

const hhmm = (time: string) => time.slice(0, 5);

/**
 * Evaluate one ping for an owned vehicle. Returns the candidates in a stable
 * order — speeding, night movement, then one per zone left — all sharing the
 * ping's instant, position and converted speed.
 */
export function evaluateOwnerAlerts(input: EvaluateInput): AlertCandidate[] {
  const { vehicleId, owner, prev, curr, zones, now } = input;
  if (!owner) return [];

  const at = instantOf(curr.recordedAt, now);
  const speedKph = toKph(curr.speedMph);
  const base = { occurredAt: at.toISOString(), lat: curr.lat, lng: curr.lng, speedKph };
  const out: AlertCandidate[] = [];

  // Speeding — per ping, skipped when the device sent no speed.
  if (speedKph !== null && speedKph > owner.speed_limit_kph) {
    const critical = speedKph >= owner.speed_limit_kph + CRITICAL_OVER_LIMIT_KPH;
    out.push({
      ...base,
      kind: 'speeding',
      severity: critical ? 'critical' : 'warning',
      detail: { speedKph, limitKph: owner.speed_limit_kph, overKph: roundKph(speedKph - owner.speed_limit_kph) },
      dedupeKey: speedingKey(vehicleId, at),
    });
  }

  // Everything below is about the change since the previous point. A device
  // can backfill an older point after a newer one was stored; a "transition"
  // from the future into the past means nothing, so treat it as a first ping.
  if (!prev) return out;
  if (instantOf(prev.recordedAt, at).getTime() > at.getTime()) return out;

  // Night movement — real displacement while the owner's clock says night.
  const distanceM = haversineMeters(prev.lat, prev.lng, curr.lat, curr.lng);
  if (distanceM >= MOVEMENT_THRESHOLD_M) {
    const local = localClock(at, owner.timezone);
    const fromMin = hmToMinutes(owner.night_from);
    const toMin = hmToMinutes(owner.night_to);
    if (local && insideWindow(local.minutes, fromMin, toMin)) {
      // One episode per NIGHT, not per calendar date: a window that wraps
      // midnight keys its post-midnight half to the date the night started,
      // so a trip spanning 00:00 is one alert, not two.
      const nightDate = fromMin > toMin && local.minutes < toMin ? previousDate(local.date) : local.date;
      out.push({
        ...base,
        kind: 'night_movement',
        severity: 'warning',
        detail: {
          distanceM: Math.round(distanceM),
          localTime: local.hhmm,
          timezone: owner.timezone,
          nightFrom: hhmm(owner.night_from),
          nightTo: hhmm(owner.night_to),
        },
        dedupeKey: nightKey(vehicleId, nightDate),
      });
    }
  }

  // Zone exit — a transition per zone: inside before, clearly outside now.
  // "Clearly" is the hysteresis: outside means beyond the radius plus the
  // larger of 50 m and 10 % of it, so a car parked on the boundary that
  // jitters a few metres does not raise a critical alert on every fix.
  for (const zone of zones) {
    if (zone.is_active === false) continue;
    const before = haversineMeters(prev.lat, prev.lng, zone.lat, zone.lng);
    if (before > zone.radius_m) continue;
    const after = haversineMeters(curr.lat, curr.lng, zone.lat, zone.lng);
    if (after <= zone.radius_m + Math.max(ZONE_HYSTERESIS_M, zone.radius_m * 0.1)) continue;
    out.push({
      ...base,
      kind: 'zone_exit',
      severity: 'critical',
      detail: { zoneId: zone.id, zoneName: zone.name, radiusM: zone.radius_m, distanceM: Math.round(after) },
      dedupeKey: zoneExitKey(vehicleId, zone.id, at),
    });
  }

  return out;
}
