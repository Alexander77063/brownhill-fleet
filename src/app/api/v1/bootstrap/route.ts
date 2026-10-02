// src/app/api/v1/bootstrap/route.ts
// HMAC-signed first-run endpoint for the hosted profile.
// Reachable only when app_state.bootstrap_pending='1'; signed within ±60s.
// Replay returns 410 Gone. The BOOTSTRAP_TOKEN lives in /etc/brownhill/secrets/bootstrap.env.

import { NextRequest, NextResponse } from 'next/server';
import { createFirstUserAndTenant, localDb } from '@/lib/auth/local-store';
import { issueAccessPair } from '@/lib/auth/access-tokens';
import { verifyBootstrapSignature } from './_verify';
import { getAppState, setAppState } from '@/lib/app-state';

const HOSTED = process.env.DEPLOYMENT_PROFILE === 'hosted';

export async function POST(req: NextRequest) {
  if (!HOSTED) return new NextResponse('Not found', { status: 404 });

  const raw = await req.text();
  const t = Number(req.headers.get('x-bootstrap-t') ?? '0');
  const sig = req.headers.get('x-bootstrap-sig') ?? '';
  if (!verifyBootstrapSignature({ t, sig, method: 'POST', path: '/api/v1/bootstrap', body: raw })) {
    return NextResponse.json({ error: 'bad_signature' }, { status: 401 });
  }

  const sql = await localDb();
  const pending = await getAppState(sql, 'bootstrap_pending');
  if (pending !== '1') return NextResponse.json({ error: 'gone' }, { status: 410 });

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

  await setAppState(sql, 'bootstrap_pending', '0');
  const { access, refresh } = await issueAccessPair({
    sub: created.user,
    role: 'authenticated',
    tenant_id: created.tenantId,
    email: body.email,
  });
  return NextResponse.json({
    ok: true,
    user: { id: created.user },
    tenantId: created.tenantId,
    access,
    refresh,
  });
}
