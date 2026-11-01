// tests/unit/password-reset-store.test.ts
//
// The store the operator's password reset actually reads through.
//
// WHY THIS TEST EXISTS
// --------------------
// The cross-tenant guard on a password reset works by asking the store for
// EVERY membership the target holds. If the user belongs to a second
// organisation where the caller has no authority, the reset is refused.
//
// The guard was reading those memberships like this:
//
//     const { data } = await sb.from('tenant_memberships').select(...).eq(...);
//     const rows = data ?? [];
//
// PostgREST answers a failed query with `{ data: null, error }`. `data ?? []`
// turns that into an EMPTY LIST — which is indistinguishable from "this person
// belongs to one tenant". The guard was therefore skipped, and the reset
// proceeded exactly as it did before the guard existed. The check that closes
// the vulnerability failed OPEN.
//
// These tests pin the fix at both ends:
//
//   * a read that reports an error is an error, not an empty list;
//   * a read that reports an error aborts the reset before anything is
//     written.
//
// The store lives in its own module, with the database client injected, so
// the real production store can be driven by a fake reader here. It could not
// be tested where it used to live — inside a `'use server'` file, where only
// async functions may be exported.

import { describe, expect, it } from 'vitest';
import { resetMemberPassword } from '@/lib/auth/password-reset';
import {
  makePasswordResetStore,
  type PostgrestReader,
  type PostgrestResult,
} from '@/lib/auth/password-reset-store';

/**
 * A fake PostgREST reader.
 *
 * `handlers` maps a table name to the answer that table gives. The handler
 * sees the filters that were applied, so one table can answer differently
 * depending on which query asked — which is what distinguishes the
 * tenant-scoped member lookup from the cross-tenant membership list, since
 * they read the same table.
 */
function fakeReader(
  handlers: Record<string, (filters: Record<string, string>) => PostgrestResult>,
): PostgrestReader {
  function respond(table: string, filters: Record<string, string>): PostgrestResult {
    const handler = handlers[table];
    if (!handler) {
      return { data: null, error: { message: `no handler for ${table}` } };
    }
    return handler(filters);
  }

  return {
    from(table: string) {
      return {
        select(_columns: string) {
          const filters: Record<string, string> = {};
          const builder = {
            eq(column: string, value: string) {
              filters[column] = value;
              return builder;
            },
            async maybeSingle() {
              const result = respond(table, filters);
              // PostgREST's `maybeSingle` returns one row, not a list.
              return {
                ...result,
                data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data,
              };
            },
            then<TResult1 = PostgrestResult, TResult2 = never>(
              onfulfilled?:
                | ((value: PostgrestResult) => TResult1 | PromiseLike<TResult1>)
                | null,
              onrejected?:
                | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
                | null,
            ) {
              return Promise.resolve(respond(table, filters)).then(onfulfilled, onrejected);
            },
          };
          return builder;
        },
      };
    },
  };
}

/** A store with recording stubs for everything that touches the database. */
function makeStoreWith(reader: PostgrestReader) {
  const calls = {
    setPassword: [] as Array<[string, string]>,
    deliver: [] as Array<[string, string]>,
  };
  const store = makePasswordResetStore({
    reader,
    async hasPassword() {
      return true;
    },
    async setPassword(userId, password) {
      calls.setPassword.push([userId, password]);
    },
    async deliver(member, password) {
      calls.deliver.push([member.userId, password]);
      return { sent: true };
    },
  });
  return { store, calls };
}

describe('reading the memberships', () => {
  it('throws when the read reports an error', async () => {
    // The whole point. A failed read is not an empty list.
    const { store } = makeStoreWith(
      fakeReader({
        tenant_memberships: () => ({ data: null, error: { message: 'connection failure' } }),
      }),
    );

    await expect(store.findMemberships('user-1')).rejects.toThrow(/membership/i);
  });

  it('names the underlying failure, so the log says what happened', async () => {
    const { store } = makeStoreWith(
      fakeReader({
        tenant_memberships: () => ({ data: null, error: { message: 'PGRST116' } }),
      }),
    );

    await expect(store.findMemberships('user-1')).rejects.toThrow(/PGRST116/);
  });

  it('returns the memberships when the read succeeds', async () => {
    const { store } = makeStoreWith(
      fakeReader({
        tenant_memberships: () => ({
          data: [
            { tenant_id: 'tenant-a', role: 'driver', status: 'active' },
            { tenant_id: 'tenant-b', role: 'tenant_admin', status: 'active' },
          ],
          error: null,
        }),
      }),
    );

    expect(await store.findMemberships('user-1')).toEqual([
      { tenantId: 'tenant-a', role: 'driver', status: 'active' },
      { tenantId: 'tenant-b', role: 'tenant_admin', status: 'active' },
    ]);
  });

  it('returns an empty list when the read succeeds and there are no memberships', async () => {
    // An empty list and a failed read must not look the same. This one is a
    // genuine answer.
    const { store } = makeStoreWith(
      fakeReader({
        tenant_memberships: () => ({ data: [], error: null }),
      }),
    );

    expect(await store.findMemberships('user-1')).toEqual([]);
  });
});

describe('reading the member', () => {
  const MEMBER_ROW = { user_id: 'user-1', role: 'driver', status: 'active' };

  it('throws when the membership read reports an error', async () => {
    // Not null. Null means "this person is not in this organisation", and
    // saying that about a database that was merely unreachable sends the
    // operator looking in the wrong place.
    const { store } = makeStoreWith(
      fakeReader({
        tenant_memberships: () => ({ data: null, error: { message: 'connection failure' } }),
      }),
    );

    await expect(store.findMember('tenant-a', 'user-1')).rejects.toThrow(/member/i);
  });

  it('throws when the profile read reports an error', async () => {
    const { store } = makeStoreWith(
      fakeReader({
        tenant_memberships: () => ({ data: MEMBER_ROW, error: null }),
        profiles: () => ({ data: null, error: { message: 'connection failure' } }),
      }),
    );

    await expect(store.findMember('tenant-a', 'user-1')).rejects.toThrow(/profile/i);
  });

  it('returns null when there genuinely is no membership', async () => {
    const { store } = makeStoreWith(
      fakeReader({
        tenant_memberships: () => ({ data: null, error: null }),
      }),
    );

    expect(await store.findMember('tenant-a', 'user-1')).toBeNull();
  });

  it('returns the member, with the name and address from the profile', async () => {
    const { store } = makeStoreWith(
      fakeReader({
        tenant_memberships: () => ({ data: MEMBER_ROW, error: null }),
        profiles: () => ({
          data: { full_name: 'Alex Driver', email: 'driver@example.test' },
          error: null,
        }),
      }),
    );

    expect(await store.findMember('tenant-a', 'user-1')).toEqual({
      userId: 'user-1',
      role: 'driver',
      status: 'active',
      fullName: 'Alex Driver',
      email: 'driver@example.test',
    });
  });

  it('scopes the membership lookup to the tenant it was given', async () => {
    // The tenant filter is what makes a user id from another tenant simply
    // not found. Watch that it is actually applied.
    const seen: Record<string, string>[] = [];
    const reader = fakeReader({
      tenant_memberships: (filters) => {
        seen.push({ ...filters });
        return { data: null, error: null };
      },
    });
    const { store } = makeStoreWith(reader);

    await store.findMember('tenant-a', 'user-1');

    expect(seen).toEqual([{ tenant_id: 'tenant-a', user_id: 'user-1' }]);
  });
});

describe('the real store, wired to the real reset', () => {
  const MEMBER_ROW = { user_id: 'user-1', role: 'driver', status: 'active' };

  it('does not write a password when the memberships cannot be read', async () => {
    // The proof that matters: the production store and the production
    // decision module, together, refuse and write nothing when the
    // cross-tenant read fails.
    const { store, calls } = makeStoreWith(
      fakeReader({
        tenant_memberships: (filters) =>
          // The tenant-scoped lookup succeeds; the cross-tenant list fails.
          filters.tenant_id
            ? { data: MEMBER_ROW, error: null }
            : { data: null, error: { message: 'connection failure' } },
        profiles: () => ({
          data: { full_name: 'Alex Driver', email: 'driver@example.test' },
          error: null,
        }),
      }),
    );

    const result = await resetMemberPassword({
      tenantId: 'tenant-a',
      userId: 'user-1',
      callerRole: 'ops',
      store,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('failed');
    expect(calls.setPassword).toEqual([]);
    expect(calls.deliver).toEqual([]);
  });

  it('does not write a password when the member cannot be read', async () => {
    const { store, calls } = makeStoreWith(
      fakeReader({
        tenant_memberships: () => ({ data: null, error: { message: 'connection failure' } }),
      }),
    );

    const result = await resetMemberPassword({
      tenantId: 'tenant-a',
      userId: 'user-1',
      callerRole: 'ops',
      store,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('failed');
    expect(calls.setPassword).toEqual([]);
    expect(calls.deliver).toEqual([]);
  });

  it('still resets when every read succeeds', async () => {
    // The happy path must not have been broken by the guard.
    const { store, calls } = makeStoreWith(
      fakeReader({
        tenant_memberships: (filters) =>
          filters.tenant_id
            ? { data: MEMBER_ROW, error: null }
            : { data: [{ tenant_id: 'tenant-a', role: 'driver', status: 'active' }], error: null },
        profiles: () => ({
          data: { full_name: 'Alex Driver', email: 'driver@example.test' },
          error: null,
        }),
      }),
    );

    const result = await resetMemberPassword({
      tenantId: 'tenant-a',
      userId: 'user-1',
      callerRole: 'ops',
      store,
      generate: () => 'generated-password',
    });

    expect(result.ok).toBe(true);
    expect(calls.setPassword).toEqual([['user-1', 'generated-password']]);
  });
});
