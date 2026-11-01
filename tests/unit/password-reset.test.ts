// tests/unit/password-reset.test.ts
//
// The operator's password reset, and the temporary password it hands out.
//
// WHY THIS TEST EXISTS
// --------------------
// Before this, the product had NO way to recover a forgotten password from
// inside the app:
//
//   * `/driver/login` said "Forgot password?" and linked to `/driver/profile`
//     — a page behind the driver layout, so a locked-out driver was bounced
//     straight back to the sign-in form in a loop.
//   * `/owner/login` said the same thing and linked to
//     `/owner/settings/security` — same dead end.
//   * The admin member page could change a role, a status and a set of extra
//     permissions, but not a password.
//   * The only mechanism that worked was `set-customer-password.mjs`, a script
//     on the box that needs SSH and a DATABASE_URL.
//
// A driver who forgot their password therefore had to phone the office, and
// the office had to SSH into the customer's server. That is not a recovery
// path; it is an incident.
//
// The fix is an in-app reset for the operator (the dispatcher or the business
// owner), and these tests pin the parts of it that are easy to get subtly
// wrong:
//
//   * the temporary password is strong enough and safe to read out over the
//     telephone;
//   * a member of ANOTHER tenant cannot be reset;
//   * a reset cannot be used to escalate privilege (resetting somebody's
//     password is signing in as them, so the rule is the same rule that
//     governs handing out the role in the first place);
//   * a failed email delivery does not undo the reset — the operator reads
//     the password off the screen instead.
//
// The store is injected, so every branch runs without a database — the same
// shape `src/lib/auth/owner-signin.ts` uses.

import { describe, expect, it, vi } from 'vitest';
import {
  generateTemporaryPassword,
  resetMemberPassword,
  TEMP_PASSWORD_LENGTH,
  type PasswordResetStore,
  type ResetMember,
} from '@/lib/auth/password-reset';
import { assertAssignableRole, assertCanResetPassword } from '@/lib/iam';

const ALPHABET = '023456789abcdefghjkmnpqrstuvwxyz';

const MEMBER: ResetMember = {
  userId: '11111111-1111-1111-1111-111111111111',
  email: 'driver@example.test',
  fullName: 'Alex Driver',
  role: 'driver',
  status: 'active',
};

/** A store that records what it was asked to do. */
function makeStore(over: Partial<PasswordResetStore> = {}) {
  const calls = {
    findMember: [] as Array<[string, string]>,
    hasPassword: [] as string[],
    setPassword: [] as Array<[string, string]>,
    deliver: [] as Array<[string, string]>,
  };
  const store: PasswordResetStore = {
    async findMember(tenantId, userId) {
      calls.findMember.push([tenantId, userId]);
      return MEMBER;
    },
    async hasPassword(userId) {
      calls.hasPassword.push(userId);
      return true;
    },
    async setPassword(userId, password) {
      calls.setPassword.push([userId, password]);
    },
    async deliverTemporaryPassword(member, password) {
      calls.deliver.push([member.userId, password]);
      return { sent: true };
    },
    ...over,
  };
  return { store, calls };
}

describe('generateTemporaryPassword', () => {
  it('is the advertised length', () => {
    expect(generateTemporaryPassword()).toHaveLength(TEMP_PASSWORD_LENGTH);
  });

  it('uses only characters that are safe to read out over the telephone', () => {
    for (let i = 0; i < 200; i++) {
      for (const ch of generateTemporaryPassword()) {
        expect(ALPHABET, `"${ch}" is not in the readable alphabet`).toContain(ch);
      }
    }
  });

  it('leaves out the characters people confuse when reading them aloud', () => {
    // 1/i/l, and O/o. Zero is kept, because capital O and lowercase o are not.
    for (const ch of '1iIlOo') {
      expect(ALPHABET).not.toContain(ch);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateTemporaryPassword()));
    expect(seen.size).toBe(500);
  });

  it('does not keep producing the same first character', () => {
    // A generator stuck on one character would still pass the uniqueness test
    // above if the rest varied, but it would be one character of entropy.
    const firsts = new Set(
      Array.from({ length: 200 }, () => generateTemporaryPassword()[0]),
    );
    expect(firsts.size).toBeGreaterThan(8);
  });
});

describe('resetMemberPassword', () => {
  it('refuses a member who is not in this tenant', async () => {
    const { store, calls } = makeStore({
      async findMember() {
        return null;
      },
    });

    const result = await resetMemberPassword({
      tenantId: 'tenant-a',
      userId: MEMBER.userId,
      callerRole: 'ops',
      store,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('not_found');
    // Nothing was touched.
    expect(calls.setPassword).toEqual([]);
    expect(calls.deliver).toEqual([]);
  });

  it('asks the store for the member within the caller\'s tenant', async () => {
    const { store, calls } = makeStore();
    await resetMemberPassword({
      tenantId: 'tenant-a',
      userId: MEMBER.userId,
      callerRole: 'ops',
      store,
    });
    expect(calls.findMember).toEqual([['tenant-a', MEMBER.userId]]);
  });

  it('refuses an account that has no password to reset', async () => {
    const { store, calls } = makeStore({
      async hasPassword() {
        return false;
      },
    });

    const result = await resetMemberPassword({
      tenantId: 'tenant-a',
      userId: MEMBER.userId,
      callerRole: 'ops',
      store,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('no_password');
    // The message must say what the person should actually do instead.
    expect(result.message).toMatch(/code sent to their phone/i);
    expect(calls.setPassword).toEqual([]);
  });

  it('sets the password and hands it back to the operator', async () => {
    const { store, calls } = makeStore();

    const result = await resetMemberPassword({
      tenantId: 'tenant-a',
      userId: MEMBER.userId,
      callerRole: 'ops',
      store,
      generate: () => 'generated-password',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a success');
    expect(result.temporaryPassword).toBe('generated-password');
    expect(calls.setPassword).toEqual([[MEMBER.userId, 'generated-password']]);
  });

  it('emails the temporary password when it can', async () => {
    const { store, calls } = makeStore();
    const result = await resetMemberPassword({
      tenantId: 'tenant-a',
      userId: MEMBER.userId,
      callerRole: 'ops',
      store,
      generate: () => 'generated-password',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a success');
    expect(result.emailed).toBe(true);
    expect(calls.deliver).toEqual([[MEMBER.userId, 'generated-password']]);
  });

  it('still succeeds when the email cannot be sent', async () => {
    // The reset has already happened by then. Failing the whole operation
    // would leave the operator thinking nothing changed, while the password
    // had in fact changed — and the user would be locked out of the account
    // they were told was untouched.
    const { store } = makeStore({
      async deliverTemporaryPassword() {
        return { sent: false, reason: 'not configured' };
      },
    });

    const result = await resetMemberPassword({
      tenantId: 'tenant-a',
      userId: MEMBER.userId,
      callerRole: 'ops',
      store,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a success');
    expect(result.emailed).toBe(false);
    // The password is still available to read off the screen.
    expect(result.temporaryPassword).toHaveLength(TEMP_PASSWORD_LENGTH);
  });

  it('survives an email service that throws', async () => {
    const { store } = makeStore({
      async deliverTemporaryPassword() {
        throw new Error('resend is down');
      },
    });

    const result = await resetMemberPassword({
      tenantId: 'tenant-a',
      userId: MEMBER.userId,
      callerRole: 'ops',
      store,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a success');
    expect(result.emailed).toBe(false);
  });

  it('reports a failed write without claiming success', async () => {
    const { store } = makeStore({
      async setPassword() {
        throw new Error('database is down');
      },
    });

    const result = await resetMemberPassword({
      tenantId: 'tenant-a',
      userId: MEMBER.userId,
      callerRole: 'ops',
      store,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('failed');
  });
});

describe('resetting a password does not escalate privilege', () => {
  const member = (role: string): ResetMember => ({ ...MEMBER, role });

  async function attempt(callerRole: string, memberRole: string) {
    const { store } = makeStore({
      async findMember() {
        return member(memberRole);
      },
    });
    return resetMemberPassword({
      tenantId: 'tenant-a',
      userId: MEMBER.userId,
      callerRole,
      store,
    });
  }

  it('lets an owner reset an owner', async () => {
    const result = await attempt('owner', 'owner');
    expect(result.ok).toBe(true);
  });

  it('stops an ops user resetting an owner', async () => {
    // Resetting somebody's password is signing in as them. If an ops user
    // could reset the owner's password, the escalation guard on role
    // assignment would be a door with no lock on it.
    const result = await attempt('ops', 'owner');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('forbidden');
  });

  it('stops an ops user resetting an admin', async () => {
    const result = await attempt('ops', 'tenant_admin');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('forbidden');
  });

  it('lets an admin reset an admin', async () => {
    const result = await attempt('tenant_admin', 'tenant_admin');
    expect(result.ok).toBe(true);
  });

  it('leaves ordinary members alone', async () => {
    const result = await attempt('ops', 'driver');
    expect(result.ok).toBe(true);
  });
});

describe('assertCanResetPassword', () => {
  it('refuses exactly the combinations assertAssignableRole refuses', () => {
    // Two doors, one rule: you may not hand out a role you could not assign,
    // and you may not reset the password of a role you could not assign.
    // If the two ever drift, this is where it shows.
    const roles = [
      'owner',
      'tenant_admin',
      'md',
      'director_exec',
      'director_nonexec',
      'ops',
      'accounts',
      'driver',
      'investor',
      'vehicle_owner',
    ];

    const assignable = (role: string, caller: string) => {
      try {
        assertAssignableRole(role, caller);
        return true;
      } catch {
        return false;
      }
    };
    const resettable = (role: string, caller: string) => {
      try {
        assertCanResetPassword(role, caller);
        return true;
      } catch {
        return false;
      }
    };

    for (const role of roles) {
      for (const caller of roles) {
        expect(resettable(role, caller), `${caller} resetting a ${role}`).toBe(
          assignable(role, caller),
        );
      }
    }
  });

  it('names the rule in the message', () => {
    expect(() => assertCanResetPassword('owner', 'ops')).toThrow(/only an owner/i);
    expect(() => assertCanResetPassword('tenant_admin', 'ops')).toThrow(/owner or admin/i);
  });

  it('rejects a role that does not exist', () => {
    expect(() => assertCanResetPassword('wizard', 'owner')).toThrow(/invalid role/i);
  });
});
