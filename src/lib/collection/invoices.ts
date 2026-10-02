/**
 * Subscription invoices — the invoices WE issue to a tenant for its protection
 * subscription (distinct from `invoices`, which a tenant issues to its drivers).
 *
 * Every function takes the tenant first and names `tenant_id` on every insert.
 * Money moves through exactly one door, `confirmPayment`, whichever way it came
 * in (gateway return, webhook, reconciliation sweep, or an admin recording a
 * bank transfer), and only a paid invoice changes a subscription's status.
 */
import { regionOf } from '@/lib/catalogue/region';
import { syncBilledVehicles } from '@/lib/catalogue/quantity';
import { deploymentBrand } from '@/lib/deployment/brand';
import { regionProvider } from '@/lib/region';
import { createServiceClient } from '@/lib/supabase/server';
import { looksLikePayToken, newPayToken } from './pay-token';
import {
  additionLines,
  oneOffLines,
  oneOffLinesFor,
  subscriptionLines,
  termEnd,
  totals,
  type DraftLine,
  type Interval,
  type LineVehicle,
  type OneOffItem,
  type PriceablePlan,
} from './pricing';
import { issuerReady, platformSettings } from './settings';
import { periodAfterPayment, type SubStatus } from './state';

type Sb = ReturnType<typeof createServiceClient>;

export type InvoiceKind = 'initial' | 'renewal' | 'addition' | 'upgrade' | 'one_off';
export type InvoiceStatus = 'draft' | 'issued' | 'part_paid' | 'paid' | 'overdue' | 'void';
export type PaymentSource = 'paystack' | 'flutterwave' | 'bank_transfer' | 'manual';
export const UNPAID_STATUSES: InvoiceStatus[] = ['issued', 'part_paid', 'overdue'];

export interface CustomerSnapshot {
  name: string;
  address?: string | null;
  tin?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface InvoiceRow {
  id: string;
  tenant_id: string;
  number: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  plan_id: string | null;
  period_start: string | null;
  period_end: string | null;
  issued_on: string;
  due_on: string;
  currency: string;
  net_minor: number;
  vat_minor: number;
  gross_minor: number;
  paid_minor: number;
  wht_minor: number;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  pay_token: string;
  issuer: Record<string, unknown>;
  customer: CustomerSnapshot;
  data: InvoiceSnapshot;
  created_at: string;
}

/** The frozen render snapshot. The printable page reads ONLY this. */
export interface InvoiceSnapshot {
  number: string;
  kind: InvoiceKind;
  issuedOn: string;
  dueOn: string;
  period: { start: string; end: string } | null;
  currency: string;
  region: string;
  vatRate: number;
  issuer: Record<string, string>;
  bank: Record<string, string>;
  customer: CustomerSnapshot;
  lines: DraftLine[];
  totals: { netMinor: number; vatMinor: number; grossMinor: number };
  brand: string;
  note?: string | null;
}

export type PlanForBilling = PriceablePlan & { additions_billing: 'immediate' | 'monthly_batch'; audience: string; active: boolean };

export const todayISO = (d: Date = new Date()): string => d.toISOString().slice(0, 10);

function fail(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

// ── Lookups ──────────────────────────────────────────────────────────────────

export async function planById(planId: string, sb: Sb = createServiceClient()): Promise<PlanForBilling> {
  const { data, error } = await sb
    .from('plans')
    .select('id, key, name, base_price_pence, interval, per_vehicle, region, additions_billing, audience, active')
    .eq('id', planId)
    .maybeSingle();
  fail(error, 'plan');
  if (!data) throw new Error('Plan not found.');
  return { ...data, interval: data.interval as Interval, additions_billing: data.additions_billing as PlanForBilling['additions_billing'] };
}

/** The one-off items a vehicle incurs when it joins this plan (console-managed). */
export async function oneOffsForPlan(planId: string, sb: Sb = createServiceClient()): Promise<OneOffItem[]> {
  const { data, error } = await sb.from('plan_one_offs').select('addons(id, key, name, unit_price_pence, active)').eq('plan_id', planId);
  fail(error, 'plan_one_offs');
  return ((data ?? []) as unknown as { addons: OneOffItem | null }[]).map((r) => r.addons).filter((a): a is OneOffItem => Boolean(a));
}

/** Every one-off item on offer in this market (ad-hoc invoices). */
export async function listOneOffItems(sb: Sb = createServiceClient()): Promise<(OneOffItem & { region: string | null; description: string | null })[]> {
  const region = regionProvider().id;
  const { data, error } = await sb.from('addons').select('id, key, name, description, unit_price_pence, active, region, kind').eq('kind', 'one_off').order('key');
  fail(error, 'addons');
  return (data ?? []).filter((a) => regionOf(a) === region);
}

/** Vehicles the subscription bills for: every vehicle of the tenant not sold. */
export async function billedVehicleRows(tenantId: string, sb: Sb = createServiceClient()): Promise<LineVehicle[]> {
  const { data, error } = await sb.from('vehicles').select('id, registration').eq('tenant_id', tenantId).neq('status', 'sold').order('created_at');
  fail(error, 'vehicles');
  return data ?? [];
}

/** Who the invoice is addressed to: the billing contact, else the (first) owner, else the tenant. */
export async function customerSnapshotFor(tenantId: string, sb: Sb = createServiceClient()): Promise<CustomerSnapshot> {
  const [{ data: sub }, { data: owner }, { data: tenant }] = await Promise.all([
    sb.from('tenant_subscription').select('billing_name, billing_email, billing_phone, billing_address, customer_tin').eq('tenant_id', tenantId).maybeSingle(),
    sb.from('vehicle_owners').select('name, phone, email').eq('tenant_id', tenantId).order('created_at').limit(1).maybeSingle(),
    sb.from('tenants').select('name').eq('id', tenantId).maybeSingle(),
  ]);
  if (sub?.billing_name) {
    return { name: sub.billing_name, email: sub.billing_email, phone: sub.billing_phone, address: sub.billing_address, tin: sub.customer_tin };
  }
  if (owner) return { name: owner.name || tenant?.name || 'Customer', phone: owner.phone, email: owner.email, tin: sub?.customer_tin ?? null };
  return { name: tenant?.name ?? 'Customer', email: sub?.billing_email ?? null, phone: sub?.billing_phone ?? null, tin: sub?.customer_tin ?? null };
}

function moneyContext(plan: PriceablePlan): { vatRate: number; currency: string; region: string } {
  const pack = regionProvider(regionOf(plan));
  return { vatRate: pack.tax.vatRate, currency: pack.currency.code, region: pack.id };
}

// ── Drafts ───────────────────────────────────────────────────────────────────

export interface Draft {
  plan: PlanForBilling;
  lines: DraftLine[];
  period: { start: string; end: string } | null;
  vehicles: LineVehicle[];
  currency: string;
  vatRate: number;
}

/** First invoice: the whole term for every billed vehicle plus the tier's hardware per vehicle. */
export async function buildInitialDraft(tenantId: string, planId: string, sb: Sb = createServiceClient(), today = todayISO()): Promise<Draft> {
  const plan = await planById(planId, sb);
  await syncBilledVehicles(tenantId, sb);
  const vehicles = await billedVehicleRows(tenantId, sb);
  const { vatRate, currency } = moneyContext(plan);
  const period = { start: today, end: termEnd(today, plan.interval) };
  const lines = [...subscriptionLines(plan, vehicles, period, vatRate), ...oneOffLinesFor(await oneOffsForPlan(planId, sb), vehicles, vatRate)];
  return { plan, lines, period, vehicles, currency, vatRate };
}

/** Renewal: the next term for the CURRENT billed vehicles at the CURRENT console price. No hardware. */
export async function buildRenewalDraft(tenantId: string, planId: string, anniversary: string, sb: Sb = createServiceClient()): Promise<Draft> {
  const plan = await planById(planId, sb);
  await syncBilledVehicles(tenantId, sb);
  const vehicles = await billedVehicleRows(tenantId, sb);
  const { vatRate, currency } = moneyContext(plan);
  const period = { start: anniversary, end: termEnd(anniversary, plan.interval) };
  return { plan, lines: subscriptionLines(plan, vehicles, period, vatRate), period, vehicles, currency, vatRate };
}

/** Vehicles added mid-term: pro-rata to the anniversary, plus the tier's hardware, per vehicle. */
export async function buildAdditionDraft(
  tenantId: string,
  planId: string,
  vehicleIds: string[],
  period: { start: string; end: string },
  sb: Sb = createServiceClient(),
  addedOn = todayISO(),
): Promise<Draft> {
  const plan = await planById(planId, sb);
  const { data, error } = await sb.from('vehicles').select('id, registration, created_at').eq('tenant_id', tenantId).in('id', vehicleIds);
  fail(error, 'vehicles');
  // Each vehicle is prorated from the day it joined, so a batch run on the 1st
  // charges a car added on the 6th of last month for its own remaining days.
  const vehicles: LineVehicle[] = (data ?? []).map((v) => ({ id: v.id, registration: v.registration, addedOn: v.created_at ? String(v.created_at).slice(0, 10) : addedOn }));
  const { vatRate, currency } = moneyContext(plan);
  const lines = additionLines(plan, vehicles, addedOn, period, vatRate, await oneOffsForPlan(planId, sb));
  return { plan, lines, period, vehicles, currency, vatRate };
}

/** Upgrade mid-term: the pro-rata price difference per vehicle, plus hardware the new tier needs that the old one did not. */
export async function buildUpgradeDraft(
  tenantId: string,
  fromPlanId: string,
  toPlanId: string,
  period: { start: string; end: string },
  sb: Sb = createServiceClient(),
  today = todayISO(),
): Promise<Draft> {
  const [from, to] = await Promise.all([planById(fromPlanId, sb), planById(toPlanId, sb)]);
  const diff = Math.max(0, to.base_price_pence - from.base_price_pence);
  const vehicles = await billedVehicleRows(tenantId, sb);
  const { vatRate, currency } = moneyContext(to);
  const [fromItems, toItems] = await Promise.all([oneOffsForPlan(fromPlanId, sb), oneOffsForPlan(toPlanId, sb)]);
  const had = new Set(fromItems.map((i) => i.id));
  const newItems = toItems.filter((i) => !had.has(i.id));
  const priced: PriceablePlan = { ...to, name: `${to.name} (upgrade from ${from.name})`, base_price_pence: diff };
  const lines = diff > 0 ? additionLines(priced, vehicles, today, period, vatRate, newItems) : oneOffLinesFor(newItems, vehicles, vatRate, { perVehicle: true });
  return { plan: to, lines, period, vehicles, currency, vatRate };
}

/** Ad-hoc one-off invoice (a replacement device, an extra installation). */
export async function buildOneOffDraft(
  picks: { addonId: string; quantity: number; vehicleId?: string }[],
  tenantId: string,
  sb: Sb = createServiceClient(),
): Promise<{ lines: DraftLine[]; currency: string; vatRate: number }> {
  const items = await listOneOffItems(sb);
  const byId = new Map(items.map((i) => [i.id, i]));
  const vehicleIds = picks.map((p) => p.vehicleId).filter((v): v is string => Boolean(v));
  const regs = new Map<string, string>();
  if (vehicleIds.length) {
    const { data } = await sb.from('vehicles').select('id, registration').eq('tenant_id', tenantId).in('id', vehicleIds);
    for (const v of data ?? []) regs.set(v.id, v.registration);
  }
  const pack = regionProvider();
  const lines = oneOffLines(
    picks.map((p) => {
      const item = byId.get(p.addonId);
      if (!item) throw new Error('Unknown one-off item.');
      return { item, quantity: p.quantity, vehicleId: p.vehicleId, registration: p.vehicleId ? regs.get(p.vehicleId) : undefined };
    }),
    pack.tax.vatRate,
  );
  return { lines, currency: pack.currency.code, vatRate: pack.tax.vatRate };
}

// ── Issue ────────────────────────────────────────────────────────────────────

export interface IssueArgs {
  tenantId: string;
  kind: InvoiceKind;
  planId?: string | null;
  lines: DraftLine[];
  period?: { start: string; end: string } | null;
  dueOn: string;
  currency: string;
  vatRate: number;
  customer?: CustomerSnapshot;
  actor: string;
  note?: string | null;
  sb?: Sb;
  today?: string;
}

export interface IssuedInvoice {
  id: string;
  number: string;
  payToken: string;
  grossMinor: number;
  currency: string;
}

export async function issueInvoice(args: IssueArgs): Promise<IssuedInvoice> {
  const sb = args.sb ?? createServiceClient();
  const today = args.today ?? todayISO();
  if (!args.lines.length) throw new Error('Nothing to invoice.');
  const settings = await platformSettings(sb);
  const ready = issuerReady(settings);
  if (!ready.ok) throw new Error(`Cannot issue an invoice until ${ready.missing.join(', ')} are set in Platform → Settings.`);

  const t = totals(args.lines);
  const { data: numberData, error: numErr } = await sb.rpc('next_subscription_invoice_number');
  fail(numErr, 'invoice number');
  const number = String(numberData);
  const payToken = newPayToken();
  const customer = args.customer ?? (await customerSnapshotFor(args.tenantId, sb));
  const issuer = settings['invoice.issuer'];
  const bank = settings['invoice.bank'];
  const snapshot: InvoiceSnapshot = {
    number,
    kind: args.kind,
    issuedOn: today,
    dueOn: args.dueOn,
    period: args.period ?? null,
    currency: args.currency,
    region: regionProvider().id,
    vatRate: args.vatRate,
    issuer: { ...issuer },
    bank: { ...bank },
    customer,
    lines: args.lines,
    totals: t,
    brand: deploymentBrand().productName,
    note: args.note ?? null,
  };

  const { data: inv, error } = await sb
    .from('subscription_invoices')
    .insert({
      tenant_id: args.tenantId,
      number,
      kind: args.kind,
      status: 'issued',
      plan_id: args.planId ?? null,
      period_start: args.period?.start ?? null,
      period_end: args.period?.end ?? null,
      issued_on: today,
      due_on: args.dueOn,
      currency: args.currency,
      net_minor: t.netMinor,
      vat_minor: t.vatMinor,
      gross_minor: t.grossMinor,
      issuer: issuer as never,
      customer: customer as never,
      data: snapshot as never,
      pay_token: payToken,
    } as never)
    .select('id')
    .single();
  fail(error, 'issue invoice');
  const id = (inv as { id: string }).id;

  const lineRows = args.lines.map((l, i) => ({
    tenant_id: args.tenantId,
    invoice_id: id,
    kind: l.kind,
    description: l.description,
    plan_id: l.planId ?? null,
    addon_id: l.addonId ?? null,
    vehicle_id: l.vehicleId ?? null,
    quantity: l.quantity,
    unit_minor: l.unitMinor,
    net_minor: l.netMinor,
    vat_rate: l.vatRate,
    vat_minor: l.vatMinor,
    gross_minor: l.grossMinor,
    period_start: l.periodStart ?? null,
    period_end: l.periodEnd ?? null,
    sort: i,
  }));
  const { error: lineErr } = await sb.from('subscription_invoice_lines').insert(lineRows as never);
  if (lineErr) {
    // No transaction over PostgREST: undo the header so a half-issued invoice never exists.
    await sb.from('subscription_invoices').delete().eq('id', id).eq('tenant_id', args.tenantId);
    throw new Error(`issue invoice lines: ${lineErr.message}`);
  }
  await recordEvent(sb, args.tenantId, id, 'issued', args.actor, { kind: args.kind, number, grossMinor: t.grossMinor, dueOn: args.dueOn });
  return { id, number, payToken, grossMinor: t.grossMinor, currency: args.currency };
}

export async function recordEvent(sb: Sb, tenantId: string, invoiceId: string | null, kind: string, actor: string, detail: Record<string, unknown> = {}): Promise<void> {
  await sb.from('subscription_events').insert({ tenant_id: tenantId, invoice_id: invoiceId, kind, actor, detail: detail as never } as never);
}

// ── Void ─────────────────────────────────────────────────────────────────────

export async function voidInvoice(tenantId: string, invoiceId: string, reason: string, actor: string, sb: Sb = createServiceClient()): Promise<void> {
  const { data: inv, error } = await sb.from('subscription_invoices').select('status').eq('id', invoiceId).eq('tenant_id', tenantId).maybeSingle();
  fail(error, 'void');
  if (!inv) throw new Error('Invoice not found.');
  if (!UNPAID_STATUSES.includes(inv.status as InvoiceStatus)) throw new Error(`A ${inv.status} invoice cannot be voided.`);
  const { error: upErr } = await sb
    .from('subscription_invoices')
    .update({ status: 'void', voided_at: new Date().toISOString(), void_reason: reason } as never)
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId);
  fail(upErr, 'void');
  await recordEvent(sb, tenantId, invoiceId, 'voided', actor, { reason });
}

// ── Payments ─────────────────────────────────────────────────────────────────

/** A checkout has been started: remember the reference so reconciliation can verify it later. */
export async function startPayment(
  tenantId: string,
  invoiceId: string,
  source: PaymentSource,
  reference: string,
  amountMinor: number,
  currency: string,
  sb: Sb = createServiceClient(),
): Promise<void> {
  const { error } = await sb
    .from('subscription_payments')
    .upsert({ tenant_id: tenantId, invoice_id: invoiceId, source, reference, amount_minor: amountMinor, currency, status: 'pending' } as never, {
      onConflict: 'source,reference',
      ignoreDuplicates: true,
    });
  fail(error, 'start payment');
  await recordEvent(sb, tenantId, invoiceId, 'checkout_started', 'system', { source, reference });
}

export interface ConfirmArgs {
  source: PaymentSource;
  reference: string;
  amountMinor: number;
  currency: string;
  actor: string;
  /** Required when the reference is not already known (a recorded transfer). */
  invoiceId?: string;
  externalRef?: string | null;
  raw?: unknown;
  receivedOn?: string;
  whtMinor?: number;
  verifiedBy?: string | null;
  note?: string | null;
  sb?: Sb;
  today?: string;
}

export interface ConfirmResult {
  invoiceId: string;
  tenantId: string;
  invoicePaid: boolean;
  alreadyConfirmed: boolean;
  overpaidMinor: number;
}

/**
 * The only writer of confirmed money. Idempotent on (source, reference): a
 * replayed webhook, a second visit to the return URL or a re-entered transfer
 * all land on the same row and credit nothing twice.
 */
export async function confirmPayment(a: ConfirmArgs): Promise<ConfirmResult> {
  const sb = a.sb ?? createServiceClient();
  const today = a.today ?? todayISO();
  if (!(a.amountMinor > 0)) throw new Error('A payment must be positive.');

  const { data: existing, error: exErr } = await sb
    .from('subscription_payments')
    .select('id, status, invoice_id, tenant_id')
    .eq('source', a.source)
    .eq('reference', a.reference)
    .maybeSingle();
  fail(exErr, 'payment lookup');
  const invoiceId = a.invoiceId ?? existing?.invoice_id;
  if (!invoiceId) throw new Error('Unknown payment reference.');
  // A reference started against one invoice can never settle another.
  if (existing && a.invoiceId && existing.invoice_id !== a.invoiceId) throw new Error('Payment reference belongs to another invoice.');

  const { data: inv, error: invErr } = await sb.from('subscription_invoices').select('*').eq('id', invoiceId).maybeSingle();
  fail(invErr, 'invoice');
  if (!inv) throw new Error('Invoice not found.');
  const invoice = inv as unknown as InvoiceRow;
  if (existing?.status === 'confirmed') {
    return { invoiceId, tenantId: invoice.tenant_id, invoicePaid: invoice.status === 'paid', alreadyConfirmed: true, overpaidMinor: 0 };
  }
  if (invoice.status === 'void') throw new Error(`Invoice ${invoice.number} is void.`);
  if (a.currency !== invoice.currency) throw new Error(`Currency mismatch: invoice ${invoice.number} is in ${invoice.currency}, payment is in ${a.currency}.`);

  const { error: payErr } = await sb.from('subscription_payments').upsert(
    {
      tenant_id: invoice.tenant_id,
      invoice_id: invoiceId,
      source: a.source,
      reference: a.reference,
      amount_minor: a.amountMinor,
      currency: a.currency,
      status: 'confirmed',
      received_on: a.receivedOn ?? today,
      confirmed_at: new Date().toISOString(),
      verified_by: a.verifiedBy ?? null,
      external_ref: a.externalRef ?? null,
      note: a.note ?? null,
      raw: (a.raw ?? null) as never,
    } as never,
    { onConflict: 'source,reference' },
  );
  fail(payErr, 'confirm payment');

  // Recompute from the ledger rather than trusting the previous total.
  const { data: confirmed, error: sumErr } = await sb.from('subscription_payments').select('amount_minor').eq('invoice_id', invoiceId).eq('status', 'confirmed');
  fail(sumErr, 'payments');
  const paid = (confirmed ?? []).reduce((s, r) => s + Number(r.amount_minor), 0);
  const wht = Number(invoice.wht_minor) + Math.max(0, a.whtMinor ?? 0);
  const settled = paid + wht;
  const paidNow = settled >= Number(invoice.gross_minor);
  const overpaid = Math.max(0, settled - Number(invoice.gross_minor));

  const { error: upErr } = await sb
    .from('subscription_invoices')
    .update({
      paid_minor: paid,
      wht_minor: wht,
      status: paidNow ? 'paid' : 'part_paid',
      paid_at: paidNow ? (invoice.paid_at ?? new Date().toISOString()) : null,
    } as never)
    .eq('id', invoiceId);
  fail(upErr, 'update invoice');

  await recordEvent(sb, invoice.tenant_id, invoiceId, 'payment_confirmed', a.actor, {
    source: a.source,
    reference: a.reference,
    amountMinor: a.amountMinor,
    whtMinor: a.whtMinor ?? 0,
    settledMinor: settled,
  });
  if (overpaid > 0) await recordEvent(sb, invoice.tenant_id, invoiceId, 'overpaid', 'system', { overpaidMinor: overpaid });

  if (paidNow && invoice.status !== 'paid') {
    await recordEvent(sb, invoice.tenant_id, invoiceId, 'paid', 'system', { number: invoice.number });
    await activateOrExtend(invoice.tenant_id, invoice, today, sb);
    await deriveHardwareJobs(invoice.tenant_id, invoiceId, today, sb);
  }
  return { invoiceId, tenantId: invoice.tenant_id, invoicePaid: paidNow, alreadyConfirmed: false, overpaidMinor: overpaid };
}

/** What a paid invoice does to the subscription. Called only by confirmPayment. */
export async function activateOrExtend(tenantId: string, invoice: Pick<InvoiceRow, 'id' | 'kind' | 'plan_id' | 'period_start' | 'period_end' | 'number'>, today: string, sb: Sb = createServiceClient()): Promise<void> {
  const { data: sub } = await sb.from('tenant_subscription').select('status, plan_id, activated_at').eq('tenant_id', tenantId).maybeSingle();
  const now = new Date().toISOString();

  if (invoice.kind === 'initial' || invoice.kind === 'renewal') {
    const period = periodAfterPayment({ kind: invoice.kind, periodStart: invoice.period_start, periodEnd: invoice.period_end }, today);
    if (!period) throw new Error(`Invoice ${invoice.number} has no period.`);
    const { error } = await sb
      .from('tenant_subscription')
      .upsert(
        {
          tenant_id: tenantId,
          plan_id: invoice.plan_id ?? sub?.plan_id ?? null,
          status: 'active' satisfies SubStatus,
          current_period_start: period.start,
          current_period_end: `${period.end}T00:00:00Z`,
          anniversary_on: period.end,
          activated_at: sub?.activated_at ?? now,
          past_due_since: null,
          suspended_at: null,
          cancelled_at: null,
          pending_plan_id: null,
          updated_at: now,
        } as never,
        { onConflict: 'tenant_id' },
      );
    fail(error, 'activate');
    await recordEvent(sb, tenantId, invoice.id, invoice.kind === 'initial' ? 'activated' : 'renewed', 'system', { periodStart: period.start, periodEnd: period.end });
    return;
  }

  if (invoice.kind === 'upgrade' && invoice.plan_id) {
    const { error } = await sb.from('tenant_subscription').update({ plan_id: invoice.plan_id, updated_at: now } as never).eq('tenant_id', tenantId);
    fail(error, 'upgrade');
    await recordEvent(sb, tenantId, invoice.id, 'upgraded', 'system', { planId: invoice.plan_id });
  }

  // An addition or one-off paid while the subscription was past due or suspended
  // for THIS invoice alone brings it back; if another invoice is still unpaid the
  // ladder keeps running on that one.
  if (sub && (sub.status === 'past_due' || sub.status === 'suspended')) {
    const { count } = await sb
      .from('subscription_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .in('status', UNPAID_STATUSES);
    if ((count ?? 0) === 0) {
      const { error } = await sb
        .from('tenant_subscription')
        .update({ status: 'active' satisfies SubStatus, past_due_since: null, suspended_at: null, updated_at: now } as never)
        .eq('tenant_id', tenantId);
      fail(error, 'reactivate');
      await recordEvent(sb, tenantId, invoice.id, 'reactivated', 'system', {});
    }
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listInvoices(tenantId: string, sb: Sb = createServiceClient()): Promise<InvoiceRow[]> {
  const { data, error } = await sb.from('subscription_invoices').select('*').eq('tenant_id', tenantId).order('issued_on', { ascending: false }).order('created_at', { ascending: false });
  fail(error, 'invoices');
  return (data ?? []) as unknown as InvoiceRow[];
}

export async function invoiceById(tenantId: string, invoiceId: string, sb: Sb = createServiceClient()): Promise<InvoiceRow | null> {
  const { data, error } = await sb.from('subscription_invoices').select('*').eq('tenant_id', tenantId).eq('id', invoiceId).maybeSingle();
  fail(error, 'invoice');
  return (data as unknown as InvoiceRow | null) ?? null;
}

export async function invoiceByNumber(tenantId: string, number: string, sb: Sb = createServiceClient()): Promise<InvoiceRow | null> {
  const { data, error } = await sb.from('subscription_invoices').select('*').eq('tenant_id', tenantId).eq('number', number).maybeSingle();
  fail(error, 'invoice');
  return (data as unknown as InvoiceRow | null) ?? null;
}

/** The public pay page's lookup. Shape-checked first so junk never reaches the database. */
export async function invoiceByToken(token: string | null | undefined, sb: Sb = createServiceClient()): Promise<InvoiceRow | null> {
  if (!looksLikePayToken(token)) return null;
  const { data, error } = await sb.from('subscription_invoices').select('*').eq('pay_token', token).maybeSingle();
  fail(error, 'invoice');
  return (data as unknown as InvoiceRow | null) ?? null;
}

export async function paymentsForInvoice(tenantId: string, invoiceId: string, sb: Sb = createServiceClient()) {
  const { data, error } = await sb.from('subscription_payments').select('*').eq('tenant_id', tenantId).eq('invoice_id', invoiceId).order('created_at');
  fail(error, 'payments');
  return data ?? [];
}

export async function eventsForTenant(tenantId: string, sb: Sb = createServiceClient(), limit = 50) {
  const { data, error } = await sb.from('subscription_events').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(limit);
  fail(error, 'events');
  return data ?? [];
}

/** Vehicles whose addition (or initial) invoice is still unpaid — shown as "awaiting payment", excluded from alerts. */
export async function vehiclesAwaitingPayment(tenantId: string, sb: Sb = createServiceClient()): Promise<Set<string>> {
  const { data, error } = await sb
    .from('subscription_invoice_lines')
    .select('vehicle_id, subscription_invoices!inner(status)')
    .eq('tenant_id', tenantId)
    .not('vehicle_id', 'is', null)
    .in('subscription_invoices.status', UNPAID_STATUSES);
  fail(error, 'awaiting payment');
  return new Set(((data ?? []) as unknown as { vehicle_id: string | null }[]).map((r) => r.vehicle_id).filter((v): v is string => Boolean(v)));
}

/** Unpaid invoices for a tenant, oldest due first. */
export async function unpaidInvoices(tenantId: string, sb: Sb = createServiceClient()): Promise<InvoiceRow[]> {
  const { data, error } = await sb.from('subscription_invoices').select('*').eq('tenant_id', tenantId).in('status', UNPAID_STATUSES).order('due_on');
  fail(error, 'invoices');
  return (data ?? []) as unknown as InvoiceRow[];
}

/**
 * NG-3: a paid invoice's one-off lines become hardware jobs. Loaded lazily so
 * the money module carries no hardware import; a failure here is logged on the
 * invoice's timeline and never unwinds the payment — the derivation is
 * idempotent, so the console can run it again.
 */
async function deriveHardwareJobs(tenantId: string, invoiceId: string, today: string, sb: Sb): Promise<void> {
  try {
    const { createHardwareJobs } = await import('@/lib/hardware/jobs');
    await createHardwareJobs(invoiceId, sb, today);
  } catch (e) {
    console.error('[collection] hardware jobs failed', invoiceId, e);
    await recordEvent(sb, tenantId, invoiceId, 'hardware_jobs_failed', 'system', { error: e instanceof Error ? e.message : String(e) });
  }
}
