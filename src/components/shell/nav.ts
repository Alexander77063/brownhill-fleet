import type { IconName } from '@/components/icons';
import type { FeatureKey } from '@/lib/entitlements/features';
import type { UserRole } from '@/lib/supabase/database.types';

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** show in the mobile bottom bar (max 5) */
  primary?: boolean;
  /**
   * The entitlement that owns this surface. Listed only when the tenant has
   * it; absent means always listed. Hiding the link is not disabling the
   * feature — the route's layout enforces the same key.
   */
  feature?: FeatureKey;
}

/** Where each portal role lands after sign-in, and is bounced to when it strays. */
export const ROLE_HOME: Record<UserRole, string> = {
  ops: '/ops',
  accounts: '/accounts',
  driver: '/driver',
  investor: '/investor',
  owner: '/owner',
};

export const NAV: Record<UserRole, NavItem[]> = {
  ops: [
    { href: '/ops', label: 'Dashboard', icon: 'dashboard', primary: true },
    { href: '/ops/fleet', label: 'Fleet', icon: 'car', primary: true },
    { href: '/ops/drivers', label: 'Drivers', icon: 'users', primary: true },
    { href: '/ops/owners', label: 'Owners', icon: 'users' },
    { href: '/ops/agreements', label: 'Agreements', icon: 'signature', feature: 'rental.core' },
    { href: '/ops/rtb-calculator', label: 'RTB calculator', icon: 'pound', feature: 'rental.core' },
    { href: '/ops/bookings', label: 'Dispatch', icon: 'car', primary: true, feature: 'rental.core' },
    { href: '/ops/tracking', label: 'Live tracking', icon: 'trending', feature: 'gps.phone' },
    { href: '/ops/billing', label: 'Billing', icon: 'receipt', primary: true },
    { href: '/ops/compliance', label: 'Compliance', icon: 'shield', primary: true, feature: 'compliance' },
    { href: '/ops/charges', label: 'Charges', icon: 'alert', feature: 'charges.reconciliation' },
    { href: '/ops/maintenance', label: 'Maintenance', icon: 'wrench' },
    { href: '/ops/fuel', label: 'Fuel', icon: 'wallet', feature: 'fuel' },
    { href: '/ops/expenses', label: 'Expenses', icon: 'wallet' },
    { href: '/ops/finance', label: 'Finance & VAT', icon: 'pound' },
    { href: '/ops/reports', label: 'Reports', icon: 'trending', feature: 'reports.director' },
    { href: '/ops/assistant', label: 'Assistant', icon: 'dashboard' },
    { href: '/ops/import', label: 'Bulk import', icon: 'upload' },
    { href: '/ops/comms', label: 'Comms', icon: 'bell' },
    { href: '/ops/profile', label: 'Profile & security', icon: 'shield' },
  ],
  // Accountant portal — a finance-only view of the same data. Same permissions
  // back the page-level checks; the layout is what gives them a landing place.
  // The accounting/* group covers the in-app chart of accounts / journals /
  // bank reconciliation / reports / HMRC MTD surfaces (PRs #85–#94 brought
  // these in from upstream). Each sub-page re-gates on its own permission,
  // so a member with only `billing.read` still sees only the operational tiles.
  accounts: [
    { href: '/accounts', label: 'Dashboard', icon: 'dashboard', primary: true },
    { href: '/accounts/billing', label: 'Billing', icon: 'receipt', primary: true },
    { href: '/accounts/expenses', label: 'Expenses', icon: 'wallet', primary: true },
    { href: '/accounts/fuel', label: 'Fuel', icon: 'wallet', primary: true },
    { href: '/accounts/finance', label: 'Finance & VAT', icon: 'pound', primary: true },
    { href: '/accounts/accounting', label: 'Accounting', icon: 'pound' },
    { href: '/accounts/accounting/banks', label: '  Banks', icon: 'wallet' },
    { href: '/accounts/accounting/reconcile', label: '  Reconcile', icon: 'check' },
    { href: '/accounts/accounting/coa', label: '  Chart of accounts', icon: 'doc' },
    { href: '/accounts/accounting/periods', label: '  Periods', icon: 'clock' },
    { href: '/accounts/accounting/reports/pnl', label: '  P&L', icon: 'trending' },
    { href: '/accounts/accounting/reports/balance-sheet', label: '  Balance sheet', icon: 'doc' },
    { href: '/accounts/accounting/reports/cashflow', label: '  Cashflow', icon: 'trending' },
    { href: '/accounts/accounting/reports/ar-aging', label: '  AR aging', icon: 'clock' },
    { href: '/accounts/accounting/reports/vat-return', label: '  VAT return', icon: 'receipt' },
    { href: '/accounts/accounting/mtd', label: '  HMRC MTD', icon: 'shield' },
    { href: '/accounts/reports', label: 'Operational reports', icon: 'trending' },
    { href: '/accounts/profile', label: 'Profile & security', icon: 'shield' },
  ],
  driver: [
    { href: '/driver', label: 'Home', icon: 'wallet', primary: true },
    { href: '/driver/equity', label: 'My equity', icon: 'trending', primary: true, feature: 'rental.core' },
    { href: '/driver/insurance', label: 'Insurance', icon: 'shield', primary: true },
    { href: '/driver/charges', label: 'Charges', icon: 'alert', primary: true, feature: 'charges.reconciliation' },
    { href: '/driver/submit', label: 'Submit receipt', icon: 'upload', primary: true },
    { href: '/driver/report', label: 'Report damage', icon: 'alert' },
    { href: '/driver/payments', label: 'Payments', icon: 'receipt', feature: 'rental.core' },
    { href: '/driver/documents', label: 'Documents', icon: 'doc' },
    { href: '/driver/profile', label: 'Profile & security', icon: 'shield' },
  ],
  // A vehicle owner: their cars, their settings. Alerts, reports and help are
  // added by NG-4b. Copy is for a person about their car, never a "fleet".
  owner: [
    { href: '/owner', label: 'My vehicles', icon: 'car', primary: true },
    { href: '/owner/alerts', label: 'Alerts', icon: 'bell', primary: true },
    { href: '/owner/reports', label: 'Reports', icon: 'doc', primary: true },
    { href: '/owner/help', label: 'Help', icon: 'shield', primary: true },
    { href: '/owner/billing', label: 'Billing', icon: 'wallet', primary: true },
    { href: '/owner/settings', label: 'Settings', icon: 'wrench' },
    { href: '/owner/settings/security', label: 'Security', icon: 'shield' },
  ],
  // An investor: the rent-to-buy portfolio — what the business earns on the
  // book and the rate the rentees pay on it. Figures, not names: the read
  // goes through the PII-free investor views, so the database decides what an
  // investor may see.
  investor: [
    { href: '/investor', label: 'Portfolio', icon: 'trending', primary: true, feature: 'reports.investor' },
  ],
};

/** The items a tenant with `features` may see, in declared order. */
export function navFor(role: UserRole, features: ReadonlySet<string>): NavItem[] {
  return NAV[role].filter((i) => !i.feature || features.has(i.feature));
}

export const ROLE_LABEL: Record<UserRole, string> = {
  ops: 'Operations',
  accounts: 'Accounts',
  driver: 'Driver',
  investor: 'Investor',
  owner: 'Vehicle owner',
};
