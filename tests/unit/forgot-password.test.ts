// tests/unit/forgot-password.test.ts
//
// Asking for a password reset link: the half of the reset that faces the
// outside world.
//
// WHY THIS TEST EXISTS
// --------------------
// Four defects were found here by the security review of 2026-11-04, and
// they are all the same kind of defect: the answer to "is this address on
// file?" must not differ between the addresses.
//
//   S2 — the answer took longer for an address that WAS on file, because
//        the known path did an extra read and an HTTPS round trip to the
//        mail provider and the unknown path did neither. A stopwatch is an
//        oracle: an attacker who measures can tell which addresses exist.
//
//   S3 — the origin in the link came from the request's own Host header
//        when the deployment had not configured one. A caller who controls
//        that header controls where the link points, and a link that points
//        at the caller's server hands over the token.
//
//   S4 — the throttle was consulted and then the mail was sent, and only
//        THEN was the counter incremented. Between the check and the
//        increment the whole mail round trip happens, so a hundred
//        concurrent requests all passed the check. And the counter was
//        only incremented for addresses that were on file, so a stranger
//        guessing addresses was never throttled at all.
//
//   S9 — the log line for a throttled request printed the address in the
//        clear, so the log was an account list for anybody who could read
//        it.
//
// WHAT IS ASSERTED HERE
// ---------------------
// The behaviour, through the handler the route delegates to. The store, the
// throttle and the mailer are fakes — this file is about the ORDER of
// things and the shape of the answer, not about SQL.
//
// The atomicity of the throttle itself — that a hundred concurrent requests
// cannot all pass one limit — is a property of the SQL, so it is proved
// against a real database in
// `tests/integration/auth/password-reset-throttle.test.ts`. The same lesson
// as the single-use reset: the unit suite agreed with a fake store while
// the production SQL was wrong.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configuredResetOrigin,
  handleForgotPassword,
  type ForgotPasswordLog,
  type ForgotPasswordRequest,
} from '@/lib/auth/forgot-password';
import { RESET_REQUEST_MESSAGE } from '@/lib/auth/password-reset-policy';
import type { ResetAccount, ResetRequestStore } from '@/lib/auth/password-reset-request';
import type { ResetThrottleStore } from '@/lib/auth/password-reset-throttle';

const ACCOUNT: ResetAccount = {
  userId: 'user-1',
  email: 'driver@example.com',
  fullName: 'Ade Okonkwo',
  tenantId: 'tenant-1',
  role: 'driver',
};

interface LogLine {
  level: 'warn' | 'error';
  message: string;
  detail?: unknown;
}

interface Harness {
  request: ForgotPasswordRequest;
  logs: LogLine[];
  delivered: Array<{ account: ResetAccount; token: string }>;
  issued: string[];
  /** The work the handler deferred, so a test can run it or not. */
  scheduled: Array<() => Promise<void>>;
}

function harness(
  overrides: Partial<ForgotPasswordRequest> & {
    account?: ResetAccount | null;
    hasPassword?: boolean;
  } = {},
): Harness {
  const account = overrides.account === undefined ? ACCOUNT : overrides.account;
  const logs: LogLine[] = [];
  const delivered: Array<{ account: ResetAccount; token: string }> = [];
  const issued: string[] = [];
  const scheduled: Array<() => Promise<void>> = [];

  const log: ForgotPasswordLog = {
    warn: (message, detail) => logs.push({ level: 'warn', message, detail }),
    error: (message, detail) => logs.push({ level: 'error', message, detail }),
  };

  const store: ResetRequestStore = overrides.store ?? {
    findAccountByEmail: async () => account,
    hasPassword: async () => overrides.hasPassword ?? true,
    issueToken: async (userId) => {
      issued.push(userId);
    },
  };

  const throttle: ResetThrottleStore = overrides.throttle ?? {
    takeIpAllowance: async () => ({ allowed: true, requestId: 'request-1' }),
    takeAccountAllowance: async () => ({ allowed: true }),
  };

  const request: ForgotPasswordRequest = {
    email: 'driver@example.com',
    origin: 'https://fleet.example.com',
    clientIp: '203.0.113.9',
    store,
    throttle,
    log,
    deliver: async (args) => {
      delivered.push({ account: args.account, token: args.token });
      return { sent: true };
    },
    // The work is COLLECTED, not run: a test that wants it to have run
    // awaits it, so the assertions never depend on a timer.
    schedule: (work) => {
      scheduled.push(work);
    },
    now: () => new Date('2026-11-04T12:00:00.000Z'),
    ...overrides,
  };

  return { request, logs, delivered, issued, scheduled };
}

/** A promise that never settles until the test says so. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('the origin a reset link is built from', () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = original;
  });

  it('is the address the deployment configured', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://fleet.example.com/';
    expect(configuredResetOrigin()).toBe('https://fleet.example.com');
  });

  it('is nothing at all when the deployment configured nothing', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(configuredResetOrigin()).toBeNull();
  });

  it('refuses an origin that is not an address', () => {
    // A link whose origin is `javascript:` is a link that runs code when it
    // is followed, and one that is not a URL at all is a link that cannot
    // work. Neither is worth sending.
    for (const bad of ['javascript:alert(1)', 'fleet.example.com', '/relative', 'not a url']) {
      process.env.NEXT_PUBLIC_APP_URL = bad;
      expect(configuredResetOrigin(), bad).toBeNull();
    }
  });

  it('refuses an origin that is not http or https', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'ftp://fleet.example.com';
    expect(configuredResetOrigin()).toBeNull();
  });
});

describe('asking for a password reset', () => {
  it('answers before it knows whether the account exists', async () => {
    // The lookup is held open. If the handler waited for it, this call would
    // never come back and the test would time out — which is the point: the
    // response must not wait for anything that depends on the account.
    const gate = deferred();
    let lookupStarted = false;
    let lookupFinished = false;

    const store: ResetRequestStore = {
      findAccountByEmail: async () => {
        lookupStarted = true;
        await gate.promise;
        lookupFinished = true;
        return ACCOUNT;
      },
      hasPassword: async () => true,
      issueToken: async () => {},
    };

    // The work runs, and is NOT awaited by the handler — which is what the
    // framework's `after()` does: it runs the callback once the response
    // has gone out.
    const { request } = harness({ store, schedule: (work) => void work() });

    const outcome = await Promise.race([
      handleForgotPassword(request),
      new Promise<'TIMED_OUT'>((resolve) => setTimeout(() => resolve('TIMED_OUT'), 2_000)),
    ]);

    expect(outcome).not.toBe('TIMED_OUT');
    expect((outcome as { status: number }).status).toBe(200);
    // The work had started by the time the answer came back, and had not
    // finished — so the answer did not wait for it.
    expect(lookupStarted).toBe(true);
    expect(lookupFinished).toBe(false);

    gate.release();
  });

  it('gives everybody the same answer', async () => {
    const known = harness();
    const unknown = harness({ account: null });

    const a = await handleForgotPassword(known.request);
    const b = await handleForgotPassword(unknown.request);

    expect(a).toEqual(b);
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ ok: true, message: RESET_REQUEST_MESSAGE });
  });

  it('does not send a link when the deployment has no origin configured', async () => {
    // Fail closed. A link whose origin is guessed from the request points at
    // whoever guessed the Host header, and following it hands over the
    // token.
    const { request, scheduled, delivered } = harness({ origin: null });

    const outcome = await handleForgotPassword(request);

    // The same answer everybody gets — a caller learns nothing from it.
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ ok: true, message: RESET_REQUEST_MESSAGE });

    // And nothing went out.
    expect(scheduled).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });

  it('says loudly that it could not issue a link', async () => {
    const { request, logs } = harness({ origin: null });

    await handleForgotPassword(request);

    // Silently doing nothing is the failure mode this guards against: the
    // person is told a link is on its way, and no link ever arrives.
    expect(logs.some((l) => l.level === 'error')).toBe(true);
  });

  it('takes the allowance before anything is sent', async () => {
    // The counter was incremented AFTER the mail went out, so a hundred
    // concurrent requests all passed the check and a hundred mails went to
    // the same inbox.
    const order: string[] = [];

    const throttle: ResetThrottleStore = {
      takeIpAllowance: async () => {
        order.push('take-ip');
        return { allowed: true, requestId: 'request-1' };
      },
      takeAccountAllowance: async () => {
        order.push('take-account');
        return { allowed: true };
      },
    };

    const store: ResetRequestStore = {
      findAccountByEmail: async () => {
        order.push('lookup');
        return ACCOUNT;
      },
      hasPassword: async () => {
        order.push('has-password');
        return true;
      },
      issueToken: async () => {
        order.push('issue-token');
      },
    };

    const { request, scheduled } = harness({ throttle, store });
    await handleForgotPassword(request);
    for (const work of scheduled) await work();

    expect(order[0]).toBe('take-ip');
    expect(order.indexOf('take-account')).toBeLessThan(order.indexOf('issue-token'));
    // And the mail goes out last of all.
    expect(order[order.length - 1]).toBe('issue-token');
  });

  it('counts a request for an address that is not on file', async () => {
    // The counter was only incremented for addresses that were on file, so a
    // stranger guessing addresses was never throttled: the throttle that
    // was supposed to slow them down did not count them.
    let taken = 0;
    const throttle: ResetThrottleStore = {
      takeIpAllowance: async () => {
        taken += 1;
        return { allowed: true, requestId: 'request-1' };
      },
      takeAccountAllowance: async () => ({ allowed: true }),
    };

    const { request, scheduled } = harness({
      throttle,
      account: null,
    });

    await handleForgotPassword(request);
    for (const work of scheduled) await work();

    expect(taken).toBe(1);
  });

  it('sends no mail when the address has no password', async () => {
    const { request, scheduled, delivered } = harness({ hasPassword: false });

    await handleForgotPassword(request);
    for (const work of scheduled) await work();

    expect(delivered).toHaveLength(0);
  });

  it('sends no mail when the account has spent its allowance', async () => {
    const throttle: ResetThrottleStore = {
      takeIpAllowance: async () => ({ allowed: true, requestId: 'request-1' }),
      takeAccountAllowance: async () => ({ allowed: false }),
    };

    const { request, delivered, scheduled } = harness({ throttle });

    await handleForgotPassword(request);
    for (const work of scheduled) await work();

    expect(delivered).toHaveLength(0);
  });

  it('never puts the address in the log', async () => {
    // A throttled request was logged with the address in the clear, which
    // made the log an account list for anybody who could read it.
    const throttle: ResetThrottleStore = {
      takeIpAllowance: async () => ({ allowed: false, requestId: null }),
      takeAccountAllowance: async () => ({ allowed: false }),
    };

    const { request, logs } = harness({ throttle });

    await handleForgotPassword(request);

    const printed = JSON.stringify(logs);
    expect(printed).not.toContain('driver@example.com');
    expect(printed).not.toContain('driver');
  });

  it('answers a throttled request exactly as it answers every other one', async () => {
    const throttle: ResetThrottleStore = {
      takeIpAllowance: async () => ({ allowed: false, requestId: null }),
      takeAccountAllowance: async () => ({ allowed: false }),
    };

    const throttled = harness({ throttle });
    const allowed = harness();

    const a = await handleForgotPassword(throttled.request);
    const b = await handleForgotPassword(allowed.request);

    expect(a).toEqual(b);
  });

  it('says the database is unwell rather than pretending it worked', async () => {
    const throttle: ResetThrottleStore = {
      takeIpAllowance: async () => {
        throw new Error('the database is down');
      },
      takeAccountAllowance: async () => ({ allowed: true }),
    };

    const { request } = harness({ throttle });

    const outcome = await handleForgotPassword(request);

    expect(outcome.status).toBe(503);
  });

  it('asks for an address before it does anything else', async () => {
    const { request, scheduled } = harness();

    const outcome = await handleForgotPassword({ ...request, email: '   ' });

    expect(outcome.status).toBe(400);
    expect(scheduled).toHaveLength(0);
  });

  it('sends the link to the address on file, not the one that was typed', async () => {
    const { request, delivered, scheduled } = harness({
      account: { ...ACCOUNT, email: 'on-file@example.com' },
    });

    await handleForgotPassword(request);
    for (const work of scheduled) await work();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].account.email).toBe('on-file@example.com');
  });
});
