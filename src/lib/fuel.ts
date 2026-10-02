/**
 * Fuel consumption and loss detection.
 *
 * Fuel is the largest running cost in a Nigerian fleet and the largest source of
 * loss, and the losses hide well: a driver fills up and sells half the tank, a
 * full tank is logged for a vehicle that never moved, an attendant
 * short-delivers and splits the difference, a receipt is claimed twice. Every
 * one of those lines looks reasonable on its own. They only become visible when
 * litres are compared against distance actually travelled.
 *
 * So everything here works on **intervals between consecutive fills**, not on
 * totals.
 *
 * ## Two rules this module keeps
 *
 * 1. **Never guess.** A missing odometer produces `null`, not an estimate. A
 *    figure invented to fill a gap is indistinguishable from a real one once it
 *    reaches a report, and someone will be accused of theft on the strength of
 *    it.
 * 2. **Do not cry wolf.** Ordinary variation — traffic, load, a hill — is not an
 *    anomaly. A detector that fires on a bad Tuesday gets switched off, and then
 *    catches nothing at all. The thresholds below are deliberately wide.
 */

export interface VehicleFuelProfile {
  vehicleId: string;
  registration: string;
  /** Litres. Null when unknown — the over-capacity check is then skipped. */
  tankCapacityLitres: number | null;
  /** Expected km per litre, used until the vehicle has its own history. */
  baselineKmPerLitre: number | null;
}

export interface FuelLog {
  id: string;
  vehicleId: string;
  driverId: string | null;
  filledAt: Date;
  litres: number;
  /** Integer minor units (kobo / pence). */
  costMinor: number;
  odometerKm: number | null;
  station: string | null;
}

/** Mirrors the `fuel_payment_method` enum in migration 0054. */
export const FUEL_PAYMENT_METHODS = [
  'cash',
  'card',
  'fuel_card',
  'company_account',
  'other',
] as const;
export type FuelPaymentMethod = (typeof FUEL_PAYMENT_METHODS)[number];

/**
 * Narrow a posted form value to a payment method.
 *
 * A `<select>` can be submitted with anything. An unrecognised value would be
 * rejected by the database enum with an error naming nothing the operator did,
 * losing an otherwise complete fill over a dropdown. Falling back to `other`
 * records it, which is what matters — the litres and the odometer are the
 * facts, how it was paid for is a label.
 */
export function toPaymentMethod(raw: string | null | undefined): FuelPaymentMethod {
  return (FUEL_PAYMENT_METHODS as readonly string[]).includes(raw ?? '')
    ? (raw as FuelPaymentMethod)
    : 'other';
}

export type AnomalyKind =
  | 'over_tank_capacity'
  | 'consumption_worse'
  | 'consumption_impossible'
  | 'duplicate_fill'
  | 'price_spike';

export interface FuelAnomaly {
  kind: AnomalyKind;
  severity: 'high' | 'warning';
  /** The fill the finding is attached to. */
  logId: string;
  /** One sentence an operator can act on, with the numbers in it. */
  detail: string;
}

export interface FuelAnalysis {
  fills: number;
  totalLitres: number;
  totalCostMinor: number;
  /** The vehicle's own measured km/l across all usable intervals, or null. */
  observedKmPerLitre: number | null;
  anomalies: FuelAnomaly[];
}

// ── Thresholds ─────────────────────────────────────────────────────────────
//
// Wide on purpose. See rule 2 above.

/** Consumption this much worse than expected is investigated. 35% worse. */
const WORSE_RATIO = 0.65;
/** Better than double the expected figure means fuel went in unrecorded. */
const IMPOSSIBLE_RATIO = 2.0;
/** Two fills closer together than this are almost certainly one event twice. */
const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
/** A unit price this far above the recent median is worth a look. 50% up. */
const PRICE_SPIKE_RATIO = 1.5;
/** Below this many usable intervals, the vehicle has no history worth trusting. */
const MIN_INTERVALS_FOR_OWN_BASELINE = 3;

/**
 * Kilometres per litre across the interval that STARTS at `a`.
 *
 * The litres are `a`'s, not `b`'s: fuel put in at the start of the interval is
 * what moved the vehicle to the end of it. Using `b`'s litres would attribute
 * each fill to the distance travelled before it.
 *
 * Null whenever the interval cannot be measured — a missing odometer, or one
 * that did not advance (a vehicle that has not moved cannot have a consumption
 * rate, and dividing by zero would report Infinity as a number of km/l).
 */
export function consumptionBetween(a: FuelLog, b: FuelLog): number | null {
  if (a.odometerKm == null || b.odometerKm == null) return null;
  const distance = b.odometerKm - a.odometerKm;
  if (distance <= 0) return null;
  if (a.litres <= 0) return null;
  return distance / a.litres;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Analyse one vehicle's fills.
 *
 * Sorts internally, so callers need not — a caller that forgets would otherwise
 * get silently wrong consumption rather than an error.
 */
export function analyseFuel(
  vehicle: VehicleFuelProfile,
  logs: readonly FuelLog[],
): FuelAnalysis {
  const ordered = [...logs].sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime());

  const totalLitres = ordered.reduce((sum, l) => sum + l.litres, 0);
  const totalCostMinor = ordered.reduce((sum, l) => sum + l.costMinor, 0);
  const anomalies: FuelAnomaly[] = [];

  // ── Per-fill checks ─────────────────────────────────────────────────────
  for (const log of ordered) {
    if (vehicle.tankCapacityLitres != null && log.litres > vehicle.tankCapacityLitres) {
      anomalies.push({
        kind: 'over_tank_capacity',
        severity: 'high',
        logId: log.id,
        detail:
          `${round1(log.litres)} litres recorded into a ${round1(vehicle.tankCapacityLitres)}-litre tank. ` +
          'The excess was never in the vehicle.',
      });
    }
  }

  // ── Intervals ───────────────────────────────────────────────────────────
  const intervals: { from: FuelLog; to: FuelLog; kmPerLitre: number }[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const kmPerLitre = consumptionBetween(ordered[i], ordered[i + 1]);
    if (kmPerLitre != null) {
      intervals.push({ from: ordered[i], to: ordered[i + 1], kmPerLitre });
    }

    const gapMs = ordered[i + 1].filledAt.getTime() - ordered[i].filledAt.getTime();
    if (gapMs < DUPLICATE_WINDOW_MS) {
      anomalies.push({
        kind: 'duplicate_fill',
        severity: 'warning',
        logId: ordered[i + 1].id,
        detail:
          `Two fills ${Math.max(1, Math.round(gapMs / 60000))} minutes apart. ` +
          'Check this is not the same receipt entered twice.',
      });
    }
  }

  const observedKmPerLitre = median(intervals.map((i) => i.kmPerLitre));

  // Prefer the vehicle's own measured history once there is enough of it: a
  // vehicle that genuinely does 5 km/l should not be flagged forever because
  // someone typed an optimistic figure when adding it.
  const expected =
    intervals.length >= MIN_INTERVALS_FOR_OWN_BASELINE && observedKmPerLitre != null
      ? observedKmPerLitre
      : vehicle.baselineKmPerLitre ?? observedKmPerLitre;

  if (expected != null && expected > 0) {
    for (const interval of intervals) {
      const ratio = interval.kmPerLitre / expected;

      if (ratio < WORSE_RATIO) {
        anomalies.push({
          kind: 'consumption_worse',
          severity: 'high',
          logId: interval.to.id,
          detail:
            `${round1(interval.kmPerLitre)} km per litre against an expected ${round1(expected)}. ` +
            'Either the vehicle has a fault, or fuel is leaving it unaccounted for.',
        });
      } else if (ratio > IMPOSSIBLE_RATIO) {
        anomalies.push({
          kind: 'consumption_impossible',
          severity: 'warning',
          logId: interval.to.id,
          detail:
            `${round1(interval.kmPerLitre)} km per litre against an expected ${round1(expected)}. ` +
            'That is too good to be real — the vehicle was probably refuelled without it being logged.',
        });
      }
    }
  }

  // ── Unit price ──────────────────────────────────────────────────────────
  const unitPrices = ordered
    .filter((l) => l.litres > 0)
    .map((l) => ({ log: l, perLitre: l.costMinor / l.litres }));
  const medianPrice = median(unitPrices.map((u) => u.perLitre));

  if (medianPrice != null && medianPrice > 0 && unitPrices.length >= 3) {
    for (const { log, perLitre } of unitPrices) {
      if (perLitre > medianPrice * PRICE_SPIKE_RATIO) {
        anomalies.push({
          kind: 'price_spike',
          severity: 'warning',
          logId: log.id,
          detail:
            `Paid about ${Math.round((perLitre / medianPrice - 1) * 100)}% more per litre than usual` +
            `${log.station ? ` at ${log.station}` : ''}.`,
        });
      }
    }
  }

  return {
    fills: ordered.length,
    totalLitres,
    totalCostMinor,
    observedKmPerLitre,
    anomalies,
  };
}
