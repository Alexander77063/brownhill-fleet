/**
 * The store the operator's password reset reads through.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * It used to live inside `src/lib/actions/reset-password.ts`, which is a
 * `'use server'` file — and a `'use server'` file may only export async
 * functions. The store could therefore not be exported, and could not be
 * unit-tested. So the fail-closed behaviour that keeps the reset inside the
 * caller's authority was asserted in a comment and nowhere else.
 *
 * Splitting the data access out fixes that: the database client is injected,
 * so the real production store can be driven by a fake reader in
 * `tests/unit/password-reset-store.test.ts` — including the proof that a
 * failed read writes no password.
 *
 * WHY EVERY READ CHECKS ITS ERROR
 * -------------------------------
 * PostgREST answers a failed query with `{ data: null, error }`. Reading
 * `data` and ignoring `error` turns a database that could not be reached into
 * a table that happened to be empty.
 *
 * That distinction is the whole security question for this store. The
 * cross-tenant guard on a reset works by asking for EVERY membership the
 * target holds; an empty list skips the guard, so the reset proceeds exactly
 * as it did before the guard existed. A read that did not complete must
 * therefore be an error, never an empty list.
 */
import type { PasswordResetStore, ResetMember } from '@/lib/auth/password-reset';

/** What PostgREST returns: rows, or an error. Never both. */
export interface PostgrestResult {
  data: unknown;
  error: { message: string } | null;
}

/** The slice of a PostgREST builder the store uses. */
export interface PostgrestBuilder extends PromiseLike<PostgrestResult> {
  eq(column: string, value: string): PostgrestBuilder;
  maybeSingle(): Promise<PostgrestResult>;
}

/**
 * The slice of the Supabase client the store uses.
 *
 * Narrower than the real client on purpose: the store touches two tables
 * through two query shapes, and this says exactly which. The real client
 * satisfies it structurally, so the one place they meet is a single cast.
 */
export interface PostgrestReader {
  from(table: string): { select(columns: string): PostgrestBuilder };
}

/** A membership row, as the database spells it. */
interface MembershipRow {
  tenant_id: string;
  role: string;
  status: string;
}

/** A membership row for one member, as the database spells it. */
interface MemberRow {
  user_id: string;
  role: string;
  status: string;
}

/** A profile row, as the database spells it. */
interface ProfileRow {
  full_name: string | null;
  email: string | null;
}

/** Everything the store needs from the outside world. */
export interface PasswordResetStoreDeps {
  /** The database reader. */
  reader: PostgrestReader;
  /** Does this account hold a password at all? */
  hasPassword(userId: string): Promise<boolean>;
  /** Replace the password, and clear any lockout on the account. */
  setPassword(userId: string, password: string): Promise<void>;
  /** Deliver the temporary password. `sent: false` means it did not go. */
  deliver(
    member: ResetMember,
    password: string,
  ): Promise<{ sent: boolean; reason?: string }>;
}

/**
 * A read that reports an error is an error, not an empty list.
 *
 * The error is not swallowed and not downgraded to "no rows". It is raised,
 * and the reset refuses — because the checks that follow this read decide
 * whether one operator may open another person's account.
 */
function readRows<T>(result: PostgrestResult, what: string): T[] {
  if (result.error) {
    throw new Error(`Could not read ${what}: ${result.error.message}`);
  }
  return (result.data ?? []) as T[];
}

/** The same rule for a single row. A failed read is not "no such row". */
function readOne<T>(result: PostgrestResult, what: string): T | null {
  if (result.error) {
    throw new Error(`Could not read ${what}: ${result.error.message}`);
  }
  return (result.data ?? null) as T | null;
}

/**
 * The real store: the membership lookup is tenant-scoped, and the password
 * write goes through the direct connection that owns `auth.local_credentials`.
 */
export function makePasswordResetStore(deps: PasswordResetStoreDeps): PasswordResetStore {
  const { reader } = deps;

  return {
    async findMember(scopeTenantId, userId) {
      // The tenant filter is what makes this safe: a user id from another
      // tenant simply is not a member here, and nothing is reset.
      const membership = await readOne<MemberRow>(
        await reader
          .from('tenant_memberships')
          .select('user_id, role, status')
          .eq('tenant_id', scopeTenantId)
          .eq('user_id', userId)
          .maybeSingle(),
        'the member',
      );
      if (!membership) return null;

      const profile = await readOne<ProfileRow>(
        await reader
          .from('profiles')
          .select('full_name, email')
          .eq('id', userId)
          .maybeSingle(),
        'the profile',
      );

      return {
        userId: membership.user_id,
        role: membership.role,
        status: membership.status,
        fullName: profile?.full_name ?? null,
        email: profile?.email ?? null,
      } satisfies ResetMember;
    },

    async findMemberships(userId) {
      // Every tenant this person belongs to, not just this one.
      //
      // The password row is keyed by user id, so the credential is shared
      // across every tenant they hold. The guard needs the whole list to know
      // whether the caller has authority everywhere the reset lands — which is
      // why a failed read here is raised rather than read as "no others".
      const rows = await readRows<MembershipRow>(
        await reader
          .from('tenant_memberships')
          .select('tenant_id, role, status')
          .eq('user_id', userId),
        'the memberships',
      );
      return rows.map((m) => ({
        tenantId: m.tenant_id,
        role: m.role,
        status: m.status,
      }));
    },

    async hasPassword(userId) {
      return deps.hasPassword(userId);
    },

    async setPassword(userId, password) {
      await deps.setPassword(userId, password);
    },

    async deliverTemporaryPassword(member, password) {
      return deps.deliver(member, password);
    },
  };
}
