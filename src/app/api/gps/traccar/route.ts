import { NextResponse, type NextRequest } from 'next/server';
import { ingestTraccarPosition } from '@/lib/gps';
import { parseTraccarPosition, verifyForwardSecret } from '@/lib/hardware/traccar';

/**
 * Traccar position forwarding (forward.type=json, forward.url → here). Behind
 * the shared X-Forward-Secret header; a fitted unit's fix goes through the same
 * ingest as a token ping. Anything well-formed but unknown is acknowledged with
 * 202 — Traccar retries 4xx/5xx and would never stop.
 */
export const runtime = 'nodejs';
export const maxDuration = 15;
const MAX_BODY = 64 * 1024;

export async function POST(req: NextRequest) {
  if (!verifyForwardSecret(req.headers)) return new NextResponse('Unauthorized', { status: 401 });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ ok: true, ignored: 'too large' }, { status: 202 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true, ignored: 'not json' }, { status: 202 });
  }
  const parsed = parseTraccarPosition(body);
  if (!parsed) return NextResponse.json({ ok: true, ignored: 'no fix' }, { status: 202 });
  try {
    const outcome = await ingestTraccarPosition(parsed);
    return NextResponse.json({ ok: true, outcome }, { status: outcome === 'ingested' ? 200 : 202 });
  } catch (e) {
    // Our failure, not Traccar's: 500 so it retries.
    console.error('[traccar] ingest failed', parsed.imei, e);
    return new NextResponse('ingest failed', { status: 500 });
  }
}
