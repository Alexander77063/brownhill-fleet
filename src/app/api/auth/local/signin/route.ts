/**
 * Sign in, for the standalone build.
 *
 * Supabase Auth is a hosted service and is not part of a standalone install, so
 * this endpoint replaces it. It verifies the password against
 * `auth.local_credentials`, mints the HS256 JWT PostgREST will verify, and sets
 * it as an httpOnly cookie.
 *
 * It 404s under any other profile. The hosted product must not grow a second
 * way to sign in — one that skips Supabase Auth's own protections — merely
 * because the code happens to be in the same repository.
 */
import { NextResponse } from 'next/server';
import { deploymentProfile } from '@/lib/deployment/profile';
import {
  issueSessionToken,
  SESSION_COOKIE,
  SESSION_SECONDS,
  sessionCookieOptions,
} from '@/lib/auth/local-session';
import { primaryTenantId, signInWithPassword } from '@/lib/auth/local-store';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (deploymentProfile().supabaseAuth) {
    return new NextResponse('Not found', { status: 404 });
  }

  let email = '';
  let password = '';
  try {
    const body = (await request.json()) as { email?: unknown; password?: unknown };
    email = typeof body.email === 'string' ? body.email : '';
    password = typeof body.password === 'string' ? body.password : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  if (!email || !password) {
    return NextResponse.json({ error: 'Enter your email and password.' }, { status: 400 });
  }

  let result: Awaited<ReturnType<typeof signInWithPassword>>;
  try {
    result = await signInWithPassword(email, password);
  } catch (e) {
    // The database being unreachable is an operational fault, not a bad
    // password, and saying so saves a customer trying their password ten times.
    console.error('[auth] sign-in failed', e);
    return NextResponse.json(
      { error: 'The system is still starting up. Please try again in a moment.' },
      { status: 503 },
    );
  }

  if (!result.ok) {
    if (result.reason === 'locked') {
      const mins = result.retryAfter
        ? Math.max(1, Math.ceil((result.retryAfter.getTime() - Date.now()) / 60_000))
        : 15;
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` },
        { status: 429 },
      );
    }
    // One message for both "no such user" and "wrong password".
    return NextResponse.json({ error: 'Those details do not match.' }, { status: 401 });
  }

  const tenantId = await primaryTenantId(result.user.id);
  const token = await issueSessionToken(result.user, tenantId);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_SECONDS));
  return response;
}
