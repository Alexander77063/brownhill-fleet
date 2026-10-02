'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth';
import { getAuthContext } from '@/lib/auth/context';
import { syncBilledVehicles } from '@/lib/catalogue/quantity';
import { requireEntitlement } from '@/lib/entitlements';
import { pounds, formatGBP } from '@/lib/money';
import { sendDriverMessage } from '@/lib/comms';
import type { Database } from '@/lib/supabase/database.types';

type Enums = Database['public']['Enums'];

// Ops mutations. Every action runs through the caller's Supabase session, so
// RLS (0012) enforces the ops-only `for all` policies. We still re-assert the
// role here because a server action is a directly-callable boundary.

function str(fd: FormData, key: string): string | null {
  const v = fd.get(key);
  if (v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function reqStr(fd: FormData, key: string): string {
  const s = str(fd, key);
  if (!s) throw new Error(`Missing required field: ${key}`);
  return s;
}

/** Read a pounds-denominated form field and return integer pence. */
function poundsField(fd: FormData, key: string): number {
  const s = str(fd, key);
  if (!s) return 0;
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error(`Invalid amount for ${key}`);
  return pounds(n);
}

function randomKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ── Record a payment & allocate to oldest open invoices ─────────────────── */
export async function recordPayment(formData: FormData): Promise<void> {
  await requireRole(['ops']);
  const sb = await createClient();

  const agreementId = reqStr(formData, 'agreement_id');
  const amountPence = poundsField(formData, 'amount');
  if (amountPence <= 0) throw new Error('Payment amount must be greater than zero');
  const source = (str(formData, 'source') ?? 'manual') as 'manual' | 'bank_transfer' | 'cash';
  const receivedOn = str(formData, 'received_on');

  // Resolve the agreement's driver so the payment is driver-linked.
  const { data: agreement } = await sb
    .from('agreements')
    .select('driver_id')
    .eq('id', agreementId)
    .maybeSingle();

  const tenantId = await currentTenantId();
  const { data: payment, error: payErr } = await sb
    .from('payments')
    .insert({
      tenant_id: tenantId,
      agreement_id: agreementId,
      driver_id: (agreement as { driver_id?: string } | null)?.driver_id ?? null,
      source,
      idempotency_key: randomKey(source),
      amount_pence: amountPence,
      received_on: receivedOn ?? new Date().toISOString().slice(0, 10),
      status: 'confirmed',
    })
    .select('id')
    .single();
  if (payErr || !payment) throw new Error(payErr?.message ?? 'Could not record payment');

  // Allocate FIFO across open invoices, never exceeding each invoice's balance.
  const { data: invoices } = await sb
    .from('v_invoice_balance')
    .select('id, balance_pence, status')
    .eq('agreement_id', agreementId)
    .order('due_on', { ascending: true });

  let remaining = amountPence;
  for (const inv of (invoices ?? []) as { id: string; balance_pence: number; status: string }[]) {
    if (remaining <= 0) break;
    if (inv.status === 'void') continue;
    const balance = inv.balance_pence ?? 0;
    if (balance <= 0) continue;
    const alloc = Math.min(remaining, balance);
    if (alloc <= 0) continue;
    const { error: allocErr } = await sb
      .from('payment_allocations')
      .insert({ tenant_id: tenantId, payment_id: payment.id, invoice_id: inv.id, amount_pence: alloc });
    if (allocErr) throw new Error(allocErr.message);
    remaining -= alloc;
  }

  revalidatePath('/ops/billing');
  revalidatePath(`/ops/agreements/${agreementId}`);
}

/* ── Resolve a compliance obligation ─────────────────────────────────────── */
export async function resolveObligation(id: string, _formData?: FormData): Promise<void> {
  await requireRole(['ops']);
  const sb = await createClient();
  const { error } = await sb
    .from('obligations')
    .update({ status: 'resolved', resolved_on: new Date().toISOString().slice(0, 10) })
    .eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/ops/compliance');
  revalidatePath('/ops');
}

/* ── Log a new pass-through charge ───────────────────────────────────────── */
export async function createCharge(formData: FormData): Promise<void> {
  await requireRole(['ops']);
  const sb = await createClient();

  const receivedOn = str(formData, 'received_on') ?? new Date().toISOString().slice(0, 10);
  // 48-hour reporting clock from receipt — drives the overdue indicator.
  const reportDueAt = new Date(new Date(receivedOn).getTime() + 48 * 60 * 60 * 1000).toISOString();

  const tenantId = await currentTenantId();
  const { error } = await sb.from('charges').insert({
    tenant_id: tenantId,
    vehicle_id: reqStr(formData, 'vehicle_id'),
    driver_id: str(formData, 'driver_id'),
    type: (str(formData, 'type') ?? 'other') as Enums['charge_type'],
    authority: str(formData, 'authority'),
    reference: str(formData, 'reference'),
    incident_on: str(formData, 'incident_on'),
    received_on: receivedOn,
    report_due_at: reportDueAt,
    amount_pence: poundsField(formData, 'amount'),
    status: 'received',
  });
  if (error) throw new Error(error.message);
  revalidatePath('/ops/charges');
}

/* ── Update a charge's status (driver_notified / paid_by_driver / …) ─────── */
export async function updateChargeStatus(id: string, status: string, _formData?: FormData): Promise<void> {
  await requireRole(['ops']);
  const sb = await createClient();
  const { error } = await sb
    .from('charges')
    .update({ status: status as Enums['charge_status'] })
    .eq('id', id);
  if (error) throw new Error(error.message);

  // When ops marks a charge as notified, alert the liable driver (email/SMS).
  if (status === 'driver_notified') {
    const { data: charge } = await sb
      .from('charges')
      .select('amount_pence, type, authority, reference, driver_id, tenant_id')
      .eq('id', id)
      .maybeSingle();
    const c = charge as { amount_pence: number; type: string; authority: string | null; reference: string | null; driver_id: string | null; tenant_id: string } | null;
    if (c?.driver_id) {
      await sendDriverMessage(
        c.tenant_id,
        c.driver_id,
        `New ${c.type.toUpperCase()} charge — ${formatGBP(c.amount_pence)}`,
        `A ${c.type} charge from ${c.authority ?? 'an authority'} (ref ${c.reference ?? 'n/a'}) for ${formatGBP(
          c.amount_pence,
        )} is your liability under your agreement. Please action within 48 hours.`,
      );
    }
  }

  // When a charge is recorded as settled, confirm closure to the driver.
  if (status === 'paid_by_driver' || status === 'paid_by_company') {
    const { data: charge } = await sb
      .from('charges')
      .select('amount_pence, type, authority, driver_id, tenant_id')
      .eq('id', id)
      .maybeSingle();
    const c = charge as { amount_pence: number; type: string; authority: string | null; driver_id: string | null; tenant_id: string } | null;
    if (c?.driver_id) {
      await sendDriverMessage(
        c.tenant_id,
        c.driver_id,
        `Charge settled — ${formatGBP(c.amount_pence)}`,
        `Your ${c.authority ?? c.type} charge for ${formatGBP(c.amount_pence)} has been recorded as ${
          status === 'paid_by_company' ? 'paid by the company' : 'settled by you'
        }. No further action is needed.`,
      );
    }
  }
  revalidatePath('/ops/charges');
}

/* ── Add a maintenance record ────────────────────────────────────────────── */
export async function addMaintenance(formData: FormData): Promise<void> {
  await requireRole(['ops']);
  const sb = await createClient();
  const odo = str(formData, 'odometer_miles');
  const tenantId = await currentTenantId();
  const { error } = await sb.from('maintenance_records').insert({
    tenant_id: tenantId,
    vehicle_id: reqStr(formData, 'vehicle_id'),
    payer: (str(formData, 'payer') ?? 'company') as 'company' | 'driver',
    description: reqStr(formData, 'description'),
    cost_pence: poundsField(formData, 'cost'),
    service_on: str(formData, 'service_on') ?? new Date().toISOString().slice(0, 10),
    odometer_miles: odo ? Number(odo) : null,
  });
  if (error) throw new Error(error.message);
  revalidatePath('/ops/maintenance');
}

/* ── Create a vehicle ────────────────────────────────────────────────────── */
export async function createVehicle(formData: FormData): Promise<void> {
  await requireRole(['ops']);
  const tenantId = await currentTenantId();
  const sb = await createClient();
  const year = str(formData, 'model_year');
  const { error } = await sb.from('vehicles').insert({
    tenant_id: tenantId,
    registration: reqStr(formData, 'registration').toUpperCase(),
    make: str(formData, 'make') ?? 'Mercedes-Benz',
    model: str(formData, 'model') ?? 'S580e 4MATIC Long',
    colour: str(formData, 'colour'),
    model_year: year ? Number(year) : null,
    fuel: (str(formData, 'fuel') ?? 'phev') as Enums['fuel_type'],
    co2_gkm: str(formData, 'co2_gkm') ? Number(str(formData, 'co2_gkm')) : null,
    list_value_pence: poundsField(formData, 'list_value'),
    status: (str(formData, 'status') ?? 'available') as Enums['vehicle_status'],
  });
  if (error) throw new Error(error.message);
  // Best-effort: a wrong count for a day is tolerable, a vehicle that cannot
  // be saved is not. The nightly cron reconciles.
  await syncBilledVehicles(tenantId).catch((e: unknown) =>
    console.error('[billed_vehicles] sync failed', tenantId, e),
  );
  revalidatePath('/ops/fleet');
}

/** The caller's active tenant id — new writes set tenant_id explicitly so they
 *  work for any tenant (not just the seed default the RLS check would fall back to). */
async function currentTenantId(): Promise<string> {
  const ctx = await getAuthContext();
  if (!ctx?.tenantId) throw new Error('No active tenant for this account.');
  return ctx.tenantId;
}

/* ── Create a hire agreement (standard or rent-to-buy) ────────────────────── */
export async function createAgreement(formData: FormData): Promise<void> {
  await requireRole(['ops']);
  await requireEntitlement('rental.core');
  const tenantId = await currentTenantId();
  const sb = await createClient();

  const type = (str(formData, 'type') ?? 'standard') as Enums['agreement_type'];
  // Weekly rate is entered VAT-inclusive; split into net + VAT so gross = net + vat.
  const gross = poundsField(formData, 'weekly_gross');
  const vatRate = Number(str(formData, 'vat_rate') ?? '20');
  const vat = Math.round((gross * vatRate) / (100 + vatRate));
  const net = gross - vat;
  const termWeeks = str(formData, 'term_weeks');

  const { error } = await sb.from('agreements').insert({
    tenant_id: tenantId,
    type,
    vehicle_id: reqStr(formData, 'vehicle_id'),
    driver_id: reqStr(formData, 'driver_id'),
    status: (str(formData, 'status') ?? 'active') as Enums['agreement_status'],
    start_date: str(formData, 'start_date'),
    term_weeks: termWeeks ? Number(termWeeks) : type === 'rtb' ? 156 : null,
    weekly_gross_pence: gross,
    weekly_net_pence: net,
    weekly_vat_pence: vat,
    deposit_pence: poundsField(formData, 'deposit'),
    option_credit_weekly_pence: type === 'rtb' ? poundsField(formData, 'option_credit_weekly') : null,
  });
  if (error) throw new Error(error.message);
  revalidatePath('/ops/agreements');
}

/* ── Record the company's funder finance agreement for a vehicle ──────────── */
export async function createFinanceAgreement(formData: FormData): Promise<void> {
  await requireRole(['ops']);
  await requireEntitlement('rental.core');
  const tenantId = await currentTenantId();
  const sb = await createClient();
  const apr = Number(str(formData, 'apr') ?? '0');
  const { error } = await sb.from('finance_agreements').insert({
    tenant_id: tenantId,
    vehicle_id: reqStr(formData, 'vehicle_id'),
    funder: str(formData, 'funder'),
    reference: str(formData, 'reference'),
    initial_rental_pence: poundsField(formData, 'initial_rental'),
    monthly_payment_pence: poundsField(formData, 'monthly_payment'),
    apr: Number.isNaN(apr) ? 0 : apr,
    term_months: Number(reqStr(formData, 'term_months')),
    start_on: str(formData, 'start_on'),
    amount_financed_pence: poundsField(formData, 'amount_financed') || null,
    gfv_amount_pence: poundsField(formData, 'gfv_amount') || null,
    gfv_due_on: str(formData, 'gfv_due_on'),
  } as never);
  if (error) throw new Error(error.message);
  revalidatePath('/ops/finance');
  revalidatePath('/ops/fleet');
}

/* ── Ops records a driver's insurance certificate (ops side; drivers upload their own) ── */
export async function createInsuranceCertificate(formData: FormData): Promise<void> {
  await requireRole(['ops']);
  const tenantId = await currentTenantId();
  const sb = await createClient();
  const { error } = await sb.from('insurance_certificates').insert({
    tenant_id: tenantId,
    driver_id: reqStr(formData, 'driver_id'),
    insurer: reqStr(formData, 'insurer'),
    policy_no: reqStr(formData, 'policy_no'),
    cover_from: reqStr(formData, 'cover_from'),
    cover_to: reqStr(formData, 'cover_to'),
    company_interested_party: formData.get('company_interested_party') === 'on',
    status: (str(formData, 'status') ?? 'verified') as Enums['cert_status'],
  } as never);
  if (error) throw new Error(error.message);
  revalidatePath('/ops/drivers');
}

/* ── Create a driver ─────────────────────────────────────────────────────── */
export async function createDriver(formData: FormData): Promise<void> {
  await requireRole(['ops']);
  const sb = await createClient();
  const tenantId = await currentTenantId();
  const { error } = await sb.from('drivers').insert({
    tenant_id: tenantId,
    full_name: reqStr(formData, 'full_name'),
    email: str(formData, 'email'),
    phone: str(formData, 'phone'),
    status: (str(formData, 'status') ?? 'lead') as Enums['driver_status'],
    pco_licence_no: str(formData, 'pco_licence_no'),
    pco_licence_expiry: str(formData, 'pco_licence_expiry'),
  });
  if (error) throw new Error(error.message);
  revalidatePath('/ops/drivers');
}
