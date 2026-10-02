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
  ],
  driver: [
    { href: '/driver', label: 'Home', icon: 'wallet', primary: true },
    { href: '/driver/equity', label: 'My equity', icon: 'trending', primary: true, feature: 'rental.core' },
    { href: '/driver/insurance', label: 'Insurance', icon: 'shield', primary: true },
    { href: '/driver/charges', label: 'Charges', icon: 'alert', primary: true, feature: 'charges.reconciliation' },
    { href: '/driver/submit', label: 'Submit receipt', icon: 'upload', primary: true },
    { href: '/driver/payments', label: 'Payments', icon: 'receipt', feature: 'rental.core' },
    { href: '/driver/documents', label: 'Documents', icon: 'doc' },
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
  ],
  // Investor is deprecated as a login role — investor updates are now generated
  // on demand from the tenant's Reports page. Kept empty to satisfy the Record type.
  investor: [],
};

/** The items a tenant with `features` may see, in declared order. */
export function navFor(role: UserRole, features: ReadonlySet<string>): NavItem[] {
  return NAV[role].filter((i) => !i.feature || features.has(i.feature));
}

export const ROLE_LABEL: Record<UserRole, string> = {
  ops: 'Operations',
  driver: 'Driver',
  investor: 'Investor',
  owner: 'Vehicle owner',
};
