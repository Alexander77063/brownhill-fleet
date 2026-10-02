/**
 * Everything that differs between countries, in one interface.
 *
 * This exists because the UK specifics are pervasive — at the time of writing
 * VAT appears in 58 files, PCO in 42, DVLA in 32, PCN in 31 and MOT in 24.
 * Threading `if (region === 'ng')` through 49 pages would be unmaintainable and
 * would rot the moment a third country appeared. Instead every country-specific
 * fact is *data* on a pack, and application code asks the pack rather than
 * branching on where it is running.
 *
 * `tests/unit/region-encapsulation.test.ts` fails the build if a region
 * conditional escapes this directory.
 */
import type { RegionId } from '@/lib/deployment/profile';

export interface CurrencySpec {
  /** ISO 4217, e.g. 'GBP', 'NGN'. */
  readonly code: string;
  /** Display symbol, e.g. '£', '₦'. */
  readonly symbol: string;
  /** Minor units per major unit — 100 for both pence and kobo. */
  readonly minorPerMajor: number;
  /** What the minor unit is called in a form label: 'pence', 'kobo'. */
  readonly minorName: string;
  /** BCP 47 locale used for grouping and separators. */
  readonly locale: string;
  /** Format an integer minor-unit amount for display. */
  format(minor: number, opts?: { showMinor?: boolean }): string;
}

export interface TaxRegime {
  /** Standard-rate VAT as a fraction, e.g. 0.2 or 0.075. */
  readonly vatRate: number;
  /** What the periodic return is called in this jurisdiction. */
  readonly returnName: string;
  /** The authority the return is filed with, for display. */
  readonly authority: string;
  /**
   * Whether customers deduct tax at source when paying a supplier. Nigeria
   * does; the UK model has no concept of it, which is why it is a flag here
   * rather than an assumption baked into the finance code.
   */
  readonly withholdingTax: boolean;
}

/** How often a compliance document must be renewed. */
export type ObligationCadence = 'annual' | 'biennial' | 'triennial' | 'once' | 'variable';

export interface ObligationSpec {
  /** Stable machine key, unique within a pack. Stored in the DB. */
  readonly key: string;
  /** What an operator calls it. */
  readonly label: string;
  readonly cadence: ObligationCadence;
  /** True when operating without it is illegal rather than merely unwise. */
  readonly mandatory: boolean;
  /** Which authority issues or enforces it, for display. */
  readonly authority: string;
  /**
   * A column on `vehicles` or `drivers` that already holds this date.
   *
   * A few documents predate the region packs and have dedicated columns which
   * other code reads — the agreement PDF prints `mot_due_on`, the CSV importer
   * fills it. Naming that column here keeps one source of truth per document:
   * the compliance screen writes the column instead of creating a second,
   * independently-expiring `vehicle_compliance` row for the same certificate.
   */
  readonly column?: DateColumn;
  /**
   * Set when another screen owns this document entirely.
   *
   * Insurance is the case that matters: both packs list it as a vehicle
   * obligation, but in this codebase cover is held per driver
   * (`insurance_certificates.driver_id`) because the hirer insures. Recording it
   * against the vehicle would ground a vehicle whose driver is in fact covered.
   */
  readonly managedOn?: { readonly label: string; readonly href: string };
}

/** Columns on `vehicles` that hold a compliance date. */
export type VehicleDateColumn = 'mot_due_on' | 'ved_renewal_on';

/**
 * Columns on `drivers` that hold a compliance date.
 *
 * `dvla_checked_on` is deliberately absent: the DVLA re-check is a recurring
 * interval (183 days from the last check), not a document that expires, and it
 * already has its own obligation type and its own bespoke logic in
 * `compliance.ts`. Listing it as a document this country requires would make the
 * driver screen report "not recorded" for a driver whose check is perfectly
 * current, because the check date lives on `drivers` and never produces a
 * `driver_documents` row.
 */
export type DriverDateColumn = 'pco_licence_expiry';

/** Any column that is the single home for a compliance date. */
export type DateColumn = VehicleDateColumn | DriverDateColumn;

const VEHICLE_DATE_COLUMNS: readonly DateColumn[] = ['mot_due_on', 'ved_renewal_on'];
const DRIVER_DATE_COLUMNS: readonly DateColumn[] = ['pco_licence_expiry'];

/**
 * Which table a column belongs to.
 *
 * `ObligationSpec` is shared by the vehicle and driver lists, so its `column`
 * covers both tables. These narrow it back at the point of writing: a pack that
 * put a driver column on a vehicle obligation would otherwise typecheck and then
 * update a column that does not exist on `vehicles`.
 */
export function isVehicleDateColumn(c: DateColumn): c is VehicleDateColumn {
  return VEHICLE_DATE_COLUMNS.includes(c);
}

export function isDriverDateColumn(c: DateColumn): c is DriverDateColumn {
  return DRIVER_DATE_COLUMNS.includes(c);
}

/**
 * Where one document's dates actually live.
 *
 * Every obligation has exactly one home. `record` is the default because a
 * newly added key has no dedicated column and so cannot collide with one.
 */
export type StorageHome =
  | { readonly kind: 'record' }
  | { readonly kind: 'column'; readonly column: DateColumn }
  | { readonly kind: 'elsewhere'; readonly label: string; readonly href: string };

/**
 * Resolve a spec's storage home, refusing an ambiguous one.
 *
 * Two homes for a document means two expiry dates that drift apart, and
 * `vehicle_compliance_expiry` blocks dispatch — so a pack that claims both is a
 * bug to fail on, not to guess about.
 */
export function storageHome(spec: ObligationSpec): StorageHome {
  if (spec.column && spec.managedOn) {
    throw new Error(
      `Obligation "${spec.key}" claims both a vehicle column and another owning screen; it can only have one.`,
    );
  }
  if (spec.column) return { kind: 'column', column: spec.column };
  if (spec.managedOn) return { kind: 'elsewhere', ...spec.managedOn };
  return { kind: 'record' };
}

/**
 * A recurring re-check of a driver's licence against a national database.
 *
 * The UK has one: DVLA licences must be re-checked periodically, and that is an
 * interval since the last check, not a document that expires. Nigeria has no
 * equivalent service, so its pack sets this to null — without which every
 * Nigerian driver is raised as overdue for a DVLA check the moment they are
 * added, and `dvla_check` is a blocking type, so the whole workforce is
 * undispatchable on day one.
 */
export interface LicenceRecheckSpec {
  /** What operators call it, for the obligation title. */
  readonly label: string;
  /** Days between checks. */
  readonly intervalDays: number;
}

export interface RoadChargeSpec {
  readonly key: string;
  readonly label: string;
  /** True when a charge of this kind can be passed on to the hirer. */
  readonly transferable: boolean;
}

export interface IdentityVerificationSpec {
  /** The national identifier a person is checked against. */
  readonly primaryIdKey: string;
  readonly primaryIdLabel: string;
  /** Whether an automated lookup exists, or it is manual document review. */
  readonly automatedCheck: boolean;
}

export type PaymentProviderId =
  | 'stripe'
  | 'gocardless'
  | 'paystack'
  | 'flutterwave'
  | 'bank_transfer';

export type SmsProviderId = 'twilio' | 'termii';

export interface VehicleLookupSpec {
  readonly key: string;
  readonly label: string;
}

export interface BillingSpec {
  /**
   * The `plans.key` a newly created tenant is subscribed to.
   *
   * The UK SaaS starts everyone on a trial; Nigeria has no trial and starts a
   * tenant on the entry tier so entitlement gating works from the first
   * request. Which plan that is belongs to the market, not to `createTenant`.
   */
  readonly defaultPlanKey: string;
  /**
   * The status a brand-new tenant's subscription starts in.
   *
   * The UK SaaS starts on a trial. Nigeria is pay-first — "nothing works until
   * money is received" (user, 2026-09-05) — so a new tenant is `unpaid`: it can
   * add vehicles and see its first invoice, and nothing else, until that invoice
   * is paid. Entitlements read this status (src/lib/entitlements).
   */
  readonly initialStatus: 'trialing' | 'unpaid';
}

export interface PhoneSpec {
  /** E.164 country calling code, e.g. '+234'. */
  readonly countryCode: string;
  /** Digit a national number starts with that is dropped in E.164 ('0' for both). */
  readonly trunkPrefix: string;
  /** A placeholder shown in phone fields, in the local display style. */
  readonly example: string;
}

export interface RegionProvider {
  readonly id: RegionId;
  readonly label: string;
  /** IANA zone for customer-facing times (SMS booking confirmations). */
  readonly timezone: string;
  readonly currency: CurrencySpec;
  readonly tax: TaxRegime;
  readonly vehicleCompliance: readonly ObligationSpec[];
  readonly driverCompliance: readonly ObligationSpec[];
  /** Null where no national licence-checking service exists (Nigeria). */
  readonly driverLicenceRecheck: LicenceRecheckSpec | null;
  readonly roadCharges: readonly RoadChargeSpec[];
  readonly identity: IdentityVerificationSpec;
  readonly paymentProviders: readonly PaymentProviderId[];
  readonly smsProvider: SmsProviderId;
  /** Null where no public vehicle-registration lookup exists (Nigeria). */
  readonly lookups: VehicleLookupSpec | null;
  readonly billing: BillingSpec;
  readonly phone: PhoneSpec;
}

/**
 * Build an Intl-backed formatter for a currency. Shared by every pack so
 * rounding and grouping behave identically everywhere, and division by 100 —
 * the only place a money value stops being an integer — happens once.
 */
export function intlCurrency(code: string, locale: string): CurrencySpec['format'] {
  return (minor, opts = {}) => {
    const showMinor = opts.showMinor ?? true;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: showMinor ? 2 : 0,
      maximumFractionDigits: showMinor ? 2 : 0,
    }).format(minor / 100);
  };
}
