// src/app/api/v1/bootstrap/route.ts
// HMAC-signed first-run endpoint for the hosted profile.
// Reachable only when app_state.bootstrap_pending='1'; signed within ±60s.
// Replay returns 410 Gone. The BOOTSTRAP_TOKEN lives in /etc/brownhill/secrets/bootstrap.env.

import { NextRequest, NextResponse } from 'next/server';
import { createFirstUserAndTenant, firstRunOpen, localDb } from '@/lib/auth/local-store';
import { issueAccessPair } from '@/lib/auth/access-tokens';
import { verifyBootstrapSignature } from './_verify';
import { deploymentProfile } from '@/lib/deployment/profile';

// First-run setup exists only on a box the customer operates. It used to gate
// on `DEPLOYMENT_PROFILE === 'standalone'` — the *desktop* product — so on the
// hosted deployment Brownhill actually runs, this answered 404 and a fresh
// install had no way to create its first account.
const CUSTOMER_OPS = deploymentProfile().customerOps;

export async function POST(req: NextRequest) {
  if (!CUSTOMER_OPS) return new NextResponse('Not found', { status: 404 });

  const raw = await req.text();
  const t = Number(req.headers.get('x-bootstrap-t') ?? '0');
  const sig = req.headers.get('x-bootstrap-sig') ?? '';
  if (!verifyBootstrapSignature({ t, sig, method: 'POST', path: '/api/v1/bootstrap', body: raw })) {
    return NextResponse.json({ error: 'bad_signature' }, { status: 401 });
  }

  const sql = await localDb();
  // The first-run window decides whether this door may serve. `firstRunOpen()`
  // asks the database whether the installation already has an owner as well
  // as reading the flag, so an installation whose setup completed on the
  // other door — the browser page at /setup — is closed here too, and a flag
  // left armed on such an installation is corrected rather than believed.
  if (!(await firstRunOpen(sql))) {
    return NextResponse.json({ error: 'gone' }, { status: 410 });
  }

  let body: { email: string; password: string; fullName: string; businessName: string };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    body = {
      email: String(parsed.email ?? '').trim(),
      password: String(parsed.password ?? ''),
      fullName: String(parsed.fullName ?? '').trim(),
      businessName: String(parsed.businessName ?? '').trim(),
    };
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (!body.email || !body.email.includes('@')) {
    return NextResponse.json({ error: 'enter a valid email' }, { status: 400 });
  }
  if (body.password.length < 12) {
    return NextResponse.json({ error: 'password must be ≥ 12 characters' }, { status: 400 });
  }
  if (!body.businessName) {
    return NextResponse.json({ error: 'enter your business name' }, { status: 400 });
  }

  let created: Awaited<ReturnType<typeof createFirstUserAndTenant>>;
  try {
    created = await createFirstUserAndTenant({
      email: body.email,
      password: body.password,
      fullName: body.fullName || body.email,
      businessName: body.businessName,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'setup failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // The window is closed by `createFirstUserAndTenant`, in the same
  // transaction as the owner account it describes — not here, afterwards,
  // where a failure between the two would leave a green setup on an
  // installation that still believes it is pending.
  const { access, refresh } = await issueAccessPair({
    sub: created.user.id,
    role: 'authenticated',
    tenant_id: created.tenantId,
    email: body.email,
  });
  return NextResponse.json({
    ok: true,
    user: { id: created.user.id },
    tenantId: created.tenantId,
    access,
    refresh,
  });
}
