import { NextResponse, type NextRequest } from 'next/server';
import { deploymentProfile } from '@/lib/deployment/profile';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/local-session';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { currentUserId } from '@/lib/auth/context';

export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/login', request.url), { status: 303 });

  // Stop web push to this user's devices: signing out on a phone must end the
  // alerts arriving on it. Best-effort, never blocks the sign-out.
  try {
    const userId = await currentUserId();
    if (userId) await createServiceClient().from('push_subscriptions').delete().eq('user_id', userId);
  } catch (e) {
    console.error('[signout] could not remove push subscriptions', e);
  }

  if (!deploymentProfile().supabaseAuth) {
    // A standalone install has no Supabase Auth session to end — the session is
    // our own cookie, so clearing it IS signing out. Calling signOut() here
    // would be a no-op against a service that does not exist, and the user
    // would appear to sign out and still be signed in.
    response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0));
    return response;
  }

  const supabase = await createClient();
  await supabase.auth.signOut();
  return response;
}
