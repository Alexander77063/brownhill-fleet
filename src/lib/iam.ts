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
  // Day-to-day operations. Every write permission + the settings/member/admin
  // surfaces: a single-operator deployment has no separate admin role, so the
  // ops user IS the admin and must be able to edit everything in /ops —
  // branding, billing, members, subscription, audit. (Reports still gated to
  // the board-level roles since those are investor-facing.)
  ops: [
    ...READS,
    'fleet.write',
    'drivers.write',
    'agreements.write',
    'agreements.send',
    'payments.record',
    'billing.write',
    'compliance.write',
    'pcn.transfer',
    'bookings.read',
    'bookings.write',
    'reports.operational',
    'reports.board',
    'tenant.settings',
    'members.manage',
    'subscription.manage',
    'audit.read',
  ],
  // Finance function. The plan / spec said "view billing, expenses, VAT,
  // income, anything the accountant needs" — the per-member grant UI
  // (commit f3ed771) lets the ops admin pick exactly what each accountant
  // sees. The role defaults give a working baseline for a single-operator
  // deployment where the accountant is the trusted finance lead.
  // `tenant.settings` is required by the HMRC MTD settings page; `audit.read`
  // is required by the per-page action guards in src/lib/accounting/*.
  accounts: [
    ...READS,
    'billing.write',
    'payments.record',
    'reports.operational',
    'tenant.settings',
    'audit.read',
  ],
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

/**
 * The portal a member lands in, given the TENANT role they were added under.
 *
 * ## Why this is not the same list as the tenant roles
 *
 * A tenant role says what the person may DO; a portal role says which app
 * they open. They are separate vocabularies, and the account's portal role and
 * its membership role are allowed to differ — that is exactly how the first
 * account on a box is created: an 'ops' profile with an 'owner' membership
 * (see `createFirstUserAndTenant`). The membership decides what they may do;
 * the profile decides where they land.
 *
 * ## Why 'owner' maps to 'ops' and not to 'owner'
 *
 * `handle_new_user` maps a raw 'owner' to the VEHICLE-owner portal, because
 * the vehicle-owner sign-up path creates its account with that role. But
 * 'owner' is ALSO the tenant's own full-control role, and it is the FIRST
 * entry in the admin form's role dropdown. Sending a colleague who was added
 * as the tenant owner to the vehicle-owner portal would route them to a portal
 * this deployment does not have at all (`ownerPortal` is false on saas,
 * standalone and hosted) — they would sign in and be turned away.
 *
 * The tenant owner operates the business, so they belong on the operations
 * desk, which is where the first account of every box already goes.
 *
 * The trigger remains the database's own safety net for any path that does
 * not come through here; this map is what the application uses when it
 * provisions an account itself.
 */
export type PortalRole = 'ops' | 'accounts' | 'driver' | 'investor' | 'owner';

const PORTAL_BY_TENANT_ROLE: Record<Role, PortalRole> = {
  owner: 'ops',
  tenant_admin: 'ops',
  md: 'ops',
  director_exec: 'accounts',
  director_nonexec: 'accounts',
  ops: 'ops',
  accounts: 'accounts',
  driver: 'driver',
  investor: 'investor',
  vehicle_owner: 'owner',
};

/**
 * The portal for a tenant role. An unknown role falls back to 'driver', which
 * is the same default the sign-up trigger uses — the least-privileged portal.
 */
export function portalRoleFor(tenantRole: string): PortalRole {
  return PORTAL_BY_TENANT_ROLE[tenantRole as Role] ?? 'driver';
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

/**
 * Guard a password reset against privilege escalation.
 *
 * Resetting somebody's password lets you sign in as them, so the rule is the
 * same rule that governs handing out the role in the first place: you may
 * reset the password of a member whose role you could have assigned. Without
 * this, the role-assignment guard would be a door with no lock on it — an ops
 * user who could not make somebody an owner could still take the owner's
 * password and be one.
 *
 * The two rules are deliberately kept in step; a test asserts that this
 * function refuses exactly the combinations `assertAssignableRole` refuses.
 */
export function assertCanResetPassword(
  memberRole: string,
  callerRole: string | null | undefined,
): void {
  if (!isValidRole(memberRole)) throw new Error(`Invalid role: ${memberRole}`);
  if (memberRole === 'owner' && callerRole !== 'owner') {
    throw new Error('Only an owner can reset the password for an owner account.');
  }
  if (
    memberRole === 'tenant_admin' &&
    callerRole !== 'owner' &&
    callerRole !== 'tenant_admin'
  ) {
    throw new Error('Only an owner or admin can reset the password for an admin account.');
  }
}
