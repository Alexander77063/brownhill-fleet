/**
 * United Kingdom.
 *
 * This pack is today's hardcoded behaviour, lifted verbatim — 20% VAT, GBP
 * formatted en-GB, MOT/DVLA obligations, ULEZ and congestion charges,
 * GoCardless direct debit. Nothing here is new. If this pack and the old
 * constants in `src/lib/money.ts` ever disagree, the old constants were right
 * and this is the bug: `tests/unit/money-region.test.ts` pins them together.
 */
import { intlCurrency, type RegionProvider } from './types';

export const UK: RegionProvider = {
  id: 'uk',
  label: 'United Kingdom',
  timezone: 'Europe/London',

  currency: {
    code: 'GBP',
    symbol: '£',
    minorPerMajor: 100,
    minorName: 'pence',
    locale: 'en-GB',
    format: intlCurrency('GBP', 'en-GB'),
  },

  tax: {
    vatRate: 0.2,
    returnName: 'VAT Return (9-box)',
    authority: 'HMRC',
    withholdingTax: false,
  },

  vehicleCompliance: [
    {
      key: 'mot',
      label: 'MOT certificate',
      cadence: 'annual',
      mandatory: true,
      authority: 'DVSA',
      // Predates the region packs: the agreement PDF and the CSV importer both
      // use this column, so it stays the one place an MOT date lives.
      column: 'mot_due_on',
    },
    {
      key: 'road_tax',
      label: 'Vehicle tax',
      cadence: 'annual',
      mandatory: true,
      authority: 'DVLA',
      column: 'ved_renewal_on',
    },
    {
      key: 'insurance',
      label: 'Insurance',
      cadence: 'annual',
      mandatory: true,
      authority: 'Insurer',
    // Cover is held per driver in this codebase — the hirer insures, not the
    // fleet — so this is a pointer, not an input.
    managedOn: { label: 'the driver record', href: '/ops/drivers' },
    },
    {
      key: 'phv_licence',
      label: 'PHV vehicle licence',
      cadence: 'annual',
      mandatory: true,
      authority: 'TfL / local authority',
    },
  ],

  // These keys are also `driver_documents.kind` values, so they match the strings
  // already stored: renaming them would orphan every document filed to date.
  driverCompliance: [
    {
      key: 'driving_licence',
      label: 'Driving licence',
      cadence: 'variable',
      mandatory: true,
      authority: 'DVLA',
    },
    {
      key: 'pco_licence',
      label: 'PCO / PHV driver licence',
      cadence: 'triennial',
      mandatory: true,
      authority: 'TfL / local authority',
      // Uploading one writes through to this column, which carries its own
      // blocking obligation type — so the planner must not raise a second.
      column: 'pco_licence_expiry',
    },
    { key: 'dbs', label: 'DBS check', cadence: 'triennial', mandatory: true, authority: 'DBS' },
  ],

  // DVLA licences are re-checked every six months; the interval is the
  // obligation, not an expiry date on a document.
  driverLicenceRecheck: { label: 'DVLA licence check', intervalDays: 183 },

  roadCharges: [
    { key: 'ulez', label: 'ULEZ', transferable: true },
    { key: 'congestion', label: 'Congestion charge', transferable: true },
    { key: 'dartford', label: 'Dart Charge', transferable: true },
    { key: 'airport', label: 'Airport drop-off', transferable: true },
    { key: 'pcn', label: 'Penalty charge notice', transferable: true },
  ],

  identity: {
    primaryIdKey: 'dvla_licence_number',
    primaryIdLabel: 'Driving licence number',
    automatedCheck: true,
  },

  paymentProviders: ['gocardless', 'stripe'],
  smsProvider: 'twilio',
  lookups: { key: 'dvla_ves', label: 'DVLA Vehicle Enquiry Service' },
  billing: { defaultPlanKey: 'trial', initialStatus: 'trialing' },
  phone: { countryCode: '+44', trunkPrefix: '0', example: '+44 7700 900000' },
};
