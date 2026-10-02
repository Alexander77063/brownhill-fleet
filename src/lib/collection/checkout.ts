/**
 * Starting a payment — for an owner in the portal and for anyone holding a pay
 * link. No authorisation here: the route or page that calls this has already
 * established who is paying. Both paths end the same way: a pending payment
 * row with the gateway reference, and a redirect to the hosted page.
 */
import { setTenantPlan } from '@/lib/catalogue/manage';
import { createServiceClient } from '@/lib/supabase/server';
import { collectorFor, type SubscriptionCollector } from './collector';
import {
  buildInitialDraft,
  buildUpgradeDraft,
  invoiceById,
  invoiceByToken,
  issueInvoice,
  planById,
  recordEvent,
  startPayment,
  todayISO,
  UNPAID_STATUSES,
  type InvoiceRow,
} from './invoices';
import { platformSettings } from './settings';

type Sb = ReturnType<typeof createServiceClient>;

export type CheckoutOutcome =
  | { kind: 'redirect'; url: string; invoiceId: string }
  | { kind: 'no_gateway'; payToken: string; invoiceId: string }
  | { kind: 'plan_at_renewal'; planId: string }
  | { kind: 'nothing_due' };

async function toGateway(
  inv: InvoiceRow,
  payer: { email: string; name?: string | null; phone?: string | null },
  returnBase: string,
  sb: Sb,
  collector?: SubscriptionCollector | null,
): Promise<CheckoutOutcome> {
  const settings = await platformSettings(sb);
  const c = collector === undefined ? collectorFor({ preferred: settings['collection.preferred_gateway'] }) : collector;
  if (!c) return { kind: 'no_gateway', payToken: inv.pay_token, invoiceId: inv.id };
  const amountMinor = Number(inv.gross_minor) - Number(inv.paid_minor) - Number(inv.wht_minor);
  if (amountMinor <= 0) return { kind: 'nothing_due' };
  const returnUrl = `${returnBase.replace(/\/$/, '')}/api/billing/return?src=${c.source}&t=${inv.pay_token}`;
  const start = await c.startCheckout({
    invoiceId: inv.id,
    invoiceNumber: inv.number,
    amountMinor,
    currency: inv.currency,
    payer,
    returnUrl,
    description: `Vehicle protection — ${inv.number}`,
  });
  await startPayment(inv.tenant_id, inv.id, c.source, start.reference, amountMinor, inv.currency, sb);
  return { kind: 'redirect', url: start.url, invoiceId: inv.id };
}

export interface OwnerCheckoutArgs {
  tenantId: string;
  ownerId: string;
  /** Pay this existing invoice. */
  invoiceId?: string | null;
  /** Or start (or change to) this plan. */
  planId?: string | null;
  /** Both gateways require one; stored on the owner once given. */
  email?: string | null;
  returnBase: string;
  sb?: Sb;
  today?: string;
  collector?: SubscriptionCollector | null;
  actor?: string;
}

/**
 * An owner pays: an existing invoice, or their first term on a chosen plan, or
 * an upgrade mid-term. A downgrade takes effect at the next renewal and costs
 * nothing now.
 */
export async function startOwnerCheckout(a: OwnerCheckoutArgs): Promise<CheckoutOutcome> {
  const sb = a.sb ?? createServiceClient();
  const today = a.today ?? todayISO();
  const { data: owner } = await sb.from('vehicle_owners').select('id, name, phone, email').eq('id', a.ownerId).eq('tenant_id', a.tenantId).maybeSingle();
  if (!owner) throw new Error('No owner record is linked to this account.');
  const email = (a.email ?? '').trim() || owner.email || '';
  if (!email) throw new Error('Enter your email address — the payment page needs it for your receipt.');
  if (email !== owner.email) await sb.from('vehicle_owners').update({ email } as never).eq('id', owner.id).eq('tenant_id', a.tenantId);
  const payer = { email, name: owner.name, phone: owner.phone };

  if (a.invoiceId) {
    const inv = await invoiceById(a.tenantId, a.invoiceId, sb);
    if (!inv) throw new Error('Invoice not found.');
    if (!UNPAID_STATUSES.includes(inv.status)) return { kind: 'nothing_due' };
    return toGateway(inv, payer, a.returnBase, sb, a.collector);
  }

  if (!a.planId) throw new Error('Choose a plan.');
  const { data: sub } = await sb.from('tenant_subscription').select('status, plan_id, current_period_start, anniversary_on').eq('tenant_id', a.tenantId).maybeSingle();
  const status = sub?.status ?? 'unpaid';

  if (status === 'active' || status === 'past_due') {
    if (sub?.plan_id === a.planId) return { kind: 'nothing_due' };
    if (!sub?.plan_id || !sub.anniversary_on) throw new Error('Your subscription has no term yet.');
    const [from, to] = await Promise.all([planById(sub.plan_id, sb), planById(a.planId, sb)]);
    // Downgrade (or a different term at the same price): switch at the renewal, nothing to pay now.
    if (to.base_price_pence <= from.base_price_pence) {
      await sb.from('tenant_subscription').update({ pending_plan_id: a.planId, updated_at: new Date().toISOString() } as never).eq('tenant_id', a.tenantId);
      await recordEvent(sb, a.tenantId, null, 'plan_change_at_renewal', a.actor ?? 'owner', { from: from.key, to: to.key });
      return { kind: 'plan_at_renewal', planId: a.planId };
    }
    const period = { start: sub.current_period_start ?? today, end: sub.anniversary_on };
    const d = await buildUpgradeDraft(a.tenantId, sub.plan_id, a.planId, period, sb, today);
    if (!d.lines.length) return { kind: 'nothing_due' };
    const issued = await issueInvoice({ tenantId: a.tenantId, kind: 'upgrade', planId: a.planId, lines: d.lines, period, dueOn: today, currency: d.currency, vatRate: d.vatRate, actor: a.actor ?? 'owner', sb, today });
    const inv = await invoiceById(a.tenantId, issued.id, sb);
    return toGateway(inv as InvoiceRow, payer, a.returnBase, sb, a.collector);
  }

  // unpaid / suspended / cancelled: a fresh term on the chosen plan.
  // Reuse an outstanding initial invoice for the same plan rather than issuing a second.
  const { data: open } = await sb
    .from('subscription_invoices')
    .select('*')
    .eq('tenant_id', a.tenantId)
    .eq('kind', 'initial')
    .eq('plan_id', a.planId)
    .in('status', UNPAID_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (open) return toGateway(open as unknown as InvoiceRow, payer, a.returnBase, sb, a.collector);

  // The plan choice is recorded now (status untouched); the money activates it.
  await setTenantPlan(a.tenantId, a.planId, sb);
  const d = await buildInitialDraft(a.tenantId, a.planId, sb, today);
  if (!d.lines.length) throw new Error('Add a vehicle before paying — the price is per vehicle.');
  const issued = await issueInvoice({
    tenantId: a.tenantId,
    kind: 'initial',
    planId: a.planId,
    lines: d.lines,
    period: d.period,
    dueOn: today,
    currency: d.currency,
    vatRate: d.vatRate,
    customer: { name: owner.name || 'Vehicle owner', phone: owner.phone, email },
    actor: a.actor ?? 'owner',
    sb,
    today,
  });
  const inv = await invoiceById(a.tenantId, issued.id, sb);
  return toGateway(inv as InvoiceRow, payer, a.returnBase, sb, a.collector);
}

/** Anyone with the pay link pays that invoice — a fleet's finance clerk, an owner from an SMS. */
export async function startCheckoutForToken(
  token: string,
  email: string | null,
  returnBase: string,
  opts: { sb?: Sb; collector?: SubscriptionCollector | null } = {},
): Promise<CheckoutOutcome> {
  const sb = opts.sb ?? createServiceClient();
  const inv = await invoiceByToken(token, sb);
  if (!inv) throw new Error('This payment link is not valid.');
  if (!UNPAID_STATUSES.includes(inv.status)) return { kind: 'nothing_due' };
  const addr = (email ?? '').trim() || inv.customer.email || '';
  if (!addr) throw new Error('Enter an email address for the receipt.');
  return toGateway(inv, { email: addr, name: inv.customer.name, phone: inv.customer.phone }, returnBase, sb, opts.collector);
}
