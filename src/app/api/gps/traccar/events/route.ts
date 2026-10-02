import { NextResponse, type NextRequest } from 'next/server';
import { parseTraccarEvent, verifyForwardSecret } from '@/lib/hardware/traccar';
import { handleTraccarEvent } from '@/lib/hardware/traccar-events';

/**
 * Traccar event forwarding (event.forward.url → here), behind the shared
 * X-Forward-Secret header. Command results, device-health alarms and
 * online/offline are handled; everything else is acknowledged and dropped.
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
  const ev = parseTraccarEvent(body);
  if (!ev || ev.kind === 'ignored') return NextResponse.json({ ok: true, ignored: ev?.type ?? 'no event' }, { status: 202 });
  try {
    const outcome = await handleTraccarEvent(ev);
    return NextResponse.json({ ok: true, outcome }, { status: outcome === 'ignored' ? 202 : 200 });
  } catch (e) {
    console.error('[traccar] event failed', ev.kind, ev.imei, e);
    return new NextResponse('event failed', { status: 500 });
  }
}
