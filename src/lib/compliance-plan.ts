/**
 * Turn compliance records into obligations, using the active region's rules.
 *
 * Pure, and separate from `compliance.ts`, because this is the code that decides
 * whether a vehicle is legal to dispatch and whether a driver may be assigned
 * one. Getting it wrong either grounds a working vehicle or puts an untaxed,
 * uninspected one on the road, so it is worth being able to test every case
 * without a database.
 *
 * The region pack (src/lib/region/*.ts) is the authority on what a country
 * requires, what each document is called, and whether operating without it is
 * illegal. Nothing here hardcodes a jurisdiction.
 */
import { storageHome, type ObligationSpec } from '@/lib/region/types';

/** A row from `vehicle_compliance` (0055) or `driver_documents` (0051/0056). */
export interface ComplianceRecord {
  obligation_key: string;
  expires_on: string | null;
  reference: string | null;
}

/**
 * Blocking is decided by obligation type, and the region pack's `mandatory` flag
 * chooses between the pair. One pair per entity, because `obligations` is unique
 * on (entity_type, entity_id, type).
 */
export interface ObligationTypes {
  /** Mandatory documents — appears in BLOCKING_TYPES, stops dispatch when overdue. */
  blocking: string;
  /** Optional documents — visible, but never grounds anyone. */
  advisory: string;
}

export const VEHICLE_TYPES: ObligationTypes = {
  blocking: 'vehicle_compliance_expiry',
  advisory: 'vehicle_document_expiry',
};

export const DRIVER_TYPES: ObligationTypes = {
  blocking: 'driver_compliance_expiry',
  advisory: 'driver_document_expiry',
};

export interface PlannedObligation {
  type: string;
  /** The document's name in this country, for the obligation title. */
  label: string;
  dueDate: string;
  obligationKey: string;
}

/** Days from `today` to `date`; negative once the date has passed. */
function daysUntil(today: string, date: string): number {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Plan the obligations for one entity.
 *
 * At most two are returned — one mandatory, one advisory. Where several
 * documents of the same class are in scope, the soonest wins: that is the one
 * about to ground the vehicle or the driver, and it is the one an operator needs
 * to act on first.
 */
export function planCompliance(
  specs: readonly ObligationSpec[],
  records: readonly ComplianceRecord[],
  today: string,
  types: ObligationTypes,
  horizonDays = 30,
): PlannedObligation[] {
  const byKey = new Map(specs.map((s) => [s.key, s] as const));
  const candidates: (PlannedObligation & { mandatory: boolean })[] = [];

  for (const record of records) {
    // A document with no expiry — proof of ownership, a NIN — is worth holding
    // but raises nothing. Inventing a due date for it would be noise.
    if (!record.expires_on) continue;

    // The region decides what it requires. A leftover record for a document
    // this country does not use must not raise an obligation. This is also what
    // keeps the universal kinds (right to work, proof of address) out of the
    // blocking pair — they are not region obligations and are handled generically.
    const spec = byKey.get(record.obligation_key);
    if (!spec) continue;

    // A document whose dates live somewhere else — a column on `vehicles` or
    // `drivers`, or the driver's insurance certificate — is already turned into
    // an obligation by that code path. Planning it again here would raise a
    // second obligation, carrying its own independently-entered date, for the
    // same certificate. Since the blocking type stops dispatch, the two
    // disagreeing is how a taxed, tested vehicle gets grounded.
    if (storageHome(spec).kind !== 'record') continue;

    // Already-expired documents are explicitly included: they are the case that
    // matters most, and a naive "within N days" test would drop them.
    if (daysUntil(today, record.expires_on) > horizonDays) continue;

    candidates.push({
      type: spec.mandatory ? types.blocking : types.advisory,
      label: spec.label,
      dueDate: record.expires_on,
      obligationKey: record.obligation_key,
      mandatory: spec.mandatory,
    });
  }

  const soonest = (list: typeof candidates) =>
    list.sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];

  const planned: PlannedObligation[] = [];
  for (const mandatory of [true, false]) {
    const pick = soonest(candidates.filter((c) => c.mandatory === mandatory));
    if (pick) {
      const { mandatory: _drop, ...rest } = pick;
      planned.push(rest);
    }
  }
  return planned;
}

/** Plan the obligations for one vehicle. */
export function planVehicleCompliance(
  specs: readonly ObligationSpec[],
  records: readonly ComplianceRecord[],
  today: string,
  horizonDays = 30,
): PlannedObligation[] {
  return planCompliance(specs, records, today, VEHICLE_TYPES, horizonDays);
}

/** Plan the obligations for one driver. */
export function planDriverCompliance(
  specs: readonly ObligationSpec[],
  records: readonly ComplianceRecord[],
  today: string,
  horizonDays = 30,
): PlannedObligation[] {
  return planCompliance(specs, records, today, DRIVER_TYPES, horizonDays);
}
