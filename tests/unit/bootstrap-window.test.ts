// tests/unit/bootstrap-window.test.ts
//
// The first-run window.
//
// `app_state.bootstrap_pending` is the flag that says "this installation has
// no owner yet". The migration history arms it ('1'), the bootstrap script
// arms it, and it has to be closed ('0') the moment first-run setup genuinely
// completes — through WHICHEVER door the operator used.
//
// A customer-operated box has TWO doors:
//
//   /api/v1/bootstrap      — the HMAC-signed endpoint the handover documents
//   /api/auth/local/setup  — the browser page at /setup
//
// Only the first one closed the window. The second created the owner account
// and the tenant, answered 200, and left the flag armed — so the operator saw
// a green setup on an application that still believed it was pending, and the
// first-run door stayed open behind them.
//
// The invariant these tests pin:
//
//   * the window closes in the SAME transaction as the account it describes,
//     so a setup that cannot close it never reports success;
//   * it closes on BOTH doors;
//   * it stays armed when the setup did not complete;
//   * a window that is armed on an installation that already has an owner is
//     stale, and the server corrects it rather than believing it.
//
// The database is a fake, and what is under test is the ORDER and the
// TRANSACTION, not Postgres.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { NextRequest } from 'next/server';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const BOOTSTRAP_TOKEN = 'the-bootstrap-window-test-token';

/**
 * The fake database.
 *
 * It records every statement together with the transaction it ran in, and it
 * models the two things the first-run window is about: the owner account and
 * the `app_state` rows. `begin()` is a transaction in the only sense that
 * matters here — the writes it makes are discarded when it throws.
 */
const fake = vi.hoisted(() => {
  // These live inside the hoisted block because the hoisted callback runs
  // before the module body, and a module-level `const` would still be in its
  // temporal dead zone when the fake is built.
  const USER_ID = '11111111-1111-1111-1111-111111111111';
  const TENANT_ID = '22222222-2222-2222-2222-222222222222';

  const state = {
    /** Every statement, and whether it ran inside a transaction. */
    statements: [] as Array<{ text: string; inTransaction: boolean }>,
    /** The owner account, once one exists. */
    owner: null as { id: string; email: string } | null,
    /** The `app_state` rows. */
    appState: { bootstrap_pending: '1' } as Record<string, string>,
    /** How deep we are inside `begin()`. */
    depth: 0,
    /** Make the owner insert throw. */
    failUserInsert: false,
    /** Make the `app_state` write throw. */
    failAppStateWrite: false,
  };

  async function run(strings: TemplateStringsArray, values: unknown[]): Promise<unknown[]> {
    // The SQL is matched on its SHAPE, not on its line breaks: a statement
    // written over several lines in the source is one statement to the
    // database, and the fake has to see it the same way. Whitespace is
    // squeezed to single spaces before anything is compared.
    const text = strings.join(' ').replace(/\s+/g, ' ').toLowerCase();
    state.statements.push({ text, inTransaction: state.depth > 0 });

    if (text.includes('from auth.users limit 1')) {
      return state.owner ? [{ '1': 1 }] : [];
    }
    if (text.includes('from auth.users u')) {
      // The sign-in read: the account and its credential.
      if (!state.owner) return [];
      return [
        {
          id: state.owner.id,
          email: state.owner.email,
          password_hash: 'pbkdf2_sha256$600000$c2FsdA$aGFzaA',
          failed_attempts: 0,
          locked_until: null,
        },
      ];
    }
    if (text.includes('select password_hash, locked_until from auth.local_credentials')) {
      // The sign-in's SECOND read of the credential: the one it makes under
      // the account's lock, after the password has been verified, to check
      // that the credential it verified is still the credential there now.
      //
      // It has to be modelled, not ignored. An empty result here reads as
      // "the credential is gone", and the sign-in refuses — so a fake that
      // dropped this branch would turn a sign-in that works into a 401, and
      // the test would be measuring the fake rather than the route.
      if (!state.owner) return [];
      return [{ password_hash: 'pbkdf2_sha256$600000$c2FsdA$aGFzaA', locked_until: null }];
    }
    if (text.includes('insert into auth.users')) {
      if (state.failUserInsert) throw new Error('the owner could not be created');
      state.owner = { id: USER_ID, email: String(values[0]) };
      return [state.owner];
    }
    if (text.includes('insert into auth.local_credentials')) return [];
    if (text.includes('update auth.local_credentials')) return [];
    if (text.includes('from profiles where id')) return [{ role: 'ops' }];
    if (text.includes('insert into tenants')) return [{ id: TENANT_ID }];
    if (text.includes('select tenant_id from tenant_memberships')) {
      return [{ tenant_id: TENANT_ID }];
    }
    if (text.includes('insert into tenant_memberships')) return [];
    if (text.includes('insert into app_state')) {
      if (state.failAppStateWrite) throw new Error('the first-run window could not be closed');
      state.appState[String(values[0])] = String(values[1]);
      return [];
    }
    if (text.includes('from app_state where key')) {
      const value = state.appState[String(values[0])];
      return value === undefined ? [] : [{ value }];
    }
    return [];
  }

  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => run(strings, values);
  (sql as unknown as { begin: unknown }).begin = async (cb: (tx: unknown) => unknown) => {
    const appStateBefore = { ...state.appState };
    const ownerBefore = state.owner;
    state.depth += 1;
    try {
      const out = await cb(sql);
      state.depth -= 1;
      return out;
    } catch (e) {
      state.depth -= 1;
      state.appState = { ...appStateBefore };
      state.owner = ownerBefore;
      throw e;
    }
  };

  return { state, sql };
});

vi.mock('@/lib/db/local', () => ({
  localDb: async () => fake.sql,
}));

// PBKDF2 at 600,000 iterations takes seconds. The window is not about the
// password, and a unit test should not pay for a key derivation to prove it.
vi.mock('@/lib/auth/password', () => ({
  hashPassword: async (password: string) => `pbkdf2_sha256$600000$c2FsdA$${password.length}`,
  verifyPassword: async () => true,
  needsRehash: () => false,
}));

const SETUP_BODY = {
  email: 'owner@brownhill.test',
  password: 'a-password-of-twelve',
  fullName: 'The Owner',
  businessName: 'Brownhill Group Limited',
};

/** A JSON POST, as the browser makes it. */
function jsonRequest(body: unknown, url = 'http://brownhill.test/api/auth/local/setup'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A signed POST to the bootstrap endpoint, as the handover's curl makes it. */
function signedRequest(body: string): NextRequest {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', BOOTSTRAP_TOKEN)
    .update(`POST/api/v1/bootstrap${t}${body}`)
    .digest('hex');
  return {
    text: async () => body,
    headers: new Headers({ 'x-bootstrap-t': String(t), 'x-bootstrap-sig': sig }),
  } as unknown as NextRequest;
}

/** Load a route module with DEPLOYMENT_PROFILE set, so its module-scope gate sees it. */
async function load<T>(path: string, profile: string): Promise<T> {
  process.env.DEPLOYMENT_PROFILE = profile;
  vi.resetModules();
  return (await import(path)) as T;
}

/** The statements that wrote the first-run window. */
function windowWrites(): Array<{ text: string; inTransaction: boolean }> {
  return fake.state.statements.filter((s) => s.text.includes('insert into app_state'));
}

beforeEach(() => {
  process.env.LOCAL_JWT_SECRET = 'the-bootstrap-window-test-secret';
  process.env.BOOTSTRAP_TOKEN = BOOTSTRAP_TOKEN;
  fake.state.statements = [];
  fake.state.owner = null;
  fake.state.appState = { bootstrap_pending: '1' };
  fake.state.depth = 0;
  fake.state.failUserInsert = false;
  fake.state.failAppStateWrite = false;
});

afterEach(() => {
  delete process.env.DEPLOYMENT_PROFILE;
  delete process.env.LOCAL_JWT_SECRET;
  delete process.env.BOOTSTRAP_TOKEN;
});

describe('the first-run window', () => {
  it('closes when the browser setup creates the owner', async () => {
    const mod = await load<typeof import('@/app/api/auth/local/setup/route')>(
      '@/app/api/auth/local/setup/route',
      'hosted',
    );
    const res = await mod.POST(jsonRequest(SETUP_BODY));

    expect(res.status).toBe(200);
    expect(fake.state.appState.bootstrap_pending).toBe('0');
  });

  it('closes in the same transaction as the account it describes', async () => {
    const mod = await load<typeof import('@/app/api/auth/local/setup/route')>(
      '@/app/api/auth/local/setup/route',
      'hosted',
    );
    await mod.POST(jsonRequest(SETUP_BODY));

    const account = fake.state.statements.find((s) => s.text.includes('insert into auth.users'));
    expect(account, 'the owner account was created').toBeDefined();
    expect(account!.inTransaction, 'the owner account was created in a transaction').toBe(true);

    const writes = windowWrites();
    expect(writes.length, 'the window was written').toBe(1);
    expect(writes[0].inTransaction, 'the window was closed in that same transaction').toBe(true);
  });

  it('takes the first-run lock before it checks whether an account exists', async () => {
    // WHY THIS TEST EXISTS
    // --------------------
    // The window closing in the same transaction as the account is NOT the
    // same thing as two setups not racing each other. The transaction makes
    // the account and the flag land together; it does not make two CONCURRENT
    // setups take turns.
    //
    // Two setups with different emails can both open a transaction, both read
    // `auth.users`, both see nothing, and both insert an owner. The only
    // serialisation point was the `app_state` upsert at the END of the
    // transaction — by which time BOTH owners existed, and the install had two
    // tenants and two owners on a product that is single-tenant by contract.
    //
    // The fix is an advisory lock taken at the TOP of the transaction, before
    // the account check: the second setup waits, and when it gets the lock it
    // sees the first setup's committed account and refuses. So the lock has
    // to be (a) an xact lock, so the transaction holds it, (b) taken inside
    // the transaction, so it is released by commit or rollback, and (c)
    // taken BEFORE the check, so the check it guards is the one that matters.
    //
    // The fake records the ORDER and the transaction-ness of every statement,
    // which is exactly the property under test. The concurrency itself is
    // proved against a real database by
    // `tests/integration/auth/first-run-race.test.ts`.
    const mod = await load<typeof import('@/app/api/auth/local/setup/route')>(
      '@/app/api/auth/local/setup/route',
      'hosted',
    );
    await mod.POST(jsonRequest(SETUP_BODY));

    const lock = fake.state.statements.findIndex((s) => s.text.includes('pg_advisory_xact_lock'));

    // The check that matters is the one INSIDE the transaction — the one that
    // decides whether to insert an owner. The route's own read happens
    // earlier, outside any transaction: it is the advisory "is the door still
    // open?" read that decides whether to offer first-run setup at all, and it
    // is allowed to be stale, because the authoritative check is the one the
    // lock guards.
    const guardedChecks = fake.state.statements
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.text.includes('from auth.users limit 1') && s.inTransaction);

    expect(lock, 'the first-run lock was never taken').toBeGreaterThanOrEqual(0);
    expect(
      fake.state.statements[lock].inTransaction,
      'the lock must be held by the transaction, not by the statement that took it',
    ).toBe(true);
    expect(
      guardedChecks.length,
      'the account check did not run inside the transaction at all',
    ).toBeGreaterThan(0);
    expect(
      lock,
      'the lock must be taken BEFORE the account check, or two setups can both see zero accounts',
    ).toBeLessThan(guardedChecks[0].i);
  });

  it('does not report success when the window cannot be closed', async () => {
    fake.state.failAppStateWrite = true;
    const mod = await load<typeof import('@/app/api/auth/local/setup/route')>(
      '@/app/api/auth/local/setup/route',
      'hosted',
    );
    const res = await mod.POST(jsonRequest(SETUP_BODY));

    // A green setup on an installation that still believes it is pending is
    // the defect. The setup has to fail instead.
    expect(res.status).not.toBe(200);
    expect(fake.state.appState.bootstrap_pending).toBe('1');
    expect(fake.state.owner, 'the account was rolled back with the window').toBe(null);
  });

  it('stays armed when the owner cannot be created', async () => {
    fake.state.failUserInsert = true;
    const mod = await load<typeof import('@/app/api/auth/local/setup/route')>(
      '@/app/api/auth/local/setup/route',
      'hosted',
    );
    const res = await mod.POST(jsonRequest(SETUP_BODY));

    expect(res.status).not.toBe(200);
    expect(fake.state.appState.bootstrap_pending).toBe('1');
  });

  it('closes when the signed bootstrap endpoint creates the owner', async () => {
    const mod = await load<typeof import('@/app/api/v1/bootstrap/route')>(
      '@/app/api/v1/bootstrap/route',
      'hosted',
    );
    const res = await mod.POST(signedRequest(JSON.stringify(SETUP_BODY)));

    expect(res.status).toBe(200);
    expect(fake.state.appState.bootstrap_pending).toBe('0');

    const writes = windowWrites();
    expect(writes.length, 'the window was written').toBe(1);
    expect(writes[0].inTransaction, 'the window was closed in the setup transaction').toBe(true);
  });

  it('refuses to run setup once the window is closed', async () => {
    fake.state.appState.bootstrap_pending = '0';
    const mod = await load<typeof import('@/app/api/auth/local/setup/route')>(
      '@/app/api/auth/local/setup/route',
      'hosted',
    );
    const res = await mod.POST(jsonRequest(SETUP_BODY));

    expect(res.status).toBe(409);
    expect(fake.state.owner, 'no account was created').toBe(null);
  });

  it('reports that setup is not needed once the window is closed', async () => {
    fake.state.appState.bootstrap_pending = '0';
    const mod = await load<typeof import('@/app/api/auth/local/setup/route')>(
      '@/app/api/auth/local/setup/route',
      'hosted',
    );
    const res = await mod.GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needsSetup: false });
  });

  it('corrects a window that is armed on an installation that already has an owner', async () => {
    // The state the hosted box was left in: the owner account exists, and the
    // flag still says the installation is waiting for its first run.
    fake.state.owner = { id: USER_ID, email: SETUP_BODY.email };
    fake.state.appState.bootstrap_pending = '1';

    const mod = await load<typeof import('@/app/api/auth/local/setup/route')>(
      '@/app/api/auth/local/setup/route',
      'hosted',
    );
    const res = await mod.GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needsSetup: false });
    expect(fake.state.appState.bootstrap_pending).toBe('0');
  });

  it('corrects a stale window when the owner signs in', async () => {
    fake.state.owner = { id: USER_ID, email: SETUP_BODY.email };
    fake.state.appState.bootstrap_pending = '1';

    const mod = await load<typeof import('@/app/api/auth/local/signin/route')>(
      '@/app/api/auth/local/signin/route',
      'hosted',
    );
    const res = await mod.POST(
      jsonRequest(
        { email: SETUP_BODY.email, password: SETUP_BODY.password },
        'http://brownhill.test/api/auth/local/signin',
      ),
    );

    expect(res.status).toBe(200);
    expect(fake.state.appState.bootstrap_pending).toBe('0');
  });

  it('closes the window on the signed door even after the browser door ran', async () => {
    // The browser door created the owner and left the window armed; the
    // signed door then finds an installation that already has its owner and
    // refuses to serve a second first run.
    fake.state.owner = { id: USER_ID, email: SETUP_BODY.email };
    fake.state.appState.bootstrap_pending = '1';

    const mod = await load<typeof import('@/app/api/v1/bootstrap/route')>(
      '@/app/api/v1/bootstrap/route',
      'hosted',
    );
    const res = await mod.POST(signedRequest(JSON.stringify(SETUP_BODY)));

    expect(res.status).toBe(410);
    expect(fake.state.appState.bootstrap_pending).toBe('0');
  });
});
