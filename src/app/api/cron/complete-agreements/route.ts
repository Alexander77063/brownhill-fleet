import { type NextRequest, NextResponse } from 'next/server';
import { completeDueAgreements } from '@/lib/agreement-lifecycle';
import { isCronAuthorized, todayISO } from '@/lib/cron';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * Daily: close every active agreement whose term has been served, and notify the driver
 * and the operator.
 *
 * Scheduled at 05:00, deliberately ahead of generate-rent (06:00 Monday): the rent cron
 * bills every agreement still marked `active`, so completing first is what stops a
 * finished agreement being invoiced for another week.
 *
 * Idempotent — `completeAgreement` only acts on rows still in `active`.
 */
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sb = createServiceClient();
  const today = todayISO();
  const { data: tenants } = await sb.from('tenants').select('id').eq('status', 'active');

  let completed = 0;
  const failures: { tenant_id: string; error: string }[] = [];
  for (const t of (tenants ?? []) as { id: string }[]) {
    try {
      completed += await completeDueAgreements(t.id, today);
    } catch (e) {
      // One tenant's bad data must not stop the sweep for everyone else.
      failures.push({ tenant_id: t.id, error: e instanceof Error ? e.message : 'failed' });
    }
  }

  return NextResponse.json({ ok: true, ran_on: today, agreements_completed: completed, failures });
}
