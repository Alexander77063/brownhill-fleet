// tests/unit/password-reset-audit.test.ts
//
// The audit row for a SELF-SERVICE password reset.
//
// WHY THIS FILE EXISTS
// --------------------
// `docs/product/04-user-flow.md` says every reset is audited
// (`member.password_reset`). The OPERATOR's reset was — it went through
// `recordAudit`. The self-service reset was not: it changed a password and
// wrote nothing at all, so the trail had no record of the one thing a person
// does to their own account that an administrator might have to answer for.
//
// WHAT THE ROW SAYS
// -----------------
//   * the action is the same one the operator's reset writes — one action,
//     one meaning;
//   * the member is the account whose password changed;
//   * the ACTOR is the person themselves. They proved control of the address
//     on file by reading the link, so the row names them. The service
//     principal is deliberately not a user, and an audit row attributing a
//     password reset to a named employee would be a lie;
//   * it says the reset was self-service, because that is the difference
//     between "I forgot my password" and "the office reset it for me".
//
// WHERE IT IS FILED
// -----------------
// `public.audit_log.tenant_id` is NOT NULL and carries a foreign key to
// `tenants(id)`. A password opens an account in EVERY tenant the person
// belongs to, so the row is filed in each of them. An account that belongs
// to no tenant has nowhere to file it — and that is reported LOUDLY, because
// a reset that happened and left no trace is the exact failure the audit
// trail exists to prevent.
//
// The writer is injected, so the rule can be proved without a database. The
// route hands it `appendAudit` — the one place an audit row is written.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  auditPasswordReset,
  passwordResetAuditRows,
  type PasswordResetAuditRow,
} from '@/lib/auth/password-reset-audit';

const ACCOUNT = {
  userId: '11111111-1111-1111-1111-111111111111',
  role: 'driver',
  tenantIds: ['22222222-2222-2222-2222-222222222222'],
};

describe('the row a self-service reset writes', () => {
  it('is filed under every tenant the account belongs to', () => {
    // One credential opens the account in every tenant the person belongs
    // to, so the reset happened in every one of them.
    const rows = passwordResetAuditRows({ ...ACCOUNT, tenantIds: ['tenant-a', 'tenant-b'] });

    expect(rows.map((r) => r.tenantId)).toEqual(['tenant-a', 'tenant-b']);
  });

  it('records the reset as the member it was', () => {
    // The same action the operator's reset writes, so the trail has one
    // meaning for "a password was reset".
    const [row] = passwordResetAuditRows(ACCOUNT);

    expect(row.action).toBe('member.password_reset');
    expect(row.entityType).toBe('member');
    expect(row.entityId).toBe(ACCOUNT.userId);
  });

  it('names the person who reset it', () => {
    const [row] = passwordResetAuditRows(ACCOUNT);

    expect(row.actor).toBe(ACCOUNT.userId);
  });

  it('says it was a self-service reset', () => {
    // The difference between "I forgot my password" and "the office reset it
    // for me" is worth having in the trail.
    const [row] = passwordResetAuditRows(ACCOUNT);

    expect(row.detail).toMatchObject({ role: 'driver', selfService: true });
  });

  it('never carries the password, or the token', () => {
    // There is nowhere for a secret to go: the row has a fixed set of
    // fields, and the detail carries the role and the flag and nothing
    // else. (The ACTION is called `member.password_reset` — that is the
    // name of the thing that happened, not a credential.)
    const [row] = passwordResetAuditRows(ACCOUNT);

    expect(Object.keys(row).sort()).toEqual([
      'action',
      'actor',
      'detail',
      'entityId',
      'entityType',
      'tenantId',
    ]);
    expect(Object.keys(row.detail).sort()).toEqual(['role', 'selfService']);
  });

  it('files nothing for an account that belongs to no tenant', () => {
    expect(passwordResetAuditRows({ ...ACCOUNT, tenantIds: [] })).toEqual([]);
  });
});

describe('writing the row for a self-service reset', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes one row per tenant', async () => {
    const written: PasswordResetAuditRow[] = [];

    await auditPasswordReset({
      account: { ...ACCOUNT, tenantIds: ['tenant-a', 'tenant-b'] },
      write: async (row) => {
        written.push(row);
      },
    });

    expect(written).toHaveLength(2);
  });

  it('says so LOUDLY when the account belongs to no tenant', async () => {
    // There is no row that can be written: the tenant column is NOT NULL
    // and carries a foreign key. The reset still HAPPENED. A reset that
    // happened and left no trace is the exact failure this trail exists to
    // prevent, so it is reported rather than swallowed.
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    await auditPasswordReset({
      account: { ...ACCOUNT, tenantIds: [] },
      write: async () => {},
    });

    expect(logged.length, 'the missing audit row was not reported').toBe(1);
    expect(String(logged[0][0])).toContain('audit');
    expect(String(logged[0].join(' '))).toContain(ACCOUNT.userId);
  });

  it('does not let a failed write become somebody else’s error', async () => {
    // The password has already been changed. A refused audit row must not
    // turn a successful reset into an error the person sees — it has to be
    // reported, and nothing more.
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    await expect(
      auditPasswordReset({
        account: ACCOUNT,
        write: async () => {
          throw new Error('connection refused');
        },
      }),
    ).resolves.toBeUndefined();

    expect(logged.length, 'the failed write was not reported').toBe(1);
  });

  it('says nothing when the write went through', async () => {
    // The negative control. A module that logged every write would drown
    // the failures in noise, which is how a real failure gets missed.
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    await auditPasswordReset({ account: ACCOUNT, write: async () => {} });

    expect(logged).toEqual([]);
  });
});
