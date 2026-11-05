// tests/unit/password-reset-token.test.ts
//
// The self-service password reset: the token, and the redemption of it.
//
// WHY THIS TEST EXISTS
// --------------------
// A driver or an owner who forgot their password had exactly one route back
// in: phone the office, and the office logged in to the operations app and
// pressed "Reset password" on their record. That is a recovery path for the
// OFFICE, not for the person, and on a box that is not staffed around the
// clock it means a driver cannot start a shift.
//
// The schema already had the columns for it — `auth.local_credentials` carries
// `reset_token_hash` and `reset_expires_at`, with a comment saying "the app
// checks expiry before accepting" — and NOTHING used them. The columns were
// the plan; the code never arrived.
//
// This file pins the half that is easy to get subtly wrong:
//
//   * only the HASH of the token is stored, so a database that leaks does not
//     hand over a live reset link;
//   * a token is good once, and only once;
//   * an expired token is refused for the same reason as an unknown one, so
//     the page cannot be used to find out which tokens exist;
//   * a failure to READ is a refusal, never a write — a check that cannot
//     fail must never fail open;
//   * a failure to WRITE leaves the token usable, so the person can try again
//     rather than being locked out by a transient database error.
//
// The store is injected, so every branch runs without a database — the same
// shape `src/lib/auth/password-reset.ts` uses.

import { describe, expect, it } from 'vitest';
import {
  completePasswordReset,
  generateResetToken,
  hashResetToken,
  MIN_RESET_PASSWORD_LENGTH,
  RESET_TOKEN_TTL_SECONDS,
  ResetTokenSpentError,
  type ResetTokenStore,
} from '@/lib/auth/password-reset-token';

/** A token the fake store has issued. */
interface IssuedToken {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

/**
 * A store that behaves like the real one: one live token per user, and the
 * hash — never the raw token — is what it keeps.
 */
function fakeStore(
  options: {
    /** The password the account currently holds. */
    currentPassword?: string;
    failFind?: boolean;
    failRedeem?: boolean;
    /** The role the account holds NOW — after the write. */
    currentRole?: string;
    /** The tenants the account belongs to NOW. */
    tenantIds?: string[];
    /** A read of the current account that fails. */
    failCurrentAccount?: boolean;
  } = {},
) {
  const issued = new Map<string, IssuedToken>();
  const redeemed: Array<{ userId: string; tokenHash: string; password: string }> = [];
  const currentPassword = options.currentPassword ?? 'the-current-password';
  const currentRole = options.currentRole ?? 'driver';
  const tenantIds = options.tenantIds ?? [];
  const accountReads: string[] = [];

  const store: ResetTokenStore = {
    async issue(userId, tokenHash, expiresAt) {
      // One live token per user: a second request replaces the first.
      issued.set(userId, { userId, tokenHash, expiresAt });
    },
    async findByTokenHash(tokenHash) {
      if (options.failFind) throw new Error('the database could not be reached');
      for (const row of issued.values()) {
        if (row.tokenHash === tokenHash) {
          return { userId: row.userId, expiresAt: row.expiresAt };
        }
      }
      return null;
    },
    async passwordMatches(userId, password) {
      if (options.failFind) throw new Error('the database could not be reached');
      return password === currentPassword;
    },
    async redeem(userId, tokenHash, password) {
      if (options.failRedeem) throw new Error('the write failed');
      // The single-use rule, modelled the way the REAL store implements it:
      // the row is written only while the token being redeemed is STILL the
      // live token for that account.
      //
      // This fake used to do `issued.delete(userId)` — it spent whatever token
      // the user had, without ever being asked which one was being redeemed.
      // That made the "only once" test below pass for a reason the production
      // SQL did not share: the production UPDATE named the account and not
      // the token, so two redemptions of the same link could both land. The
      // fake was not modelling the store; it was modelling the store's
      // intent. It now models the store's SQL.
      const live = issued.get(userId);
      if (!live || live.tokenHash !== tokenHash) {
        throw new ResetTokenSpentError();
      }
      redeemed.push({ userId, tokenHash, password });
      // The token is spent by the redemption itself.
      issued.delete(userId);
    },
    async currentAccount(userId) {
      accountReads.push(userId);
      if (options.failCurrentAccount) throw new Error('the database could not be reached');
      return { role: currentRole, tenantIds };
    },
  };

  return { store, issued, redeemed, accountReads };
}

/** A well-formed new password: long enough, and not the one already in use. */
const NEW_PASSWORD = 'a-brand-new-password';

describe('the reset token', () => {
  it('is long enough that it cannot be guessed', () => {
    const token = generateResetToken();
    // 32 random bytes in base64url. Anything shorter is a brute force away.
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it('is different every time it is made', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateResetToken()));
    expect(tokens.size).toBe(50);
  });

  it('is never stored — only a hash of it is', () => {
    const token = generateResetToken();
    const hash = hashResetToken(token);
    expect(hash).not.toBe(token);
    // A sha256, hex.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the same token to the same hash every time', () => {
    const token = generateResetToken();
    expect(hashResetToken(token)).toBe(hashResetToken(token));
    expect(hashResetToken(token)).not.toBe(hashResetToken(generateResetToken()));
  });
});

describe('redeeming a reset token', () => {
  it('sets the new password', async () => {
    const { store, redeemed } = fakeStore();
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    const outcome = await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(outcome.ok).toBe(true);
    expect(redeemed).toEqual([
      { userId: 'user-1', tokenHash: hashResetToken(token), password: NEW_PASSWORD },
    ]);
  });

  it('hands the token hash to the store, so the write can be conditional on it', async () => {
    // This is the whole of the single-use property, and it lives in the
    // store's write rather than in this library: the store can only refuse a
    // second redemption if it is told WHICH token is being redeemed. A
    // library that passed the user id alone left the store with no way to
    // tell "this link" from "some link", and the store's UPDATE — which
    // named the account and not the token — let a forwarded link through
    // twice.
    const { store, redeemed } = fakeStore();
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(redeemed[0].tokenHash).toBe(hashResetToken(token));
    // The raw token is never handed over — only its hash.
    expect(redeemed[0].tokenHash).not.toBe(token);
  });

  it('refuses a token nobody has', async () => {
    const { store, redeemed } = fakeStore();
    const outcome = await completePasswordReset({
      token: generateResetToken(),
      password: NEW_PASSWORD,
      store,
    });

    expect(outcome.ok).toBe(false);
    expect(redeemed).toHaveLength(0);
  });

  it('refuses an expired token', async () => {
    const { store, redeemed } = fakeStore();
    const token = generateResetToken();
    await store.issue(
      'user-1',
      hashResetToken(token),
      new Date(Date.now() - 60_000), // an hour ago
    );

    const outcome = await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(outcome.ok).toBe(false);
    expect(redeemed).toHaveLength(0);
  });

  it('refuses an expired token for the same reason as an unknown one', async () => {
    // Otherwise the page becomes an oracle: an attacker learns which tokens
    // exist by watching which reason comes back.
    const { store } = fakeStore();
    const expired = generateResetToken();
    await store.issue('user-1', hashResetToken(expired), new Date(Date.now() - 60_000));

    const expiredOutcome = await completePasswordReset({
      token: expired,
      password: NEW_PASSWORD,
      store,
    });
    const unknownOutcome = await completePasswordReset({
      token: generateResetToken(),
      password: NEW_PASSWORD,
      store,
    });

    expect(expiredOutcome.ok).toBe(false);
    expect(unknownOutcome.ok).toBe(false);
    expect((expiredOutcome as { reason: string }).reason).toBe(
      (unknownOutcome as { reason: string }).reason,
    );
  });

  it('lets a token be used only once', async () => {
    const { store, redeemed } = fakeStore();
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    const first = await completePasswordReset({ token, password: NEW_PASSWORD, store });
    const second = await completePasswordReset({ token, password: 'another-password-entirely', store });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    // The second redemption changed NOTHING. This is the assertion the old
    // version of this file could not make: the fake used to delete whatever
    // token the account had, so it enforced single use by its own
    // bookkeeping, while the production SQL did not.
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0].password).toBe(NEW_PASSWORD);
  });

  it('refuses a spent token for the same reason as an unknown one', async () => {
    // The store reports "the token is not live" with `ResetTokenSpentError`.
    // The library must turn that into the same refusal an unknown token
    // gets: a page that says "this link was used" says a reset happened, and
    // that is somebody's account history.
    const { store } = fakeStore();
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    await completePasswordReset({ token, password: NEW_PASSWORD, store });
    const spent = await completePasswordReset({ token, password: NEW_PASSWORD, store });
    const unknown = await completePasswordReset({
      token: generateResetToken(),
      password: NEW_PASSWORD,
      store,
    });

    expect(spent.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    expect((spent as { reason: string }).reason).toBe('invalid_token');
    expect((spent as { reason: string }).reason).toBe(
      (unknown as { reason: string }).reason,
    );
  });

  it('refuses a token that a newer request has replaced', async () => {
    // One live token per account: asking for a second link stops the first
    // from working, so a link that was already forwarded does not stay good
    // for the whole of its window.
    const { store, redeemed } = fakeStore();
    const first = generateResetToken();
    const second = generateResetToken();
    await store.issue('user-1', hashResetToken(first), new Date(Date.now() + 60_000));
    await store.issue('user-1', hashResetToken(second), new Date(Date.now() + 60_000));

    const outcome = await completePasswordReset({ token: first, password: NEW_PASSWORD, store });

    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe('invalid_token');
    expect(redeemed).toHaveLength(0);
  });

  it('refuses a new password that is too short', async () => {
    const { store, redeemed } = fakeStore();
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    const outcome = await completePasswordReset({
      token,
      password: 'a'.repeat(MIN_RESET_PASSWORD_LENGTH - 1),
      store,
    });

    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe('password_too_short');
    expect(redeemed).toHaveLength(0);
  });

  it('refuses a new password that does not match the confirmation', async () => {
    const { store, redeemed } = fakeStore();
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    const outcome = await completePasswordReset({
      token,
      password: NEW_PASSWORD,
      confirm: 'something-else-entirely',
      store,
    });

    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe('mismatch');
    expect(redeemed).toHaveLength(0);
  });

  it('refuses a new password that is the one already in use', async () => {
    // A "reset" to the password already in use proves nothing and leaves the
    // account exactly as exposed as it was.
    const { store, redeemed } = fakeStore({ currentPassword: NEW_PASSWORD });
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    const outcome = await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe('must_differ');
    expect(redeemed).toHaveLength(0);
  });

  it('fails closed when the store cannot be read', async () => {
    // The read is what decides whose account is being opened. A store that
    // cannot answer must produce a refusal and no write.
    const { store, redeemed } = fakeStore({ failFind: true });
    const token = generateResetToken();

    const outcome = await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe('failed');
    expect(redeemed).toHaveLength(0);
  });

  it('leaves the token usable when the write fails', async () => {
    // The password did not change, so the person must be able to try again.
    // A transient database error must not lock them out for good.
    const { store, issued } = fakeStore({ failRedeem: true });
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    const outcome = await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe('failed');
    // The token was not consumed, because nothing was redeemed.
    expect(issued.size).toBe(1);
  });

  it('never puts the password in the message it returns', async () => {
    const { store } = fakeStore({ failRedeem: true });
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    const outcome = await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(JSON.stringify(outcome)).not.toContain(NEW_PASSWORD);
  });

  it('refuses an empty token or an empty password', async () => {
    const { store, redeemed } = fakeStore();

    const noToken = await completePasswordReset({ token: '', password: NEW_PASSWORD, store });
    const noPassword = await completePasswordReset({
      token: generateResetToken(),
      password: '',
      store,
    });

    expect(noToken.ok).toBe(false);
    expect((noToken as { reason: string }).reason).toBe('invalid_request');
    expect(noPassword.ok).toBe(false);
    expect((noPassword as { reason: string }).reason).toBe('invalid_request');
    expect(redeemed).toHaveLength(0);
  });
});

describe('the window a token is good for', () => {
  it('is half an hour', () => {
    expect(RESET_TOKEN_TTL_SECONDS).toBe(30 * 60);
  });
  it('accepts a token that has not expired yet', async () => {
    const { store } = fakeStore();
    const token = generateResetToken();
    await store.issue(
      'user-1',
      hashResetToken(token),
      new Date(Date.now() + RESET_TOKEN_TTL_SECONDS - 1_000),
    );

    const outcome = await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(outcome.ok).toBe(true);
  });

  it('does not accept a token that has just expired', async () => {
    const { store } = fakeStore();
    const token = generateResetToken();
    await store.issue(
      'user-1',
      hashResetToken(token),
      new Date(Date.now() + RESET_TOKEN_TTL_SECONDS - 1_000),
    );

    // Half an hour and a minute later the same token is outside its window.
    const later = new Date(Date.now() + (RESET_TOKEN_TTL_SECONDS + 60) * 1000);
    const outcome = await completePasswordReset({
      token,
      password: NEW_PASSWORD,
      store,
      now: later,
    });

    expect(outcome.ok).toBe(false);
  });
});

/**
 * THE ACCOUNT, READ AT THE MOMENT OF REDEMPTION
 * ---------------------------------------------
 * The link in the email names a door, and the link can be half an hour old
 * when it is used. If the account's role changed in that time, the door in the
 * link is the wrong one — and a driver sent to the staff sign-in signs in
 * successfully and is then bounced by the role check, which is the exact dead
 * end this feature exists to end.
 *
 * So the redemption reads the account as it is NOW, and answers with that.
 *
 * It also hands the account back, because the audit row is filed under the
 * account's tenant, and because the actor of a self-service reset is the
 * person who reset it — they proved control of the address on file. A reset
 * that is not filed is, as far as the trail is concerned, a reset that did
 * not happen.
 */
describe('the account, read at the moment of redemption', () => {
  it('answers with the role the account holds now', async () => {
    const { store } = fakeStore({ currentRole: 'driver' });
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    const outcome = await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(outcome.ok).toBe(true);
    expect((outcome as { account: { role: string } }).account.role).toBe('driver');
  });

  it('answers with the account itself, so the reset can be filed', async () => {
    const { store } = fakeStore({ currentRole: 'ops', tenantIds: ['tenant-a', 'tenant-b'] });
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    const outcome = await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(outcome.ok).toBe(true);
    expect((outcome as { account: unknown }).account).toEqual({
      role: 'ops',
      tenantIds: ['tenant-a', 'tenant-b'],
    });
    expect((outcome as { userId: string }).userId).toBe('user-1');
  });

  it('refuses, and changes nothing, when the account cannot be read', async () => {
    // The same rule this module has always had: a failure to READ is a
    // refusal, never a write. The account's role is what decides the door,
    // and the account's tenant is what the audit row is filed under — so a
    // read that cannot answer must not let a reset through with a guessed
    // door and an unfiled trail.
    const { store, redeemed, issued } = fakeStore({ failCurrentAccount: true });
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    const outcome = await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe('failed');
    expect(redeemed).toHaveLength(0);
    // The token was not spent, because nothing was redeemed. The person can
    // try again.
    expect(issued.size).toBe(1);
  });

  it('does not ask for the account until every other check has passed', async () => {
    // The read is only worth its cost on a redemption that is going to
    // happen. A link that is already dead must not pay for it.
    const { store, accountReads } = fakeStore();
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() - 60_000));

    await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(accountReads).toEqual([]);
  });

  it('never puts the account in the message it returns', async () => {
    // The refusal for a failed read says nothing about the account.
    const { store } = fakeStore({ failCurrentAccount: true });
    const token = generateResetToken();
    await store.issue('user-1', hashResetToken(token), new Date(Date.now() + 60_000));

    const outcome = await completePasswordReset({ token, password: NEW_PASSWORD, store });

    expect(JSON.stringify(outcome)).not.toContain('user-1');
  });
});
