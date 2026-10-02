/**
 * Nigeria.
 *
 * Written alongside the UK pack rather than after it, deliberately: an
 * abstraction validated by a single implementation is just the original code
 * with extra indirection. Every field below that the UK pack also has is a
 * field that would otherwise have become a scattered conditional.
 *
 * Notable divergences, each load-bearing:
 *  - VAT is 7.5% and filed with FIRS, and customers deduct withholding tax at
 *    source — a concept the UK finance model does not have at all.
 *  - A certificate of roadworthiness (VIO) replaces the MOT, and a vehicle
 *    additionally needs a vehicle licence and proof of ownership; commercial
 *    use needs a hackney permit.
 *  - There is no public vehicle-registration lookup equivalent to DVLA VES, so
 *    `lookups` is null and registration details are entered by hand.
 *  - Direct debit is not a meaningful collection rail. Cards, bank transfers
 *    and the Paystack/Flutterwave gateways are.
 */
import { intlCurrency, type RegionProvider } from './types';

export const NG: RegionProvider = {
  id: 'ng',
  label: 'Nigeria',
  timezone: 'Africa/Lagos',

  currency: {
    code: 'NGN',
    symbol: '₦',
    minorPerMajor: 100,
    minorName: 'kobo',
    locale: 'en-NG',
    format: intlCurrency('NGN', 'en-NG'),
  },

  tax: {
    vatRate: 0.075,
    returnName: 'VAT Return',
    authority: 'FIRS',
    withholdingTax: true,
  },

  vehicleCompliance: [
    {
      key: 'roadworthiness',
      label: 'Certificate of roadworthiness',
      cadence: 'annual',
      mandatory: true,
      authority: 'VIO',
    },
    {
      key: 'vehicle_licence',
      label: 'Vehicle licence',
      cadence: 'annual',
      mandatory: true,
      authority: 'State board of internal revenue',
    },
    {
      key: 'insurance',
      label: 'Insurance',
      cadence: 'annual',
      mandatory: true,
      authority: 'Insurer / NAICOM',
    // Cover is held per driver in this codebase — the hirer insures, not the
    // fleet — so this is a pointer, not an input.
    managedOn: { label: 'the driver record', href: '/ops/drivers' },
    },
    {
      key: 'proof_of_ownership',
      label: 'Proof of ownership certificate',
      cadence: 'once',
      mandatory: true,
      authority: 'State licensing authority',
    },
    {
      key: 'hackney_permit',
      label: 'Hackney permit',
      cadence: 'annual',
      mandatory: false,
      authority: 'State licensing authority',
    },
    {
      key: 'cmr',
      label: 'Central Motor Registry record',
      cadence: 'once',
      mandatory: false,
      authority: 'Nigeria Police CMR',
    },
  ],

  driverCompliance: [
    {
      key: 'frsc_licence',
      label: "Driver's licence",
      cadence: 'variable',
      mandatory: true,
      authority: 'FRSC',
    },
    {
      key: 'nin',
      label: 'National Identification Number',
      cadence: 'once',
      mandatory: true,
      authority: 'NIMC',
    },
    {
      key: 'lasdri',
      label: 'LASDRI card',
      cadence: 'annual',
      mandatory: false,
      authority: 'LASDRI (Lagos)',
    },
  ],

  // Nigeria has no national licence-checking service to re-check against.
  driverLicenceRecheck: null,

  roadCharges: [
    { key: 'toll', label: 'Toll gate', transferable: true },
    { key: 'parking', label: 'Parking fee', transferable: true },
    { key: 'traffic_fine', label: 'Traffic fine', transferable: true },
  ],

  identity: {
    primaryIdKey: 'nin',
    primaryIdLabel: 'National Identification Number (NIN)',
    automatedCheck: false,
  },

  paymentProviders: ['paystack', 'flutterwave', 'bank_transfer'],
  smsProvider: 'termii',
  lookups: null,
  // Annual Standard: monthly rows are deactivated (NG-2). Under pay-first the
  // default plan is only a placeholder until the owner chooses tier and term at
  // first payment, so it carries no money consequence.
  billing: { defaultPlanKey: 'ng_standard_year', initialStatus: 'unpaid' },
  phone: { countryCode: '+234', trunkPrefix: '0', example: '+234 803 000 0000' },
};
