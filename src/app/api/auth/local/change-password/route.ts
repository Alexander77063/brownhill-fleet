// src/app/api/auth/local/change-password/route.ts
//
// Change your own password. Standalone build only (SaaS redirects to Supabase
// Auth). Authentication is via the existing bf_session cookie — the route
// reads the same JWT the sign-in route mints, verifies it against the same
// shared secret, and uses the user id from the claims as the row to update.
//
// Verification:
//   1. cookie must be a valid bf_session JWT signed with LOCAL_JWT_SECRET
//   2. the body's `current` field must verify against auth.local_credentials.password_hash
//      (defends against session hijack by requiring the attacker also knows the password)
//   3. the new password must satisfy the same minimum-length rule the first-run
//      route enforces (12 chars), so an admin forcing a short password into the
//      password column can't create an account that's easy to brute-force
//
// On success: updates the row, clears failed_attempts and locked_until.
// Returns { ok: true } on success, typed errors otherwise.
import { NextResponse } from 'next/server';
import { deploymentProfile } from '@/lib/deployment/profile';
import { readSessionToken } from '@/lib/auth/local-session';
import {
  primaryTenantId,
  setLocalPassword,
  signInWithPassword,
} from '@/lib/auth/local-store';

export const runtime = 'nodejs';

const MIN_NEW_PASSWORD_LEN = 12;

export async function POST(request: Request): Promise<NextResponse> {
  if (deploymentProfile().supabaseAuth) {
    return new NextResponse('Not found', { status: 404 });
  }

  // 1. session — JWT in bf_session cookie
  const cookieHeader = request.headers.get('cookie') ?? '';
  const m = /(^|;\s*)bf_session=([^;]+)/.exec(cookieHeader);
  const rawToken = m ? decodeURIComponent(m[2]) : undefined;
  const claims = rawToken ? await readSessionToken(rawToken) : null;
  if (!claims) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const userId = (claims as { sub?: string }).sub;
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // 2. body — current and new password
  let currentPwd = '';
  let newPwd = '';
  let confirmPwd = '';
  try {
    const body = (await request.json()) as Record<string, unknown>;
    currentPwd = typeof body.current === 'string' ? body.current : '';
    newPwd     = typeof body.new === 'string' ? body.new : '';
    confirmPwd = typeof body.confirm === 'string' ? body.confirm : '';
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (newPwd.length < MIN_NEW_PASSWORD_LEN) {
    return NextResponse.json({ error: 'new_password_too_short', min: MIN_NEW_PASSWORD_LEN }, { status: 400 });
  }
  if (newPwd !== confirmPwd) {
    return NextResponse.json({ error: 'mismatch' }, { status: 400 });
  }
  if (currentPwd === newPwd) {
    return NextResponse.json({ error: 'must_differ' }, { status: 400 });
  }

  // 3. verify current password against the DB row for this user id.
  //    signInWithPassword uses email, so we look up email from JWT claims.
  const email = (claims as { email?: string }).email ?? null;
  if (!email) {
    return NextResponse.json({ error: 'email_unknown' }, { status: 400 });
  }
  const signin = await signInWithPassword(email, currentPwd);
  if (!signin.ok) {
    return NextResponse.json({ error: 'current_password_incorrect' }, { status: 401 });
  }
  // signin returned — but the user id from the JWT must match the user id
  // in the credentials row. Block any attempt to mutate a row that the
  // caller's session doesn't point at.
  if (signin.user.id !== userId) {
    return NextResponse.json({ error: 'session_mismatch' }, { status: 403 });
  }

  await setLocalPassword(userId, newPwd);
  const tenantId = await primaryTenantId(userId);

  return NextResponse.json({ ok: true, tenant_id: tenantId });
}
