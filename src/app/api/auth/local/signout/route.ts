/**
 * Sign out, for the standalone build.
 *
 * Clears the session cookie. There is no server-side session to revoke — the
 * JWT is self-contained, which is what lets PostgREST verify it without a
 * round trip — so the token stays technically valid until it expires. That is
 * the accepted trade of stateless sessions, bounded by the eight-hour lifetime,
 * and on a single-tenant desktop install the token never leaves the machine.
 */
import { NextResponse } from 'next/server';
import { deploymentProfile } from '@/lib/deployment/profile';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/local-session';
import { currentUserId } from '@/lib/auth/context';
import { createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

function clear() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0));
  return response;
}

export async function POST() {
  if (deploymentProfile().supabaseAuth) {
    return new NextResponse('Not found', { status: 404 });
  }
  await forgetPushSubscriptions();
  return clear();
}

/**
 * Signing out on a phone must also stop alerts arriving on it: an owner who
 * hands the phone on would otherwise keep receiving their car's location.
 * Best-effort — a failure here never blocks the sign-out.
 */
async function forgetPushSubscriptions(): Promise<void> {
  try {
    const userId = await currentUserId();
    if (!userId) return;
    await createServiceClient().from('push_subscriptions').delete().eq('user_id', userId);
  } catch (e) {
    console.error('[signout] could not remove push subscriptions', e);
  }
}
