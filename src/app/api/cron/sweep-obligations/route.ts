import { type NextRequest, NextResponse } from 'next/server';
import { syncComplianceObligations } from '@/lib/compliance';
import { syncServiceObligations } from '@/lib/maintenance';
import { daysBetween, isCronAuthorized, todayISO } from '@/lib/cron';
import { createServiceClient } from '@/lib/supabase/server';

// Daily cron: refresh the unified obligations surface. Document compliance
// (insurance / PCO / DVLA re-check / MOT / VED) is delegated to the shared
// compliance module; GFV settlements and elapsed PCN report windows are handled
// here. Upserts on (entity_type, entity_id, type) so each sweep refreshes
// severity/status/due_date as dates approach.
export const runtime = 'nodejs';

function grade(today: string, dueDate: string): { status: 'open' | 'due_soon' | 'overdue'; severity: 'info' | 'warning' | 'critical' } {
  const days = daysBetween(today, dueDate);
  if (days < 0) return { status: 'overdue', severity: 'critical' };
  const severity = days <= 7 ? 'critical' : days <= 30 ? 'warning' : 'info';
  return { status: days <= 30 ? 'due_soon' : 'open', severity };
}

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const today = todayISO();
  const sb = createServiceClient();

  // Service-due obligations already carry tenant_id per-row (from the schedule),
  // so the sweep is safe to run once globally.
  const serviceCount = await syncServiceObligations(today);

  const { data: tenants } = await sb.from('tenants').select('id').eq('status', 'active');

  let docCount = 0;
  const rows: Array<{
    tenant_id: string;
    entity_type: string;
    entity_id: string;
    type: string;
    title: string;
    due_date: string;
    status: 'open' | 'due_soon' | 'overdue';
    severity: 'info' | 'warning' | 'critical';
  }> = [];

  for (const t of (tenants ?? []) as { id: string }[]) {
    // Document compliance (insurance / PCO / DVLA / MOT / VED) for this tenant.
    docCount += await syncComplianceObligations(t.id, today);

    // GFV / balloon settlement within 120 days.
    const { data: finance } = await sb
      .from('finance_agreements')
      .select('id, funder, gfv_due_on, gfv_status')
      .eq('tenant_id', t.id);
    for (const f of (finance ?? []) as { id: string; funder: string | null; gfv_due_on: string | null; gfv_status: string }[]) {
      if (f.gfv_status === 'settled' || f.gfv_status === 'na') continue;
      if (f.gfv_due_on == null || daysBetween(today, f.gfv_due_on) > 120) continue;
      rows.push({
        tenant_id: t.id,
        entity_type: 'finance_agreement',
        entity_id: f.id,
        type: 'gfv_settlement',
        title: `GFV / balloon settlement${f.funder ? ` (${f.funder})` : ''} due ${f.gfv_due_on}`,
        due_date: f.gfv_due_on,
        ...grade(today, f.gfv_due_on),
      });
    }

    // PCN report window elapsed, still 'received'.
    const { data: charges } = await sb
      .from('charges')
      .select('id, type, authority, report_due_at, status')
      .eq('tenant_id', t.id)
      .eq('status', 'received');
    for (const ch of (charges ?? []) as { id: string; type: string; authority: string | null; report_due_at: string | null; status: string }[]) {
      if (!ch.report_due_at) continue;
      const dueDate = ch.report_due_at.slice(0, 10);
      if (daysBetween(today, dueDate) > 0) continue;
      rows.push({
        tenant_id: t.id,
        entity_type: 'charge',
        entity_id: ch.id,
        type: 'pcn_report',
        title: `Report ${ch.type.toUpperCase()}${ch.authority ? ` (${ch.authority})` : ''} to driver — window elapsed`,
        due_date: dueDate,
        ...grade(today, dueDate),
      });
    }
  }

  if (rows.length > 0) {
    const { error } = await sb.from('obligations').upsert(rows as never, { onConflict: 'entity_type,entity_id,type' });
    if (error) throw new Error(`obligations upsert: ${error.message}`);
  }

  return NextResponse.json({ ok: true, ran_on: today, document_obligations: docCount, service_obligations: serviceCount, other_obligations: rows.length });
}
