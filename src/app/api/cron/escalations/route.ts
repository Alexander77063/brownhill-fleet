import { type NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron';
import { pgEscalationStore, runEscalations } from '@/lib/escalation';
import { platformChannels } from '@/lib/escalation-channels';
import { escalationConfigured } from '@/lib/requests';

// Every 5 minutes (Vercel Pro): drive the escalation ladder for open
// emergencies. The response carries the readiness picture so a misconfigured
// instance is visible in the cron logs as well as on the console banner.
export const runtime = 'nodejs';
// Sequential provider calls per item; give the job room before Vercel cuts it off.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const [result, readiness] = await Promise.all([
    runEscalations(pgEscalationStore(), platformChannels(), new Date(), {
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null,
    }),
    escalationConfigured(),
  ]);
  return NextResponse.json({ ok: true, ...result, readiness });
}
