import { type NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized, todayISO } from '@/lib/cron';
import { createServiceClient } from '@/lib/supabase/server';

// Quarterly cron: read the cash-basis VAT-by-quarter view and return a snapshot.
// Output VAT is recognised when cash is received; input VAT from company-paid
// maintenance is netted off. Persisting the snapshot is optional — we just
// surface it as JSON for now.
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sb = createServiceClient();
  const { data, error } = await sb
    .from('v_vat_by_quarter')
    .select('*')
    .order('quarter_start', { ascending: true });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, taken_on: todayISO(), quarters: data ?? [] });
}
