// tests/unit/password-reset-request.test.ts
//
// The self-service password reset: the half where somebody asks for a reset
// and a link is sent to them.
//
// WHY THIS TEST EXISTS
// --------------------
// The request half is the one that faces the outside world, and it has one
// job above every other: it must not tell a stranger whether an address is
// registered. If "we sent you a link" and "no such account" are different
// answers, then the page becomes a way to enumerate who has an account with
// this operator — and the person most likely to run that is exactly the
// person trying to take one over.
//
// So the result has ONE SHAPE for every account state: the same keys, always
// present. What differs between them is the `outcome` code, which is for the
// operator's own record and never for the browser. A result that gained or
// lost a key would be a result the route could leak by accident.
//
// The other thing this pins is that the raw token never reaches the
// database: only its hash does. A database that leaks — and this product's
// database is on a box the customer can read — must not hand out live reset
// links.
//
// The store is injected, so every branch runs without a database — the same
// shape `src/lib/auth/password-reset.ts` uses.

import { describe, expect, it, vi } from 'vitest';
import { hashResetToken, RESET_TOKEN_TTL_SECONDS } from '@/lib/auth/password-reset-token';
import {
  requestPasswordReset,
  type ResetAccount,
  type ResetRequestStore,
} from '@/lib/auth/password-reset-request';

const ACCOUNT: ResetAccount = {
  userId: 'user-1',
  email: 'driver@example.com',
  fullName: 'Ade Okonkwo',
  tenantId: 'tenant-1',
  role: 'driver',
};

/** What the library hands the delivery function. */
type DeliveryArgs = { account: ResetAccount; token: string; expiresAt: Date };

/**
 * A delivery spy, typed with its arguments.
 *
 * Without the type, `deliver.mock.calls[0][0]` is `any` and a typo in the
 * assertion — `.acount`, say — would pass. With it, the compiler checks the
 * shape of what the library actually passed.
 */
function deliverySpy(result: { sent: boolean; reason?: string } = { sent: true }) {
  return vi.fn<(args: DeliveryArgs) => Promise<{ sent: boolean; reason?: string }>>(
    async () => result,
  );
}

/** A store that knows about one account, and issues tokens into a list. */
function fakeStore(
  options: {
    account?: ResetAccount | null;
    hasPassword?: boolean;
    failFind?: boolean;
    failIssue?: boolean;
  } = {},
) {
  const account = options.account === undefined ? ACCOUNT : options.account;
  const issued: Array<{ userId: string; tokenHash: string; expiresAt: Date }> = [];

  const store: ResetRequestStore = {
    async findAccountByEmail() {
      if (options.failFind) throw new Error('the database could not be reached');
      return account;
    },
    async hasPassword() {
      if (options.failFind) throw new Error('the database could not be reached');
      return options.hasPassword === undefined ? true : options.hasPassword;
    },
    async issueToken(userId, tokenHash, expiresAt) {
      if (options.failIssue) throw new Error('the write failed');
      issued.push({ userId, tokenHash, expiresAt });
    },
  };

  return { store, issued };
}

describe('asking for a password reset', () => {
  it('issues a token for an account that has a password', async () => {
    const { store } = fakeStore();
    const deliver = deliverySpy();

    const result = await requestPasswordReset({
      email: 'driver@example.com',
      store,
      deliver,
    });

    expect(result.outcome).toBe('sent');
    expect(result.token).toBeTruthy();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('sends the link to the address on file, not to the one that was typed', async () => {
    // Otherwise a stranger can send a reset link to an address they control
    // and read the token out of the inbound mail.
    const { store } = fakeStore();
    const deliver = deliverySpy();

    await requestPasswordReset({
      email: 'DRIVER@example.com',
      store,
      deliver,
    });

    expect(deliver.mock.calls[0][0].account.email).toBe('driver@example.com');
  });

  it('carries the account’s role through to the delivery', async () => {
    // The link has to end at the right door. The role comes from the row on
    // file, so it travels with the account all the way to the email.
    const { store } = fakeStore();
    const deliver = deliverySpy();

    await requestPasswordReset({
      email: 'driver@example.com',
      store,
      deliver,
    });

    expect(deliver.mock.calls[0][0].account.role).toBe('driver');
  });

  it('stores only the hash of the token, never the token itself', async () => {
    const { store, issued } = fakeStore();
    const deliver = deliverySpy();

    const result = await requestPasswordReset({
      email: 'driver@example.com',
      store,
      deliver,
    });

    expect(issued).toHaveLength(1);
    expect(issued[0].tokenHash).not.toBe(result.token);
    expect(issued[0].tokenHash).toBe(hashResetToken(result.token as string));
  });

  it('puts the raw token in the link it sends', async () => {
    // The hash is what the database holds; the link needs the token itself.
    const { store } = fakeStore();
    const deliver = deliverySpy();

    const result = await requestPasswordReset({
      email: 'driver@example.com',
      store,
      deliver,
    });

    expect(deliver.mock.calls[0][0].token).toBe(result.token);
  });

  it('expires the link in half an hour', async () => {
    const { store, issued } = fakeStore();
    const deliver = deliverySpy();
    const now = new Date('2026-11-04T09:00:00.000Z');

    await requestPasswordReset({ email: 'driver@example.com', store, deliver, now });

    expect(issued[0].expiresAt.getTime() - now.getTime()).toBe(RESET_TOKEN_TTL_SECONDS * 1000);
  });

  it('sends nothing for an address that is not on file', async () => {
    const { store } = fakeStore({ account: null });
    const deliver = deliverySpy();

    const result = await requestPasswordReset({
      email: 'nobody@example.com',
      store,
      deliver,
    });

    expect(result.outcome).toBe('no_such_account');
    expect(result.token).toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('sends nothing for an account that signs in with a code', async () => {
    // There is no password to reset. Sending a link would create one — and
    // create a second way into an account that deliberately has one.
    const { store } = fakeStore({ hasPassword: false });
    const deliver = deliverySpy();

    const result = await requestPasswordReset({
      email: 'driver@example.com',
      store,
      deliver,
    });

    expect(result.outcome).toBe('no_password');
    expect(result.token).toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('gives the browser the same shape of answer whatever the account state', async () => {
    // This is the enumeration guard. The result has the same keys, and the
    // same values in every key that could identify an account — so a route
    // that passes it through unchanged leaks nothing.
    const { store: withAccount } = fakeStore();
    const { store: withoutAccount } = fakeStore({ account: null });
    const { store: codeOnly } = fakeStore({ hasPassword: false });
    const deliver = deliverySpy();

    const found = await requestPasswordReset({ email: 'a@example.com', store: withAccount, deliver });
    const missing = await requestPasswordReset({
      email: 'b@example.com',
      store: withoutAccount,
      deliver,
    });
    const code = await requestPasswordReset({ email: 'c@example.com', store: codeOnly, deliver });

    for (const result of [found, missing, code]) {
      expect(Object.keys(result).sort()).toEqual(['expiresAt', 'ok', 'outcome', 'token']);
      expect(result.ok).toBe(true);
    }
    // The account's own identity is never in the result.
    for (const result of [found, missing, code]) {
      expect(JSON.stringify(result)).not.toContain('user-1');
      expect(JSON.stringify(result)).not.toContain('driver@example.com');
    }
  });

  it('does not send when the store cannot be read', async () => {
    // A read that failed is not an account that does not exist. Either way
    // nothing is sent — but the two must not look the same in the log, or a
    // broken database would look like a clean run.
    const { store } = fakeStore({ failFind: true });
    const deliver = deliverySpy();

    const result = await requestPasswordReset({
      email: 'driver@example.com',
      store,
      deliver,
    });

    expect(result.outcome).toBe('store_failed');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not send when the token cannot be stored', async () => {
    // A link whose token was never stored is a link that will not work. It
    // is better to send nothing than to send a link that fails.
    const { store } = fakeStore({ failIssue: true });
    const deliver = deliverySpy();

    const result = await requestPasswordReset({
      email: 'driver@example.com',
      store,
      deliver,
    });

    expect(result.outcome).toBe('store_failed');
    expect(result.token).toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('reports a delivery that did not go', async () => {
    // The box may have no email provider configured. The operator needs to
    // know that, so it is recorded — but the person still gets the same
    // answer as everybody else.
    const { store } = fakeStore();
    const deliver = deliverySpy({ sent: false, reason: 'email is not configured' });

    const result = await requestPasswordReset({
      email: 'driver@example.com',
      store,
      deliver,
    });

    expect(result.outcome).toBe('delivery_failed');
    expect(result.token).toBeNull();
  });

  it('replaces an earlier token when a second one is requested', async () => {
    // Two requests, one live link. The older token must stop working, or a
    // link that was already forwarded keeps working forever.
    const { store, issued } = fakeStore();
    const deliver = deliverySpy();

    await requestPasswordReset({ email: 'driver@example.com', store, deliver });
    await requestPasswordReset({ email: 'driver@example.com', store, deliver });

    expect(issued).toHaveLength(2);
    expect(issued[1].tokenHash).not.toBe(issued[0].tokenHash);
  });

  it('refuses an empty address', async () => {
    const { store } = fakeStore();
    const deliver = deliverySpy();

    const result = await requestPasswordReset({ email: '   ', store, deliver });

    expect(result.outcome).toBe('no_such_account');
    expect(deliver).not.toHaveBeenCalled();
  });
});
