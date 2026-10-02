/**
 * IAM — fine-grained, application-layer authorization. The database's RLS is the
 * hard security boundary (tenant isolation + coarse role); this layer decides
 * what a member can *do* within their tenant (which buttons, which actions), and
 * is what the UI and server actions check.
 *
 * A member's effective permissions = their role's defaults ∪ any explicit extra
 * grants stored on their membership (tenant_memberships.permissions). That lets a
 * tenant admin grant a specific person a little more than their role, without
 * inventing a new role.
 */

export const PERMISSIONS = [
  'fleet.read',
  'fleet.write',
  'drivers.read',
  'drivers.write',
  'agreements.read',
  'agreements.write',
  'agreements.send', // start an online signing flow
  'billing.read',
  'billing.write',
  'payments.record',
  'compliance.read',
  'compliance.write',
  'pcn.transfer',
  'bookings.read',
  'bookings.write',
  'reports.operational',
  'reports.board', // MD / director board packs
  'reports.investor',
  'members.manage', // IAM: invite/change members & permissions
  'tenant.settings',
  'subscription.manage', // billing plan
  'audit.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type Role =
  | 'owner'
  | 'tenant_admin'
  | 'md'
  | 'director_exec'
  | 'director_nonexec'
  | 'ops'
  | 'accounts'
  | 'driver'
  | 'investor'
  | 'vehicle_owner';

const ALL: Permission[] = [...PERMISSIONS];
const READS: Permission[] = ['fleet.read', 'drivers.read', 'agreements.read', 'billing.read', 'compliance.read'];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  // Full control of the tenant.
  owner: ALL,
  tenant_admin: ALL,
  md: ALL,
  // Executive director: full oversight (all reads, board reports, audit) plus
  // finance authority.
  director_exec: [...READS, 'reports.operational', 'reports.board', 'audit.read', 'billing.write'],
  // Non-executive director: governance oversight only — read + board packs + audit,
  // no write anywhere.
  director_nonexec: [...READS, 'reports.operational', 'reports.board', 'audit.read'],
  // Day-to-day operations.
  ops: [
    ...READS,
    'fleet.write',
    'drivers.write',
    'agreements.write',
    'agreements.send',
    'payments.record',
    'compliance.write',
    'pcn.transfer',
    'bookings.read',
    'bookings.write',
    'reports.operational',
  ],
  // Finance function.
  accounts: [...READS, 'billing.write', 'payments.record', 'reports.operational'],
  // Scoped portals — their own data only (enforced by RLS); no back-office perms.
  driver: [],
  investor: ['reports.investor'],
  // A vehicle owner's portal membership — RLS scopes them; no back-office perms.
  vehicle_owner: [],
};

/** The full set of permissions a member holds: role defaults plus extra grants. */
export function effectivePermissions(role: string, extra: readonly string[] = []): Set<Permission> {
  const base = ROLE_PERMISSIONS[role as Role] ?? [];
  const set = new Set<Permission>(base);
  for (const p of extra) if ((PERMISSIONS as readonly string[]).includes(p)) set.add(p as Permission);
  return set;
}

/** Does a member with this role (+ extra grants) hold `perm`? */
export function can(role: string, extra: readonly string[], perm: Permission): boolean {
  return effectivePermissions(role, extra).has(perm);
}

export const ASSIGNABLE_ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];
export function isValidRole(role: string): role is Role {
  return (ASSIGNABLE_ROLES as string[]).includes(role);
}

export type MemberStatus = 'active' | 'disabled';
export function isAssignableStatus(status: string): status is MemberStatus {
  return status === 'active' || status === 'disabled';
}

/**
 * Guard role assignment against privilege escalation: the role must be valid, and
 * the powerful `owner` / `tenant_admin` roles may only be granted by a caller who
 * already holds that level. Throws otherwise.
 */
export function assertAssignableRole(role: string, callerRole: string | null | undefined): void {
  if (!isValidRole(role)) throw new Error(`Invalid role: ${role}`);
  if (role === 'owner' && callerRole !== 'owner') {
    throw new Error('Only an owner can assign the owner role.');
  }
  if (role === 'tenant_admin' && callerRole !== 'owner' && callerRole !== 'tenant_admin') {
    throw new Error('Only an owner or admin can assign the admin role.');
  }
}
