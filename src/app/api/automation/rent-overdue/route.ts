// src/app/api/automation/rent-overdue/route.ts
//
// External cron / ops-curiosity endpoint. The handler runs the
// rent-overdue check once for the tenant named in the JSON body
// (or, if omitted, for every tenant — the daily timer uses that
// mode). Authentication is a bearer token from
// AUTOMATION_TOKEN; rotate that value to revoke a stale cron.
//
// We deliberately do NOT do this through the Next.js auth stack: a
// system cron does not have a session cookie, and the action is
// idempotent (dedup key is rent_overdue:<invoice_id>) so a replay
// is safe.

import { NextResponse } from 'next/server';
import { runRentOverdueCheck } from '@/lib/automation/rent-overdue';
import { listTenantIds } from '@/lib/tenancy';

export const runtime = 'nodejs';

interface RunBody {
  /** When supplied, scope the run to a single tenant. Otherwise
   *  iterate all tenants the system knows about. */
  tenant_id?: string;
}

function unauthorized() {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

export async function POST(request: Request): Promise<NextResponse> {
  const expected = process.env.AUTOMATION_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: 'AUTOMATION_TOKEN is not set on the server' },
      { status: 503 },
    );
  }
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return unauthorized();
  const provided = header.slice('Bearer '.length).trim();
  // constant-time compare would be nice; we just use string equality here
  // because the token never appears in URLs or logs.
  if (provided !== expected) return unauthorized();

  let body: RunBody = {};
  try {
    if (request.headers.get('content-length') && request.headers.get('content-length') !== '0') {
      body = (await request.json()) as RunBody;
    }
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const tenants = body.tenant_id
    ? [{ id: body.tenant_id }]
    : await listTenantIds().catch((e) => {
        console.error('[automation] list tenants failed:', e);
        return [];
      });

  const summaries: unknown[] = [];
  for (const t of tenants) {
    try {
      const s = await runRentOverdueCheck(t.id, null);
      summaries.push({ tenant_id: t.id, ...s });
    } catch (e) {
      summaries.push({ tenant_id: t.id, error: e instanceof Error ? e.message : 'failed' });
    }
  }

  return NextResponse.json({ ok: true, summaries });
}
