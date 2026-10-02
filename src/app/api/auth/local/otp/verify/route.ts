/**
 * Verify a one-time code and sign the owner in.
 *
 * On success the phone is resolved to an owner account (creating and linking
 * one on first sign-in, or a whole tenant on the shared instance) and the same
 * HS256 session cookie the password path issues is set — for thirty days,
 * since this is a phone app for a person, not a shift at a desk.
 */
import { NextResponse } from 'next/server';
import { deploymentProfile } from '@/lib/deployment/profile';
import { verifyLoginCode } from '@/lib/auth/otp-store';
import { resolveOwnerSignIn } from '@/lib/auth/owner-signin';
import { pgOwnerStore } from '@/lib/auth/owner-store';
import {
  issueSessionToken,
  OWNER_SESSION_SECONDS,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '@/lib/auth/local-session';
import { normalisePhone } from '@/lib/phone';
import { safeNextPath } from '@/lib/safe-next';

export const runtime = 'nodejs';

const REFUSALS: Record<string, string> = {
  ambiguous: 'This number is linked to more than one account. Contact support.',
  unknown: "We don't recognise this number. Ask your fleet or insurer to add you.",
  hijack: 'This number cannot be used to sign in. Contact support.',
  staff: 'Staff accounts sign in with a password.',
};

export async function POST(request: Request) {
  const profile = deploymentProfile();
  if (profile.supabaseAuth) return new NextResponse('Not found', { status: 404 });

  let raw = '';
  let code = '';
  let next = '/';
  try {
    const b = (await request.json()) as { phone?: unknown; code?: unknown; next?: unknown };
    raw = String(b.phone ?? '');
    code = String(b.code ?? '').replace(/\D/g, '');
    // Only a same-origin path: an SMS link lands on a report, never elsewhere.
    next = safeNextPath(b.next);
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const phone = normalisePhone(raw);
  if (!phone || code.length !== 6) {
    return NextResponse.json({ error: 'That code is not right.' }, { status: 400 });
  }

  const v = await verifyLoginCode(phone, code);
  if (v === 'locked') {
    return NextResponse.json({ error: 'Too many attempts. Request a new code.' }, { status: 429 });
  }
  if (v !== 'ok') return NextResponse.json({ error: 'That code is not right.' }, { status: 401 });

  let decision: Awaited<ReturnType<typeof resolveOwnerSignIn>>;
  try {
    decision = await resolveOwnerSignIn(phone, profile, pgOwnerStore);
  } catch (e) {
    console.error('[auth] owner sign-in failed', e);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 503 });
  }
  if (!decision.ok) return NextResponse.json({ error: REFUSALS[decision.reason] }, { status: 403 });

  const token = await issueSessionToken({ id: decision.userId }, decision.tenantId, OWNER_SESSION_SECONDS);
  const res = NextResponse.json({ ok: true, next });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(OWNER_SESSION_SECONDS));
  return res;
}
