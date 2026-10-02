import { type NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron';
import { previousPeriod } from '@/lib/owner-report';
import { generateOwnerReports } from '@/lib/owner-report-run';
import { createServiceClient } from '@/lib/supabase/server';

// 06:00 UTC on the 1st (07:00 Lagos): last month's Vehicle Protection Report
// for every owner with a vehicle. `?period=YYYY-MM` overrides the month,
// `?force=1` regenerates existing snapshots.
export const runtime = 'nodejs';
// Sequential provider calls per item; give the job room before Vercel cuts it off.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const period = req.nextUrl.searchParams.get('period') ?? previousPeriod(new Date());
  const force = req.nextUrl.searchParams.get('force') === '1';
  const result = await generateOwnerReports(createServiceClient(), period, {
    force,
    appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null,
  });
  return NextResponse.json({ ok: true, period, ...result });
}
