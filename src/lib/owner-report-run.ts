/**
 * Generate and deliver the monthly reports: one snapshot per owner per period,
 * idempotent unless forced; SMS when the tenant's tier and the owner's switch
 * allow, email when the owner gave one. The link lands on the owner portal.
 */
import { logNotification } from '@/lib/comms';
import { resolveEntitlementsForTenant } from '@/lib/entitlements';
import { sendEmail } from '@/lib/notify';
import { assembleOwnerReport, type OwnerReportData } from '@/lib/owner-report';
import { blockedTenants } from '@/lib/collection/serviceable';
import { pageAll } from '@/lib/page-all';
import { platformSms } from '@/lib/sms/platform-sms';
import { createServiceClient } from '@/lib/supabase/server';

type Sb = ReturnType<typeof createServiceClient>;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/**
 * The SMS that announces a report. ≤ 160 characters with the real link, so the
 * least important clauses are dropped in order (year, distance, alerts) rather
 * than the text being cut mid-word. The renewal clause is the one that matters
 * to the owner and goes last.
 */
export function reportMessage(data: OwnerReportData, url: string | null): string {
  const v = data.vehicles[0];
  const which = data.vehicles.length === 1 && v ? ` for ${v.registration}` : data.vehicles.length > 1 ? ` for your ${data.vehicles.length} vehicles` : '';
  const due = data.vehicles
    .flatMap((x) => x.compliance)
    .filter((c) => c.status === 'due_soon' || c.status === 'expired')
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))[0];
  const dueText = due ? `${due.label.toLowerCase()} ${due.status === 'expired' ? 'expired' : `due in ${due.daysLeft} days`}` : null;
  const km = `${data.totals.distanceKm} km`;
  const alerts = `${data.totals.alerts} alert${data.totals.alerts === 1 ? '' : 's'}`;
  const [monthName, year] = periodLabel(data.period).split(' ');
  const tail = url ? ` ${url}` : '';

  const attempt = (month: string, parts: Array<string | null>) => {
    const facts = parts.filter((p): p is string => Boolean(p)).join(', ');
    return `Your ${month} protection report${which} is ready${facts ? `: ${facts}` : ''}.${tail}`;
  };
  const candidates = [
    attempt(`${monthName} ${year}`, [km, alerts, dueText]),
    attempt(monthName, [km, alerts, dueText]),
    attempt(monthName, [alerts, dueText]),
    attempt(monthName, [dueText]),
    attempt(monthName, []),
  ];
  const fit = candidates.find((c) => c.length <= 160);
  if (fit) return fit;
  const last = candidates[candidates.length - 1];
  return `${last.slice(0, Math.max(0, 157 - tail.length))}...${tail}`;
}

export async function generateOwnerReports(
  sb: Sb,
  period: string,
  opts: { force?: boolean; appUrl?: string | null; now?: Date } = {},
): Promise<{ owners: number; generated: number; sms: number; email: number }> {
  const now = opts.now ?? new Date();
  const base = (opts.appUrl ?? '').replace(/\/$/, '');
  // Every owner with at least one vehicle. Paged: PostgREST caps a response at 1000 rows.
  const owned = await pageAll<{ tenant_id: string; owner_id: string | null }>((from, to) =>
    sb.from('vehicles').select('tenant_id, owner_id').not('owner_id', 'is', null).order('id').range(from, to),
  );
  const owners = new Map<string, string>(); // ownerId → tenantId
  for (const v of owned) if (v.owner_id) owners.set(v.owner_id, v.tenant_id);

  // NG-2: no report for a tenant whose subscription is not serviceable.
  const blocked = await blockedTenants(sb);

  const out = { owners: owners.size, generated: 0, sms: 0, email: 0 };
  for (const [ownerId, tenantId] of owners) {
    if (blocked.has(tenantId)) continue;
    // Generation and delivery are decided separately: a stored snapshot whose
    // SMS failed on the 1st is re-sent by the next run, and `force` regenerates
    // the snapshot without re-sending what already went.
    const { data: existing } = await sb
      .from('owner_reports')
      .select('id, data, sent_sms_at, sent_email_at')
      .eq('owner_id', ownerId)
      .eq('period', period)
      .maybeSingle();

    let rowId: string;
    let data: OwnerReportData;
    let sentSmsAt: string | null;
    let sentEmailAt: string | null;
    if (existing && !opts.force) {
      rowId = existing.id;
      data = existing.data as unknown as OwnerReportData;
      sentSmsAt = existing.sent_sms_at;
      sentEmailAt = existing.sent_email_at;
    } else {
      try {
        data = await assembleOwnerReport(sb, tenantId, ownerId, period, now);
      } catch (e) {
        console.error('[owner-reports] assemble failed', ownerId, e);
        continue;
      }
      const { data: row, error } = await sb
        .from('owner_reports')
        .upsert({ tenant_id: tenantId, owner_id: ownerId, period, data, generated_at: now.toISOString() } as never, { onConflict: 'owner_id,period' })
        .select('id, sent_sms_at, sent_email_at')
        .single();
      if (error || !row) {
        console.error('[owner-reports] store failed', ownerId, error?.message);
        continue;
      }
      out.generated += 1;
      rowId = row.id;
      sentSmsAt = row.sent_sms_at;
      sentEmailAt = row.sent_email_at;
    }

    // Delivery — best-effort, per tier and per the owner's switch, once per channel.
    if (sentSmsAt && sentEmailAt) continue;
    const [{ data: owner }, { features }] = await Promise.all([
      sb.from('vehicle_owners').select('phone, email, alerts_sms').eq('id', ownerId).maybeSingle(),
      resolveEntitlementsForTenant(tenantId),
    ]);
    if (!owner) continue;
    const url = base ? `${base}/owner/reports/${period}` : null;
    const text = reportMessage(data, url);
    const day = now.toISOString().slice(0, 10);

    if (!sentSmsAt && features.has('notifications.sms') && owner.alerts_sms) {
      const r = await platformSms(owner.phone, text);
      if (r.sent) {
        out.sms += 1;
        await sb.from('owner_reports').update({ sent_sms_at: now.toISOString() } as never).eq('id', rowId);
      }
      await logNotification(sb, {
        tenantId,
        driverId: null,
        channel: 'sms',
        recipient: owner.phone,
        subject: `Protection report ${period}`,
        body: text,
        entityType: 'owner_report',
        entityId: rowId,
        // One log row per attempt-day, so a retry the next morning is visible.
        dedupeKey: `owner_report:${rowId}:sms:${day}`,
        status: r.sent ? 'sent' : r.skipped ? 'skipped' : 'failed',
        error: r.error ?? null,
      });
    }
    if (!sentEmailAt && owner.email) {
      const html = `<p>${escapeHtml(text)}</p>${url ? `<p><a href="${url}">Open your report</a></p>` : ''}`;
      const r = await sendEmail(owner.email, `Your ${periodLabel(period)} vehicle protection report`, html);
      if (r.sent) {
        out.email += 1;
        await sb.from('owner_reports').update({ sent_email_at: now.toISOString() } as never).eq('id', rowId);
      }
    }
  }
  return out;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
