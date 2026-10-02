/**
 * Idempotent payment ingestion — the single chokepoint through which ALL money
 * enters the system (provider webhooks, manual bank entries, cash). The KEY
 * INVARIANT is that money is recorded at most once per (source, idempotency_key):
 * the `payments` table has a UNIQUE (source, idempotency_key) constraint and we
 * guard on it here so a webhook retry and a manual entry can never double-count.
 *
 * On the FIRST successful insert (and only then) we auto-allocate the receipt
 * to that agreement's oldest open/part-paid invoices. Re-allocating on a retry
 * would re-bill the same cash, so allocation runs strictly when created === true.
 */

import { createServiceClient } from '@/lib/supabase/server';

export type PaymentSource = 'manual' | 'bank_transfer' | 'gocardless' | 'stripe' | 'cash';

export interface IngestOpts {
  source: PaymentSource;
  /** Provider-unique id (GC payment id, Stripe event/PI id, bank ref...). */
  idempotencyKey: string;
  /** Gross amount received, integer pence (> 0). */
  amountPence: number;
  agreementId?: string;
  driverId?: string;
  /** The tenant that authenticated the webhook (from the /[tenantId] path). If
   *  set, the tenant derived from the agreement/driver MUST match it — otherwise
   *  a tenant could post an event referencing another tenant's agreement id and
   *  have the payment mis-filed against the victim. */
  expectedTenantId?: string;
  externalRef?: string;
  /** Date money was received (YYYY-MM-DD); defaults to DB current_date. */
  receivedOn?: string;
  raw?: unknown;
}

export interface IngestResult {
  created: boolean;
  paymentId: string | null;
  allocatedPence: number;
}

export async function ingestPayment(opts: IngestOpts): Promise<IngestResult> {
  if (!opts.amountPence || opts.amountPence <= 0) {
    // Nothing collectable (e.g. a £0 / failed provider event) — record nothing.
    return { created: false, paymentId: null, allocatedPence: 0 };
  }

  // Service-role client: webhooks/cron run without a user session and must
  // bypass RLS to write into payments.
  const sb = createServiceClient();

  // Derive the owning tenant from the associated record so the payment (and any
  // allocations) land under the correct tenant rather than the transitional
  // default. Prefer the agreement (the primary association), then the driver.
  let tenantId: string | null = null;
  if (opts.agreementId) {
    const { data: agreement } = await sb
      .from('agreements')
      .select('tenant_id')
      .eq('id', opts.agreementId)
      .maybeSingle();
    tenantId = (agreement as { tenant_id: string } | null)?.tenant_id ?? null;
  } else if (opts.driverId) {
    const { data: driver } = await sb
      .from('drivers')
      .select('tenant_id')
      .eq('id', opts.driverId)
      .maybeSingle();
    tenantId = (driver as { tenant_id: string } | null)?.tenant_id ?? null;
  }
  if (!tenantId) {
    throw new Error('payment ingest failed: could not resolve tenant for payment');
  }
  // Reject a cross-tenant reference: the authenticated (webhook) tenant must own
  // the agreement/driver this payment claims to be for.
  if (opts.expectedTenantId && tenantId !== opts.expectedTenantId) {
    throw new Error('payment ingest rejected: agreement/driver belongs to a different tenant');
  }

  const insertRow: Record<string, unknown> = {
    source: opts.source,
    idempotency_key: opts.idempotencyKey,
    amount_pence: opts.amountPence,
    status: 'confirmed',
    tenant_id: tenantId,
  };
  if (opts.agreementId) insertRow.agreement_id = opts.agreementId;
  if (opts.driverId) insertRow.driver_id = opts.driverId;
  if (opts.externalRef) insertRow.external_ref = opts.externalRef;
  if (opts.receivedOn) insertRow.received_on = opts.receivedOn;
  if (opts.raw !== undefined) insertRow.raw = opts.raw;

  // Try a plain insert. A duplicate (source, idempotency_key) surfaces as a
  // unique-violation (Postgres 23505) rather than a throw — that's our guard.
  const { data: inserted, error } = await sb
    .from('payments')
    .insert(insertRow as never)
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      // Already ingested. Return the existing id; DO NOT allocate again.
      const { data: existing } = await sb
        .from('payments')
        .select('id')
        .eq('source', opts.source)
        .eq('idempotency_key', opts.idempotencyKey)
        .maybeSingle();
      return {
        created: false,
        paymentId: (existing as { id: string } | null)?.id ?? null,
        allocatedPence: 0,
      };
    }
    throw new Error(`payment ingest failed: ${error.message}`);
  }

  const paymentId = (inserted as { id: string }).id;

  // Newly inserted — auto-allocate to the agreement's oldest unpaid invoices.
  let allocatedPence = 0;
  if (opts.agreementId) {
    allocatedPence = await allocateToInvoices(
      sb,
      paymentId,
      opts.agreementId,
      opts.amountPence,
      tenantId,
    );
  }

  return { created: true, paymentId, allocatedPence };
}

/**
 * FIFO-allocate `amountPence` of a payment across an agreement's outstanding
 * invoices (oldest first). `v_invoice_balance` exposes per-invoice
 * `balance_pence`; the DB `check_allocation` + `sync_invoice_status` triggers
 * enforce limits and roll up invoice.status. Returns total pence allocated.
 */
async function allocateToInvoices(
  sb: ReturnType<typeof createServiceClient>,
  paymentId: string,
  agreementId: string,
  amountPence: number,
  tenantId: string,
): Promise<number> {
  const { data: invoices } = await sb
    .from('v_invoice_balance')
    .select('id, balance_pence, issued_on')
    .eq('agreement_id', agreementId)
    .gt('balance_pence', 0)
    .order('issued_on', { ascending: true });

  const rows = (invoices ?? []) as Array<{ id: string; balance_pence: number }>;

  let remaining = amountPence;
  let allocated = 0;
  for (const inv of rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, inv.balance_pence);
    if (take <= 0) continue; // amount_pence > 0 is enforced by the DB check
    const { error } = await sb
      .from('payment_allocations')
      .insert({
        payment_id: paymentId,
        invoice_id: inv.id,
        amount_pence: take,
        tenant_id: tenantId,
      } as never);
    if (error) {
      // A concurrent allocation may have consumed the balance; skip and move on
      // rather than failing the whole ingest (the payment row already exists).
      continue;
    }
    remaining -= take;
    allocated += take;
  }
  return allocated;
}
