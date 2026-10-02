/**
 * The view model behind the vehicle compliance card.
 *
 * Pure, and separate from the page, for the same reason `compliance-plan.ts` is
 * separate from `compliance.ts`: this decides what an operator is told about a
 * vehicle's paperwork, and "expired" versus "due soon" versus "we have no idea"
 * is worth testing without a database or a browser.
 *
 * It is deliberately NOT built from `planVehicleCompliance`. That function
 * returns at most one mandatory obligation per vehicle, because the obligations
 * table is keyed by type — so if roadworthiness expired in March and the vehicle
 * licence expires tomorrow, it reports one of them. A screen that hid the other
 * would be worse than no screen.
 */
import {
  storageHome,
  type ObligationCadence,
  type ObligationSpec,
  type DateColumn,
} from '@/lib/region/types';
import type { ComplianceRecord } from '@/lib/compliance-plan';

export type ComplianceStatus =
  /** Past its expiry date. */
  | 'expired'
  /** Expires within the horizon. */
  | 'due_soon'
  /** In date. */
  | 'valid'
  /** Nothing recorded — for a mandatory document this is as serious as expired. */
  | 'missing'
  /** A one-off document (proof of ownership) that is held, and cannot expire. */
  | 'recorded'
  /** Owned by another screen; shown so the list is complete, but not editable here. */
  | 'elsewhere';

export interface ComplianceViewRow {
  key: string;
  label: string;
  authority: string;
  mandatory: boolean;
  cadence: ObligationCadence;
  /** False for `once` documents, which have no expiry to ask for. */
  expires: boolean;
  expiresOn: string | null;
  reference: string | null;
  status: ComplianceStatus;
  /** Days until expiry; negative once passed, null when there is no date. */
  daysLeft: number | null;
  /** Set when another screen owns the document — the card links instead of asking. */
  managedOn: { label: string; href: string } | null;
  /** True when the date is stored on `vehicles` rather than in `vehicle_compliance`. */
  columnBacked: boolean;
}

/** Dates that live on the entity row itself (`vehicles` or `drivers`). */
export type EntityDates = Partial<Record<DateColumn, string | null>>;

function daysUntil(today: string, date: string): number {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * How urgently each status wants attention. Missing sorts alongside expired
 * because for a mandatory document they mean the same thing operationally: the
 * vehicle cannot be shown to be legal.
 */
const RANK: Record<ComplianceStatus, number> = {
  expired: 0,
  missing: 1,
  due_soon: 2,
  valid: 4,
  recorded: 4,
  elsewhere: 5,
};

/**
 * Build one row per document the active region requires.
 *
 * Every spec appears, whether or not anything has been recorded against it —
 * a document nobody has entered is precisely the one worth showing, and a card
 * built only from stored rows would render empty for a brand-new vehicle and
 * imply everything was in order.
 */
export function buildComplianceView(
  specs: readonly ObligationSpec[],
  records: readonly ComplianceRecord[],
  entityDates: EntityDates,
  today: string,
  horizonDays = 30,
): ComplianceViewRow[] {
  const byKey = new Map(records.map((r) => [r.obligation_key, r] as const));

  const rows = specs.map((spec): ComplianceViewRow => {
    const home = storageHome(spec);
    const record = byKey.get(spec.key);

    // Where the date lives decides where it is read from. Reading the column for
    // a column-backed document is what keeps the card and the agreement PDF
    // showing the same MOT date.
    const expiresOn =
      home.kind === 'column' ? (entityDates[home.column] ?? null) : (record?.expires_on ?? null);
    const reference = home.kind === 'column' ? null : (record?.reference ?? null);

    const expires = spec.cadence !== 'once';
    const daysLeft = expiresOn ? daysUntil(today, expiresOn) : null;

    let status: ComplianceStatus;
    if (home.kind === 'elsewhere') {
      status = 'elsewhere';
    } else if (!expires) {
      // A proof-of-ownership certificate does not lapse. Asking for an expiry
      // date would invent one, and showing it as overdue would be a lie.
      status = record?.reference || record?.expires_on ? 'recorded' : 'missing';
    } else if (expiresOn == null) {
      status = 'missing';
    } else if (daysLeft! < 0) {
      status = 'expired';
    } else if (daysLeft! <= horizonDays) {
      status = 'due_soon';
    } else {
      status = 'valid';
    }

    return {
      key: spec.key,
      label: spec.label,
      authority: spec.authority,
      mandatory: spec.mandatory,
      cadence: spec.cadence,
      expires,
      expiresOn,
      reference,
      status,
      daysLeft,
      managedOn: home.kind === 'elsewhere' ? { label: home.label, href: home.href } : null,
      columnBacked: home.kind === 'column',
    };
  });

  // Worst first, and within a status the mandatory ones first: the operator
  // should not have to read the whole list to find what grounds the vehicle.
  return rows.sort(
    (a, b) =>
      RANK[a.status] - RANK[b.status] ||
      Number(b.mandatory) - Number(a.mandatory) ||
      a.label.localeCompare(b.label),
  );
}

/**
 * True when a mandatory document has actually lapsed.
 *
 * This is the one that corresponds to reality: an expired mandatory document
 * raises a `vehicle_compliance_expiry` obligation, and that type is in
 * `BLOCKING_TYPES`, so the vehicle genuinely cannot be assigned.
 */
export function hasExpiredMandatory(rows: readonly ComplianceViewRow[]): boolean {
  return rows.some((r) => r.mandatory && r.status === 'expired');
}

/**
 * True when a mandatory document has never been entered.
 *
 * Deliberately separate from `hasExpiredMandatory`, because the system does NOT
 * block on this and must not claim to: a document with no date raises no
 * obligation, so a freshly imported vehicle with a blank MOT field stays
 * assignable. Saying "not road legal" there would assert something the sweep
 * contradicts — and the paperwork is probably in a folder in the office. What is
 * true is that nobody has told the system, which is what the screen says.
 */
export function hasOutstandingMandatory(rows: readonly ComplianceViewRow[]): boolean {
  return rows.some((r) => r.mandatory && r.status === 'missing');
}
