import { type NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron';
import { sweepDeviceHealth } from '@/lib/alerts/offline-sweep';

// Hourly (Vercel Pro): raise a device_offline alert for every owned vehicle
// whose tracker has been silent longer than its owner allows. Idempotent per
// vehicle per UTC day.
export const runtime = 'nodejs';
// Sequential provider calls per item; give the job room before Vercel cuts it off.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const result = await sweepDeviceHealth();
  return NextResponse.json({ ok: true, ...result });
}
