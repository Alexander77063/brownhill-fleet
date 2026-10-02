/**
 * The operating defaults for subscription collection.
 *
 * THIS IS THE ONLY FILE IN src/ THAT MAY HOLD THESE NUMBERS. Everything else
 * reads them through `platformSettings()` (./settings.ts), which overlays the
 * console's `platform_settings` rows. The values below are the user's decisions
 * of 2026-09-05 and are what a fresh instance runs with until an operator edits
 * them in /platform/settings. `tests/unit/no-hardcoded-prices.test.ts` fails the
 * build if a grace/cancel/due day count or a price literal appears anywhere else.
 */

export interface IssuerDetails {
  legalName: string;
  address: string;
  tin: string;
  vatNumber: string;
  email: string;
  phone: string;
}

export interface BankDetails {
  bankName: string;
  accountName: string;
  accountNumber: string;
}

export type GatewayId = 'paystack' | 'flutterwave';

export interface Settings {
  /** Who issues the invoice. Empty until set; issuing refuses while legalName is empty. */
  'invoice.issuer': IssuerDetails;
  /** Where a bank transfer goes. Empty until set. */
  'invoice.bank': BankDetails;
  /** Days a business (fleet/insurer) invoice has before it is due. */
  'collection.due_days_business': number;
  /** Days before the anniversary the renewal invoice is raised. */
  'collection.renewal_issue_days': number;
  /** Reminder offsets in days BEFORE the due date (renewals). */
  'collection.reminder_days_before': number[];
  /** Reminder offsets in days AFTER the due date (any unpaid invoice). */
  'collection.reminder_days_after': number[];
  /** Days after the anniversary before non-emergency service is suspended. */
  'collection.grace_days': number;
  /** Days after the anniversary before an unpaid subscription is cancelled. */
  'collection.cancel_days': number;
  /** Day of the month on which batched B2B additions are invoiced. */
  'collection.additions_batch_day': number;
  /** Which configured gateway to prefer; null = the region pack's order. */
  'collection.preferred_gateway': GatewayId | null;
  /** NG-3: months of free replacement after fitting (user: 12). */
  'hardware.warranty_months': number;
  /** NG-3: days from payment to fitting before a job is flagged overdue. */
  'hardware.install_sla_days': number;
  /** NG-3: an immobilise command is refused above this speed (km/h). */
  'hardware.immobilise_max_speed_kph': number;
  /** NG-3: and refused when the latest position is older than this (minutes). */
  'hardware.position_max_age_minutes': number;
  /** NG-3: a fitted unit silent this long after fitting is flagged on the readiness page (hours). */
  'hardware.first_ping_hours': number;
  /** NG-3: the installer's checklist, ticked at completion. */
  'hardware.checklist': string[];
}

export type SettingsKey = keyof Settings;

export const SETTINGS_DEFAULTS: Readonly<Settings> = {
  'invoice.issuer': { legalName: '', address: '', tin: '', vatNumber: '', email: '', phone: '' },
  'invoice.bank': { bankName: '', accountName: '', accountNumber: '' },
  'collection.due_days_business': 14,
  'collection.renewal_issue_days': 30,
  'collection.reminder_days_before': [30, 14, 7],
  'collection.reminder_days_after': [3, 7, 12],
  'collection.grace_days': 14,
  'collection.cancel_days': 60,
  'collection.additions_batch_day': 1,
  'collection.preferred_gateway': null,
  'hardware.warranty_months': 12,
  'hardware.install_sla_days': 7,
  'hardware.immobilise_max_speed_kph': 10,
  'hardware.position_max_age_minutes': 10,
  'hardware.first_ping_hours': 24,
  'hardware.checklist': [
    'Unit powered and LED steady',
    'Wiring concealed and fused',
    'Relay tested (Platinum)',
    'Vehicle starts and drives',
    'Customer shown the app',
    'Photos taken',
  ],
};
