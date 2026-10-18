/**
 * Shared UI labels for the permission grid in /admin and /admin/members/[id].
 *
 * The Permission union is the source of truth (see src/lib/iam.ts) — this file
 * adds the human-readable label and the category used to group the checkboxes
 * in the UI. Keeping it in one place means a new permission only needs to be
 * added once: the type union, and here.
 *
 * If a permission is in the union but missing from this list, the admin UI
 * will warn (and the value will be left alone on save) rather than hide it —
 * the schema is always the source of truth for what can be granted.
 */
import { PERMISSIONS, type Permission } from '@/lib/iam';

export interface PermissionLabel {
  /** The permission string, e.g. 'fleet.write'. */
  key: Permission;
  /** Short, sentence-case label for the checkbox. */
  label: string;
  /** Group for the UI — controls what section the checkbox appears under. */
  group:
    | 'Fleet'
    | 'Drivers'
    | 'Agreements'
    | 'Billing & payments'
    | 'Compliance'
    | 'Reports & audit'
    | 'Tenancy';
}

export const PERMISSION_CATALOG: readonly PermissionLabel[] = [
  // Fleet
  { key: 'fleet.read', label: 'View fleet', group: 'Fleet' },
  { key: 'fleet.write', label: 'Edit fleet', group: 'Fleet' },

  // Drivers
  { key: 'drivers.read', label: 'View drivers', group: 'Drivers' },
  { key: 'drivers.write', label: 'Invite / edit drivers', group: 'Drivers' },

  // Agreements & bookings
  { key: 'agreements.read', label: 'View agreements', group: 'Agreements' },
  { key: 'agreements.write', label: 'Edit agreements', group: 'Agreements' },
  { key: 'agreements.send', label: 'Send for signature', group: 'Agreements' },
  { key: 'bookings.read', label: 'View bookings', group: 'Agreements' },
  { key: 'bookings.write', label: 'Edit bookings', group: 'Agreements' },

  // Billing
  { key: 'billing.read', label: 'View billing', group: 'Billing & payments' },
  { key: 'billing.write', label: 'Edit billing', group: 'Billing & payments' },
  { key: 'payments.record', label: 'Record payments', group: 'Billing & payments' },

  // Compliance
  { key: 'compliance.read', label: 'View compliance', group: 'Compliance' },
  { key: 'compliance.write', label: 'Edit compliance', group: 'Compliance' },
  { key: 'pcn.transfer', label: 'Transfer PCNs', group: 'Compliance' },

  // Reports
  { key: 'reports.operational', label: 'Operational reports', group: 'Reports & audit' },
  { key: 'reports.board', label: 'Board reports', group: 'Reports & audit' },
  { key: 'reports.investor', label: 'Investor reports', group: 'Reports & audit' },
  { key: 'audit.read', label: 'Audit log', group: 'Reports & audit' },

  // Tenancy
  { key: 'tenant.settings', label: 'Branding & settings', group: 'Tenancy' },
  { key: 'members.manage', label: 'Manage members', group: 'Tenancy' },
  { key: 'subscription.manage', label: 'Manage subscription', group: 'Tenancy' },
];

/** Catalog keys, in declared order — handy for assertions in tests. */
export const PERMISSION_CATALOG_KEYS: readonly Permission[] = PERMISSION_CATALOG.map((p) => p.key);

/** Permissions the catalog doesn't know about — would surface as a schema drift. */
export const UNCATALOGED: readonly string[] = PERMISSIONS.filter(
  (p) => !PERMISSION_CATALOG_KEYS.includes(p as Permission),
);

/** Group permissions for the UI, in declared group order. */
export function groupPermissions(): { group: PermissionLabel['group']; items: PermissionLabel[] }[] {
  const out: { group: PermissionLabel['group']; items: PermissionLabel[] }[] = [];
  for (const p of PERMISSION_CATALOG) {
    let bucket = out.find((b) => b.group === p.group);
    if (!bucket) {
      bucket = { group: p.group, items: [] };
      out.push(bucket);
    }
    bucket.items.push(p);
  }
  return out;
}