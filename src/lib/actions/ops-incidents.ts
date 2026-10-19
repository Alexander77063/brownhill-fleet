'use server';

// src/lib/actions/ops-incidents.ts
// Ops actions on driver-submitted damage reports:
//   - setDamageReportStatus — owner/admin transitions an existing report
//     through the state machine in @/lib/driver/damage-report-status.
//     The transition rule is enforced on the server — the dashboard
//     hides the buttons it can't perform, but the action double-checks.
//
// Status writes also touch reviewed_at + reviewed_by_user_id so the audit
// trail in /driver/report shows "office reviewed" on day N.

import { revalidatePath } from 'next/cache';
import { createServiceClient } from '@/lib/supabase/server';
import { requirePermission } from '@/lib/auth/context';
import { isValidTransition, type DamageReportStatus } from '@/lib/driver/damage-report-status';

export async function setDamageReportStatus(formData: FormData): Promise<void> {
  const ctx = await requirePermission('tenant.settings');

  const id = String(formData.get('id') ?? '');
  const to = String(formData.get('to') ?? '') as DamageReportStatus;
  const notes = String(formData.get('notes') ?? '').trim() || null;

  if (!id) throw new Error('Missing report id.');
  const allowed: DamageReportStatus[] = ['open', 'reviewed', 'in_repair', 'resolved', 'rejected'];
  if (!allowed.includes(to)) throw new Error('Unknown target status.');

  const sb = createServiceClient();

  // Read the current status first so we can enforce the transition rule.
  const { data: row, error: readErr } = await sb
    .from('driver_damage_reports' as never)
    .select('id, status, tenant_id')
    .eq('id', id)
    .maybeSingle();
  if (readErr || !row) throw new Error('Report not found.');
  if ((row as { tenant_id: string }).tenant_id !== ctx.tenantId) {
    throw new Error('Report belongs to a different tenant.');
  }

  const from = (row as { status: string }).status as DamageReportStatus;
  if (!isValidTransition(from, to)) {
    throw new Error(`Cannot move from "${from}" to "${to}".`);
  }

  const { error: updErr } = await sb
    .from('driver_damage_reports' as never)
    .update({
      status: to,
      reviewed_by_user_id: ctx.userId,
      reviewed_at: new Date().toISOString(),
      resolution_notes: notes,
    } as never)
    .eq('id', id);
  if (updErr) throw new Error(`Update failed: ${updErr.message}`);

  revalidatePath('/ops/incidents');
  revalidatePath('/ops');
  revalidatePath('/driver/report');
}