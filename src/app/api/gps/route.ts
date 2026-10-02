import { type NextRequest, NextResponse } from 'next/server';
import { ingestPosition } from '@/lib/gps';

// Public: authorised by the per-vehicle device token (X-Device-Token header or
// body). Used by the driver app and provider hardware.
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  }
  const deviceToken = req.headers.get('x-device-token') ?? String(body.device_token ?? '');

  try {
    const result = await ingestPosition(deviceToken, {
      lat: Number(body.lat),
      lng: Number(body.lng),
      speed: body.speed != null ? Number(body.speed) : null,
      heading: body.heading != null ? Number(body.heading) : null,
      odometerMiles: body.odometer_miles != null ? Number(body.odometer_miles) : null,
      batteryPct: body.battery_pct != null ? Number(body.battery_pct) : null,
      rangeMiles: body.range_miles != null ? Number(body.range_miles) : null,
      recordedAt: typeof body.recorded_at === 'string' ? body.recorded_at : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'ingest failed' }, { status: 400 });
  }
}
