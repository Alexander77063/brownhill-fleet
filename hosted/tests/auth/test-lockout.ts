// hosted/tests/auth/test-lockout.ts
// Verifies the existing lockout flow (10 fails → 30 min 423 Locked) on the
// hosted profile. The codebase already implements lockout in
// src/lib/auth/local-store.ts — this test pins the contract.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { localDb } from '@/lib/auth/local-store';

type Sql = Awaited<ReturnType<typeof localDb>>;
let sql: Sql;

const EMAIL_NEW = `lock-${Date.now()}@example.test`;
const EMAIL_OLD = 'lock-old@example.test';

beforeAll(async () => {
  sql = await (await import('@/lib/auth/local-store')).localDb();
  // populate auth.users + auth.local_credentials rows for the two test emails
  await sql`INSERT INTO auth.users(id, email) VALUES (${'u-new'}, ${EMAIL_NEW}) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO auth.users(id, email) VALUES (${'u-old'}, ${EMAIL_OLD}) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO auth.local_credentials(user_id, email, password_hash)
                VALUES (${'u-new'}, ${EMAIL_NEW}, ${'placeholder-hash'})
                  ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`;
  // synthetic "expired lock" row
  await sql`INSERT INTO auth.local_credentials(user_id, email, password_hash, failed_attempts, locked_until)
                VALUES (${'u-old'}, ${EMAIL_OLD}, ${'placeholder-hash'}, 10, now() - interval '31 minutes')
                  ON CONFLICT (email) DO UPDATE SET failed_attempts = 10, locked_until = now() - interval '31 minutes'`;
});

afterAll(async () => {
  await sql`DELETE FROM auth.local_credentials WHERE email LIKE ${'lock-%@example.test'}`;
  await sql`DELETE FROM auth.users WHERE id IN ('u-new', 'u-old')`;
});

const { signInWithPassword } = await import('@/lib/auth/local-store');

describe('auth lockout (hosted profile)', () => {
  it('locks the account after 10 consecutive failures within 10 minutes', async () => {
    // 10 wrong attempts in a row. Each call increments failed_attempts internally.
    let lastResult: unknown = null;
    for (let i = 0; i < 10; i++) {
      lastResult = await signInWithPassword(EMAIL_NEW, 'wrong-password');
    }
    expect(lastResult).toMatchObject({ ok: false, reason: 'locked' });
    // The 11th attempt confirms the lock is still in force.
    const eleventh = await signInWithPassword(EMAIL_NEW, 'wrong-password');
    expect(eleventh).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('treats an expired locked_until as not-locked (no locked reason)', async () => {
    const r = await signInWithPassword(EMAIL_OLD, 'wrong-password');
    // expired-lock state should behave like the first attempt: wrong creds → unknown-credentials.
    expect((r as { ok: boolean; reason?: string }).reason).not.toBe('locked');
  });
});
