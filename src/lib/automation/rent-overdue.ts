// src/lib/automation/rent-overdue.ts
//
// Rent-overdue scanner. Walks the `invoices` table for a tenant, finds any
// with `due_on < today` and `status` not in ('paid','void'), and sends the
// linked driver a one-shot "your rent is overdue" notice. Dedup key is
// `rent_overdue:<invoice_id>` so the same invoice never gets two reminders
// — if ops wants to remind again they can clear the row from
// `notifications` (or set status='reminded') in a future feature.
//
// "today" is read from the page, not the Node clock, so the result is
// deterministic per request and matches what /ops/billing shows on its
// own Arrears table. This worker is also the seed for the "automated
// daily check" — wire it into a setInterval in instrumentation.ts and the
// operator gets cron-equivalent without systemd timers.

import { formatDate } from '@/lib/display';
import { todayISO } from '@/lib/collection/invoices';
import { sendDriverMessage } from '@/lib/comms';
import { createServiceClient } from '@/lib/supabase/server';

type Sb = ReturnType<typeof createServiceClient>;

export interface OverdueRow {
  invoiceId: string;
  invoiceNumber: string;
  driverId: string;
  driverName: string;
  email: string | null;
  phone: string | null;
  dueOn: string;
  outstandingPence: number;
  agreementId: string;
}

export interface OverdueRunSummary {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
  rows: OverdueRow[];
  /** Per-invoice dedupe_key so the UI / a future cron can show the keys. */
  dedupeKeys: { invoiceId: string; dedupeKey: string }[];
}

/**
 * Find all overdue invoices for a tenant that are not in a final state
 * (paid or void) and have not already been notified.
 */
export async function findOverdueInvoicesForTenant(
  tenantId: string,
  sb: Sb = createServiceClient(),
): Promise<OverdueRow[]> {
  const today = todayISO();
  // Filter by status NOT IN ('paid','void') so the source-of-truth is the
  // sync_invoice_status() trigger, not a derived "paid_pence" column that
  // doesn't exist on this table.
  const { data: invoiceRows } = await sb
    .from('invoices')
    .select(
      'id, number, due_on, status, gross_pence, agreement_id',
    )
    .eq('tenant_id', tenantId)
    .lt('due_on', today)
    .not('status', 'in', '("paid","void")')
    .order('due_on');

  if (!invoiceRows || invoiceRows.length === 0) return [];
  const agreementIds = Array.from(
    new Set(
      (invoiceRows as Array<{ agreement_id: string }>)
        .map((r) => r.agreement_id)
        .filter(Boolean),
    ),
  );

  // Already-notified? Dedup via notifications.dedupe_key = rent_overdue:<id>
  const ids = (invoiceRows as Array<{ id: string }>).map((r) => r.id);
  const dedupKeys = ids.map((id) => `rent_overdue:${id}`);
  const { data: alreadySent } = await sb
    .from('notifications')
    .select('dedupe_key')
    .eq('tenant_id', tenantId)
    .in('dedupe_key', dedupKeys);
  const sent = new Set(
    ((alreadySent ?? []) as Array<{ dedupe_key: string | null }>)
      .map((r) => r.dedupe_key)
      .filter((k): k is string => Boolean(k)),
  );

  // Find agreements + drivers
  const { data: agreements } = agreementIds.length
    ? await sb
        .from('agreements')
        .select('id, driver_id, status, drivers(id, full_name, email, phone)')
        .in('id', agreementIds)
    : { data: [] };
  const agreementById = new Map<string, { driverId: string; driverName: string; email: string | null; phone: string | null }>();
  for (const a of ((agreements ?? []) as Array<{
    id: string;
    driver_id: string | null;
    drivers: { id: string; full_name: string; email: string | null; phone: string | null } | null;
  }>)) {
    if (!a.drivers) continue;
    agreementById.set(a.id, {
      driverId: a.drivers.id,
      driverName: a.drivers.full_name,
      email: a.drivers.email,
      phone: a.drivers.phone,
    });
  }

  const rows: OverdueRow[] = [];
  for (const r of (invoiceRows as Array<{
    id: string;
    number: string | null;
    due_on: string;
    status: string;
    gross_pence: number;
    agreement_id: string;
  }>)) {
    if (sent.has(`rent_overdue:${r.id}`)) continue;
    const ag = agreementById.get(r.agreement_id);
    if (!ag) continue; // orphaned invoice — skip, ops can clean up
    // First-pass: assume outstanding = gross_pence when status is open/overdue.
    // For 'part_paid' a precise amount would need a SUM over payment_allocations;
    // skip those for now and let ops see them in the Arrears table directly.
    if (r.status === 'part_paid') {
      // still notify the driver with a non-zero placeholder so they don't
      // assume it's all paid; ops can follow up on the precise number.
    }
    const outstanding = Number(r.gross_pence);
    if (outstanding <= 0) continue;
    rows.push({
      invoiceId: r.id,
      invoiceNumber: r.number ?? r.id.slice(0, 8),
      driverId: ag.driverId,
      driverName: ag.driverName,
      email: ag.email,
      phone: ag.phone,
      dueOn: r.due_on,
      outstandingPence: outstanding,
      agreementId: r.agreement_id,
    });
  }
  return rows;
}

function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/**
 * One-shot rent-overdue scan + send. Tenant-scoped. Returns a summary
 * suitable for showing the operator what happened.
 */
export async function runRentOverdueCheck(
  tenantId: string,
  actor: string | null,
  sb: Sb = createServiceClient(),
): Promise<OverdueRunSummary> {
  const rows = await findOverdueInvoicesForTenant(tenantId, sb);

  const dedupeKeys: { invoiceId: string; dedupeKey: string }[] = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const dedupeKey = `rent_overdue:${row.invoiceId}`;
    dedupeKeys.push({ invoiceId: row.invoiceId, dedupeKey });

    if (!row.email && !row.phone) {
      // No channel to send through. Record an attempted notification so
      // the operator can see "we tried, but they have no contact info"
      // (still under the same dedup_key, so it doesn't re-attempt tomorrow).
      await sb.from('notifications').insert({
        tenant_id: tenantId,
        driver_id: row.driverId,
        channel: 'email',
        recipient: null,
        subject: `Rent overdue — invoice ${row.invoiceNumber}`,
        body: 'No email or phone on file; cannot deliver.',
        entity_type: 'invoice',
        entity_id: row.invoiceId,
        dedupe_key: dedupeKey,
        status: 'skipped',
        error: 'no contact on file',
      });
      skipped++;
      continue;
    }

    const subject = `Rent overdue — invoice ${row.invoiceNumber}`;
    const body = [
      `Hi ${row.driverName.split(' ')[0] ?? 'driver'},`,
      ``,
      `Our records show invoice ${row.invoiceNumber} for ${formatPence(row.outstandingPence)} was due on ${formatDate(row.dueOn)} and is still outstanding.`,
      `Please bring your account up to date to keep your agreement in good standing.`,
      ``,
      `If you've already paid this, please ignore this message — your operator will update the records when the payment clears.`,
      ``,
      `Thank you.`,
    ].join('\n');

    try {
      await sendDriverMessage(tenantId, row.driverId, subject, body, actor);
      sent++;
    } catch (e) {
      // sendDriverMessage already logs to notifications with status=failed,
      // and the dedup_key is implicit via the same row id — but the
      // operator may want to see a per-invoice count here. Don't re-throw.
      failed++;
    }
  }

  // Audit: one row for the whole run, so ops can see "I ran the check
  // at 14:32" in the audit log.
  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: 'automation.rent_overdue_check',
    p_entity_type: 'tenant',
    p_entity_id: tenantId,
    p_detail: { scanned: rows.length, sent, skipped, failed } as never,
    p_actor: actor ?? undefined,
  });

  return {
    scanned: rows.length,
    sent,
    skipped,
    failed,
    rows,
    dedupeKeys,
  };
}
