"use server";

// /lib/actions/change-password.ts
//
// Server action used by per-role profile forms. Mirrors the API route at
// `/api/auth/local/change-password` but is invoked from a Server Component
// <form action={...}> in each role's Profile page.
//
// Why a server action and not just the API route: the per-role Profile
// pages are Server Components (they need the session/profile read on the
// server before render), and a `<form action={changeOwnPasswordAction}>`
// round-trip is the natural fit. Using a server action also means the page
// re-renders with the action's result inline so the user sees "Password
// updated" without a separate client round-trip.
//
// Security model is identical to the API route:
//   1. session — the JWT carried in bf_session, verified against the shared secret
//   2. password — current must verify against the stored hash; new must satisfy
//      the minimum-length rule and must differ from current.

import { cookies } from 'next/headers';
import { readSessionToken, SESSION_COOKIE } from '@/lib/auth/local-session';
import {
  setLocalPassword,
  signInWithPassword,
} from '@/lib/auth/local-store';

export interface ChangePasswordResult {
  ok: boolean;
  error?:
    | 'unauthenticated'
    | 'new_password_too_short'
    | 'mismatch'
    | 'must_differ'
    | 'current_password_incorrect'
    | 'session_mismatch'
    | 'unknown';
  min?: number;
}

const MIN_NEW_PASSWORD_LEN = 12;

export async function changeOwnPasswordAction(
  formData: FormData,
): Promise<ChangePasswordResult> {
  // 1. session — read bf_session cookie exactly like the API route does.
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  const claims = raw ? await readSessionToken(raw) : null;
  if (!claims) return { ok: false, error: 'unauthenticated' };
  const userId = (claims as { sub?: string }).sub;
  const email  = (claims as { email?: string }).email;
  if (!userId || !email) return { ok: false, error: 'unauthenticated' };

  // 2. body
  const current = String(formData.get('current') ?? '');
  const neu     = String(formData.get('new')     ?? '');
  const confirm = String(formData.get('confirm') ?? '');

  if (neu.length < MIN_NEW_PASSWORD_LEN) {
    return { ok: false, error: 'new_password_too_short', min: MIN_NEW_PASSWORD_LEN };
  }
  if (neu !== confirm) return { ok: false, error: 'mismatch' };
  if (current === neu) return { ok: false, error: 'must_differ' };

  // 3. verify current password against the row
  const signin = await signInWithPassword(email, current);
  if (!signin.ok) return { ok: false, error: 'current_password_incorrect' };
  if (signin.user.id !== userId) return { ok: false, error: 'session_mismatch' };

  await setLocalPassword(userId, neu);
  return { ok: true };
}
