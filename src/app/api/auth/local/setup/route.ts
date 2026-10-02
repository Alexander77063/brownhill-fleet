/**
 * First-run setup, for the standalone build.
 *
 * A standalone install ships with an empty database and no way in: no Supabase
 * dashboard, no invite email, no seeded password. This creates the owner's
 * account and the single tenant they operate, then signs them in.
 *
 * It is available exactly once. `createFirstUserAndTenant` refuses if any
 * account already exists, so this cannot be replayed to mint a second owner —
 * which matters because the endpoint has to be reachable without a session.
 */
import { NextResponse } from 'next/server';
import { deploymentProfile } from '@/lib/deployment/profile';
import {
  issueSessionToken,
  SESSION_COOKIE,
  SESSION_SECONDS,
  sessionCookieOptions,
} from '@/lib/auth/local-session';
import { createFirstUserAndTenant, hasAnyUser } from '@/lib/auth/local-store';

export const runtime = 'nodejs';

/** Reports whether setup is still needed, so the sign-in page can redirect. */
export async function GET() {
  if (deploymentProfile().supabaseAuth) {
    return new NextResponse('Not found', { status: 404 });
  }
  try {
    return NextResponse.json({ needsSetup: !(await hasAnyUser()) });
  } catch {
    // The database not being up yet is not "setup needed" — claiming it were
    // would show a new-install form to an existing customer.
    return NextResponse.json({ needsSetup: false, unavailable: true }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (deploymentProfile().supabaseAuth) {
    return new NextResponse('Not found', { status: 404 });
  }

  let email = '';
  let password = '';
  let fullName = '';
  let businessName = '';
  try {
    const body = (await request.json()) as Record<string, unknown>;
    email = typeof body.email === 'string' ? body.email.trim() : '';
    password = typeof body.password === 'string' ? body.password : '';
    fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
    businessName = typeof body.businessName === 'string' ? body.businessName.trim() : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }
  if (!businessName) {
    return NextResponse.json({ error: 'Enter your business name.' }, { status: 400 });
  }
  // Length is the property that actually matters; a composition rule would push
  // people toward "Password1!" and no further.
  if (password.length < 12) {
    return NextResponse.json(
      { error: 'Use a password of at least 12 characters.' },
      { status: 400 },
    );
  }

  let created: Awaited<ReturnType<typeof createFirstUserAndTenant>>;
  try {
    created = await createFirstUserAndTenant({
      email,
      password,
      fullName: fullName || email,
      businessName,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Setup failed.';
    console.error('[auth] setup failed', e);
    // "Already completed" is the caller's fault; anything else is ours.
    const already = message.includes('already been completed');
    return NextResponse.json({ error: message }, { status: already ? 409 : 500 });
  }

  const token = await issueSessionToken(created.user, created.tenantId);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_SECONDS));
  return response;
}
