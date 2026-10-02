/**
 * The daily collection run — renewals, batched additions, dunning, status
 * transitions, overdue marking, reconciliation. Every step is idempotent and
 * paged; the whole thing is driven by the console's settings and the pure
 * modules (`state.ts`, `dunning.ts`, `pricing.ts`).
 *
 * Only runs in pay-first markets (the cron route checks); the UK SaaS keeps its
 * own Stripe-driven reminders.
 */
import { logNotification } from '@/lib/comms';
import { deploymentBrand } from '@/lib/deployment/brand';
import { sendEmail } from '@/lib/notify';
import { pageAll } from '@/lib/page-all';
import { platformSms } from '@/lib/sms/platform-sms';
import { createServiceClient } from '@/lib/supabase/server';
import { collectorFor, type SubscriptionCollector } from './collector';
import { asciiMoney, dunningSteps, stepMessage, type StepKind } from './dunning';
import {
  buildAdditionDraft,
  buildRenewalDraft,
  confirmPayment,
  issueInvoice,
  recordEvent,
  todayISO,
  UNPAID_STATUSES,
  type InvoiceKind,
  type InvoiceRow,
} from './invoices';
import { platformSettings } from './settings';
import type { Settings } from './settings-defaults';
import { addDaysISO, dayDiff, UnpricedError } from './pricing';
import { nextTransition, type SubStatus } from './state';

type Sb = ReturnType<typeof createServiceClient>;

export interface Sender {
  sms(to: string, text: string): Promise<{ sent: boolean; error?: string }>;
  email(to: string, subject: string, html: string): Promise<{ sent: boolean; error?: string }>;
}

const defaultSender: Sender = {
  sms: (to, text) => platformSms(to, text, { channel: 'dnd' }),
  email: (to, subject, html) => sendEmail(to, subject, html),
};

export interface RunReport {
  renewalsIssued: number;
  batchesIssued: number;
  steps: number;
  transitions: Record<string, number>;
  overdueMarked: number;
  reconciled: number;
  pricingBlocked: { tenantId: string; reason: string }[];
}

interface SubRow {
  tenant_id: string;
  plan_id: string | null;
  status: SubStatus;
  anniversary_on: string | null;
  current_period_start: string | null;
  past_due_since: string | null;
  billing_phone: string | null;
  billing_email: string | null;
}

interface PlanRow {
  id: string;
  name: string;
  additions_billing: 'immediate' | 'monthly_batch';
}

export interface RunOptions {
  today?: string;
  sb?: Sb;
  collector?: SubscriptionCollector | null;
  appUrl?: string | null;
  send?: Sender;
  /** Reconcile pending payments older than this many minutes. */
  pendingAfterMinutes?: number;
}

export async function runCollectionLifecycle(opts: RunOptions = {}): Promise<RunReport> {
  const sb = opts.sb ?? createServiceClient();
  const today = opts.today ?? todayISO();
  const send = opts.send ?? defaultSender;
  const settings = await platformSettings(sb);
  const collector = opts.collector === undefined ? collectorFor({ preferred: settings['collection.preferred_gateway'] }) : opts.collector;
  const base = (opts.appUrl ?? '').replace(/\/$/, '');
  const report: RunReport = { renewalsIssued: 0, batchesIssued: 0, steps: 0, transitions: {}, overdueMarked: 0, reconciled: 0, pricingBlocked: [] };

  const subs = await pageAll<SubRow>((from, to) =>
    sb
      .from('tenant_subscription')
      .select('tenant_id, plan_id, status, anniversary_on, current_period_start, past_due_since, billing_phone, billing_email')
      .in('status', ['active', 'past_due', 'suspended'])
      .order('tenant_id')
      .range(from, to) as unknown as PromiseLike<{ data: SubRow[] | null; error: { message: string } | null }>,
  );
  const planIds = [...new Set(subs.map((s) => s.plan_id).filter((p): p is string => Boolean(p)))];
  const plans = new Map<string, PlanRow>();
  if (planIds.length) {
    const { data } = await sb.from('plans').select('id, name, additions_billing').in('id', planIds);
    for (const p of (data ?? []) as PlanRow[]) plans.set(p.id, p);
  }

  const blocked = (tenantId: string, e: unknown) => {
    const reason = e instanceof Error ? e.message : String(e);
    report.pricingBlocked.push({ tenantId, reason });
    return recordEvent(sb, tenantId, null, 'pricing_blocked', 'system', { reason, today });
  };

  // 1. Renewals: issue once, renewal_issue_days before the anniversary.
  for (const s of subs) {
    if (!s.plan_id || !s.anniversary_on || (s.status !== 'active' && s.status !== 'past_due')) continue;
    if (dayDiff(today, s.anniversary_on) > settings['collection.renewal_issue_days']) continue;
    const { count } = await sb
      .from('subscription_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', s.tenant_id)
      .eq('kind', 'renewal')
      .eq('period_start', s.anniversary_on)
      .neq('status', 'void');
    if ((count ?? 0) > 0) continue;
    try {
      const d = await buildRenewalDraft(s.tenant_id, s.plan_id, s.anniversary_on, sb);
      if (!d.lines.length) continue;
      await issueInvoice({ tenantId: s.tenant_id, kind: 'renewal', planId: s.plan_id, lines: d.lines, period: d.period, dueOn: s.anniversary_on, currency: d.currency, vatRate: d.vatRate, actor: 'system', sb, today });
      report.renewalsIssued += 1;
    } catch (e) {
      if (e instanceof UnpricedError) await blocked(s.tenant_id, e);
      else console.error('[collection] renewal failed', s.tenant_id, e);
    }
  }

  // 2. Batched additions for monthly_batch plans, on the batch day.
  if (Number(today.slice(8, 10)) === settings['collection.additions_batch_day']) {
    for (const s of subs) {
      const plan = s.plan_id ? plans.get(s.plan_id) : undefined;
      if (!plan || plan.additions_billing !== 'monthly_batch' || s.status !== 'active' || !s.anniversary_on) continue;
      const { data: covering } = await sb
        .from('subscription_invoices')
        .select('issued_on, period_end')
        .eq('tenant_id', s.tenant_id)
        .in('kind', ['initial', 'renewal', 'addition'] satisfies InvoiceKind[])
        .neq('status', 'void')
        .order('issued_on', { ascending: false });
      const last = covering?.[0];
      if (!last) continue;
      const periodEnd = (covering ?? []).reduce((m, r) => (r.period_end && r.period_end > m ? r.period_end : m), s.anniversary_on);
      const { data: added } = await sb
        .from('vehicles')
        .select('id')
        .eq('tenant_id', s.tenant_id)
        .neq('status', 'sold')
        .gt('created_at', `${last.issued_on}T23:59:59Z`);
      const ids = (added ?? []).map((v) => v.id);
      if (!ids.length) continue;
      const { data: already } = await sb.from('subscription_invoice_lines').select('vehicle_id').eq('tenant_id', s.tenant_id).in('vehicle_id', ids);
      const done = new Set((already ?? []).map((r) => r.vehicle_id));
      const fresh = ids.filter((id) => !done.has(id));
      if (!fresh.length) continue;
      try {
        const d = await buildAdditionDraft(s.tenant_id, s.plan_id as string, fresh, { start: s.current_period_start ?? today, end: periodEnd }, sb, today);
        if (!d.lines.length) continue;
        await issueInvoice({
          tenantId: s.tenant_id,
          kind: 'addition',
          planId: s.plan_id,
          lines: d.lines,
          period: d.period,
          dueOn: addDaysISO(today, settings['collection.due_days_business']),
          currency: d.currency,
          vatRate: d.vatRate,
          actor: 'system',
          sb,
          today,
        });
        report.batchesIssued += 1;
      } catch (e) {
        if (e instanceof UnpricedError) await blocked(s.tenant_id, e);
        else console.error('[collection] batch failed', s.tenant_id, e);
      }
    }
  }

  // 3. Overdue marking.
  {
    const { data } = await sb.from('subscription_invoices').update({ status: 'overdue' } as never).eq('status', 'issued').lt('due_on', today).select('id');
    report.overdueMarked = data?.length ?? 0;
  }

  // 4. Dunning for every unpaid invoice.
  const unpaid = await pageAll<InvoiceRow>((from, to) =>
    sb.from('subscription_invoices').select('*').in('status', UNPAID_STATUSES).order('due_on').range(from, to) as unknown as PromiseLike<{ data: InvoiceRow[] | null; error: { message: string } | null }>,
  );
  const subByTenant = new Map(subs.map((s) => [s.tenant_id, s]));
  const recipientCache = new Map<string, { phone: string | null; email: string | null; registration: string | null; vehicles: number }>();
  const recipient = async (tenantId: string) => {
    const hit = recipientCache.get(tenantId);
    if (hit) return hit;
    const s = subByTenant.get(tenantId);
    const [{ data: owner }, { data: vehicles }] = await Promise.all([
      sb.from('vehicle_owners').select('phone, email').eq('tenant_id', tenantId).order('created_at').limit(1).maybeSingle(),
      sb.from('vehicles').select('registration').eq('tenant_id', tenantId).neq('status', 'sold').limit(2),
    ]);
    const r = {
      phone: s?.billing_phone || owner?.phone || null,
      email: s?.billing_email || owner?.email || null,
      registration: vehicles && vehicles.length === 1 ? vehicles[0].registration : null,
      vehicles: vehicles?.length ?? 0,
    };
    recipientCache.set(tenantId, r);
    return r;
  };

  const brand = deploymentBrand().productName;
  const fmtDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  const sendStep = async (inv: InvoiceRow, step: StepKind, s: SubRow | undefined) => {
    const { data: sentRows } = await sb.from('subscription_reminders').select('kind').eq('tenant_id', inv.tenant_id).eq('period_end', `${inv.due_on}T00:00:00Z`);
    if ((sentRows ?? []).some((r) => r.kind === step)) return false;
    const to = await recipient(inv.tenant_id);
    const payUrl = base ? `${base}/pay/${inv.pay_token}` : '';
    const since = s?.past_due_since ?? s?.anniversary_on ?? inv.due_on;
    const msg = stepMessage(step, {
      productName: brand,
      registration: to.registration,
      vehicles: to.vehicles,
      amount: asciiMoney(Number(inv.gross_minor) - Number(inv.paid_minor) - Number(inv.wht_minor), inv.currency),
      dueOn: fmtDate(inv.due_on),
      payUrl,
      invoiceNumber: inv.number,
      isRenewal: inv.kind === 'renewal',
      suspendOn: fmtDate(addDaysISO(since, settings['collection.grace_days'])),
      cancelOn: fmtDate(addDaysISO(since, settings['collection.cancel_days'])),
    });
    let channel: string | null = null;
    let status = 'skipped';
    let error: string | null = null;
    if (to.phone) {
      const r = await send.sms(to.phone, msg.sms);
      channel = 'sms';
      status = r.sent ? 'sent' : 'failed';
      error = r.error ?? null;
      await logNotification(sb, { tenantId: inv.tenant_id, driverId: null, channel: 'sms', recipient: to.phone, subject: msg.subject, body: msg.sms, entityType: 'subscription_invoice', entityId: inv.id, dedupeKey: `sub:${inv.id}:${step}:sms`, status: status as 'sent' | 'failed', error });
    }
    if (to.email) {
      const r = await send.email(to.email, msg.subject, msg.html);
      channel = channel ? 'sms+email' : 'email';
      if (r.sent && status !== 'sent') status = 'sent';
      await logNotification(sb, { tenantId: inv.tenant_id, driverId: null, channel: 'email', recipient: to.email, subject: msg.subject, body: msg.html, entityType: 'subscription_invoice', entityId: inv.id, dedupeKey: `sub:${inv.id}:${step}:email`, status: r.sent ? 'sent' : 'failed', error: r.error ?? null });
    }
    // The reminder row IS the once-only guarantee; a failure to write it must surface.
    const { error: remErr } = await sb
      .from('subscription_reminders')
      .insert({ tenant_id: inv.tenant_id, kind: step, period_end: `${inv.due_on}T00:00:00Z`, channel, recipient: to.phone ?? to.email, status, detail: inv.number } as never);
    if (remErr) throw new Error(`subscription_reminders: ${remErr.message}`);
    await recordEvent(sb, inv.tenant_id, inv.id, `reminder_${step}`, 'system', { channel, status });
    return true;
  };

  for (const inv of unpaid) {
    const s = subByTenant.get(inv.tenant_id);
    const { data: sentRows } = await sb.from('subscription_reminders').select('kind').eq('tenant_id', inv.tenant_id).eq('period_end', `${inv.due_on}T00:00:00Z`);
    const steps = dunningSteps({
      invoice: { id: inv.id, kind: inv.kind, status: inv.status, dueOn: inv.due_on },
      subscription: s ? { status: s.status, pastDueSince: s.past_due_since } : null,
      settings,
      todayISO: today,
      alreadySent: new Set((sentRows ?? []).map((r) => r.kind)),
    });
    for (const step of steps) if (await sendStep(inv, step, s)) report.steps += 1;
  }

  // 5. Status transitions, and the messages they carry.
  for (const s of subs) {
    const renewalUnpaid = unpaid.find((i) => i.tenant_id === s.tenant_id && i.kind === 'renewal' && i.period_start === s.anniversary_on) ?? null;
    const t = nextTransition(
      { status: s.status, anniversaryOn: s.anniversary_on, pastDueSince: s.past_due_since },
      renewalUnpaid ? { periodStart: renewalUnpaid.period_start as string } : null,
      settings,
      today,
    );
    if (!t) continue;
    const patch: Record<string, unknown> = { status: t.to, past_due_since: t.pastDueSince, updated_at: new Date().toISOString() };
    if (t.to === 'suspended') patch.suspended_at = new Date().toISOString();
    if (t.to === 'cancelled') patch.cancelled_at = new Date().toISOString();
    const { error } = await sb.from('tenant_subscription').update(patch as never).eq('tenant_id', s.tenant_id).eq('status', s.status);
    if (error) {
      console.error('[collection] transition failed', s.tenant_id, error.message);
      continue;
    }
    report.transitions[t.event] = (report.transitions[t.event] ?? 0) + 1;
    await recordEvent(sb, s.tenant_id, renewalUnpaid?.id ?? null, t.event, 'system', { from: s.status, to: t.to });
    s.status = t.to;
    s.past_due_since = t.pastDueSince;
    if ((t.to === 'suspended' || t.to === 'cancelled') && renewalUnpaid) {
      if (await sendStep(renewalUnpaid, t.to, s)) report.steps += 1;
    }
  }

  // 6. Reconcile pending gateway payments.
  if (collector) {
    const cutoff = new Date(Date.now() - (opts.pendingAfterMinutes ?? 10) * 60_000).toISOString();
    const pending = await pageAll<{ id: string; source: string; reference: string; created_at: string }>((from, to) =>
      sb.from('subscription_payments').select('id, source, reference, created_at').eq('status', 'pending').lt('created_at', cutoff).order('created_at').range(from, to),
    );
    for (const p of pending) {
      if (p.source !== collector.source) continue;
      const v = await collector.verify(p.reference);
      if (v.ok) {
        try {
          await confirmPayment({ source: collector.source, reference: p.reference, amountMinor: v.amountMinor, currency: v.currency, externalRef: v.externalRef, raw: v.raw, actor: 'reconcile', sb, today });
          report.reconciled += 1;
        } catch (e) {
          console.error('[collection] reconcile confirm failed', p.reference, e);
        }
      } else if (Date.parse(p.created_at) < Date.now() - 24 * 60 * 60_000) {
        await sb.from('subscription_payments').update({ status: 'failed', note: v.reason } as never).eq('id', p.id);
      }
    }
  }

  return report;
}
