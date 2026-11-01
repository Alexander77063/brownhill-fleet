'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth';
import { getAuthContext, requirePermission } from '@/lib/auth/context';
import { syncBilledVehicles } from '@/lib/catalogue/quantity';
import { requireEntitlement } from '@/lib/entitlements';
import { pounds, formatGBP } from '@/lib/money';
import { localDb } from '@/lib/auth/local-store';
import { allocatePaymentToInvoices } from '@/lib/accounting/allocation';
import { postPaymentToLedger } from '@/lib/accounting/gl-posting';
import { withJournalTx } from '@/lib/accounting/journal-bridge';
import { rtbBillingTerms } from '@/lib/rtb-calculator';
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
  // Permission-based (not role-based): both ops and accounts users with
  // payments.record can record payments; the /accounts portal routes the
  // accountant here when they're granted the perm.
  //
  // The context is read BEFORE anything is written, because it carries the
  // tenant every statement below is scoped to, and the user the ledger entry
  // is posted by.
  const ctx = await requirePermission('payments.record');

  const agreementId = reqStr(formData, 'agreement_id');
  const amountPence = poundsField(formData, 'amount');
  if (amountPence <= 0) throw new Error('Payment amount must be greater than zero');
  const source = (str(formData, 'source') ?? 'manual') as 'manual' | 'bank_transfer' | 'cash';
  const receivedOn = str(formData, 'received_on') ?? new Date().toISOString().slice(0, 10);
  const tenantId = ctx.tenantId;

  const sql = await localDb();

  // The agreement must belong to the operator's tenant. The write below runs
  // on the direct connection, which bypasses RLS, so the tenant is named here
  // rather than inherited from a policy.
  const agreementRows = (await sql`
    select id, driver_id
      from public.agreements
     where id = ${agreementId}::uuid
       and tenant_id = ${tenantId}::uuid
  `) as Array<{ id: string; driver_id: string | null }>;
  if (!agreementRows.length) {
    throw new Error('That agreement does not exist in your account.');
  }
  const driverId = agreementRows[0].driver_id;

  // THE RECEIPT AND ITS LEDGER ENTRY ARE ONE TRANSACTION
  // -----------------------------------------------------
  // This used to write the payment, then the allocations, as three separate
  // statements — and never wrote a ledger entry at all, because
  // `postPaymentJournal` had no call site anywhere in the product. So money
  // the operator recorded by hand left no trace in the trial balance.
  //
  // Now the payment row, its allocations and its ledger entry are one
  // transaction. That is what makes these two impossible:
  //
  //   * a receipt the accounts do not know about;
  //   * a ledger entry for money nobody recorded.
  //
  // It also means a receipt cannot be recorded into a period the ledger has
  // shut: the whole write is refused and the operator is told which period to
  // reopen, rather than a receipt sitting in the books with nothing behind
  // it.
  await withJournalTx(async (tx) => {
    const inserted = (await tx`
      insert into public.payments
        (driver_id, agreement_id, source, idempotency_key, amount_pence,
         received_on, status, tenant_id)
      values (${driverId}::uuid, ${agreementId}::uuid,
              ${source}::public.payment_source, ${randomKey(source)},
              ${amountPence.toString()}, ${receivedOn}::date,
              'confirmed'::public.payment_status, ${tenantId}::uuid)
      returning id, received_on::text as received_on
    `) as Array<{ id: string; received_on: string }>;
    const payment = inserted[0];

    // Allocate FIFO across the invoices that still owe money, never exceeding
    // each invoice's balance.
    await allocatePaymentToInvoices(tx, {
      paymentId: payment.id,
      agreementId,
      amountPence: BigInt(amountPence),
      tenantId,
    });

    // Dr Bank / Cr Trade Debtors, in the month the money was received.
    await postPaymentToLedger(
      tx,
      { userId: ctx.userId, tenantId },
      {
        id: payment.id,
        amountPence: BigInt(amountPence),
        receivedOn: payment.received_on,
      },
    );
  });

  revalidatePath('/ops/billing');
  revalidatePath('/accounts/billing');
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

  // ── Rent-to-buy ───────────────────────────────────────────────────────
  // The rentee signs a monthly figure; the system bills weekly. The weekly
  // columns are derived by the same engine the calculator uses, so what the
  // operator saw on screen is what the agreement holds — and what the
  // directors' report later sums.
  if (type === 'rtb') {
    const termMonths = Number(str(formData, 'term_months') ?? '0');
    const monthlyGross = poundsField(formData, 'monthly_gross');
    const vatRate = Number(str(formData, 'vat_rate') ?? '20');
    if (!Number.isFinite(termMonths) || termMonths <= 0) {
      throw new Error('A rent-to-buy agreement needs a term in months.');
    }
    if (monthlyGross <= 0) {
      throw new Error('A rent-to-buy agreement needs a monthly payment.');
    }
    const terms = rtbBillingTerms({
      termMonths,
      monthlyGrossPence: monthlyGross,
      vatRatePct: vatRate,
      optionCreditMonthlyPence: poundsField(formData, 'option_credit_monthly'),
    });

    // The monthly contract, written down as it was signed. The database
    // requires it on a rent-to-buy (migration 0077), and the directors' report
    // sums these columns rather than rebuilding them from the weekly billing.
    const vehiclePricePence = poundsField(formData, 'vehicle_price') || null;
    const vehicleCostPence = poundsField(formData, 'vehicle_cost') || null;

    const { error } = await sb.from('agreements').insert({
      tenant_id: tenantId,
      type,
      vehicle_id: reqStr(formData, 'vehicle_id'),
      driver_id: reqStr(formData, 'driver_id'),
      status: (str(formData, 'status') ?? 'active') as Enums['agreement_status'],
      start_date: str(formData, 'start_date'),
      term_weeks: terms.termWeeks,
      weekly_gross_pence: terms.weeklyGrossPence,
      weekly_net_pence: terms.weeklyNetPence,
      weekly_vat_pence: terms.weeklyVatPence,
      deposit_pence: poundsField(formData, 'deposit'),
      option_credit_weekly_pence: terms.weeklyOptionCreditPence,
      // The buyout price the rentee pays to take the car at the end of the
      // term. It was a column nobody wrote; the agreement detail page and
      // the directors' report both read it.
      agreed_residual_pence: poundsField(formData, 'agreed_residual'),
      // The monthly side of the same contract.
      term_months: termMonths,
      monthly_gross_pence: monthlyGross,
      // The price the rentee is buying the car at, and what the car cost us.
      // Null when the operator did not say: the report then reads the
      // funder's invoice, and failing that the list value, and says which.
      agreed_vehicle_price_pence: vehiclePricePence,
      agreed_vehicle_cost_pence: vehicleCostPence,
    });
    if (error) throw new Error(error.message);
    revalidatePath('/ops/agreements');
    revalidatePath('/ops/rtb-calculator');
    return;
  }

  // ── Standard rental ──────────────────────────────────────────────────
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
    term_weeks: termWeeks ? Number(termWeeks) : null,
    weekly_gross_pence: gross,
    weekly_net_pence: net,
    weekly_vat_pence: vat,
    deposit_pence: poundsField(formData, 'deposit'),
    option_credit_weekly_pence: null,
  });
  if (error) throw new Error(error.message);
  revalidatePath('/ops/agreements');
}

/* ── Record the company's funder finance agreement for a vehicle ──────────── */
export async function createFinanceAgreement(formData: FormData): Promise<void> {
  await requirePermission('billing.write');
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
