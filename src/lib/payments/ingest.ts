/**
 * Idempotent payment ingestion — the single chokepoint through which ALL money
 * enters the system (provider webhooks, manual bank entries, cash). The KEY
 * INVARIANT is that money is recorded at most once per (source, idempotency_key):
 * the `payments` table has a UNIQUE (source, idempotency_key) constraint and we
 * guard on it here so a webhook retry and a manual entry can never double-count.
 *
 * On the FIRST successful insert (and only then) we auto-allocate the receipt
 * to that agreement's oldest invoices that still owe money — open, part-paid
 * or overdue. A voided invoice is never one of them: it has been cancelled,
 * so nothing is owed on it. Re-allocating on a retry would re-bill the same
 * cash, so allocation runs strictly when created === true.
 *
 * THE PAYMENT AND ITS LEDGER ENTRY ARE ONE TRANSACTION
 * -----------------------------------------------------
 * This used to write the payment through PostgREST and never touched the
 * ledger at all. `postPaymentJournal` had no call site anywhere in the
 * product, so money arriving left no trace in the operator's trial balance:
 * the accounts showed the handful of bank lines somebody had reconciled by
 * hand, and nothing else.
 *
 * The posting and the payment row are now one transaction, which is the only
 * way both of these can be impossible:
 *
 *   * a payment with no ledger entry — money the accounts do not know about;
 *   * a ledger entry with no payment — money nobody can point at.
 *
 * It also means the receipt cannot be recorded into a period the ledger has
 * shut: the whole write is refused, the provider retries, and the money lands
 * when the operator reopens the month. A receipt that exists without its
 * ledger entry is worse than a receipt that has not arrived yet.
 */

import { localDb } from '@/lib/auth/local-store';
import { allocatePaymentToInvoices } from '@/lib/accounting/allocation';
import { postPaymentToLedger } from '@/lib/accounting/gl-posting';
import { withJournalTx } from '@/lib/accounting/journal-bridge';
import type { ISql } from 'postgres';

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

/**
 * A value that can be written to a jsonb column.
 *
 * postgres.js's `json()` helper is typed against its own `JSONValue`, which
 * the package does not export from its root. The provider payload is
 * provider-shaped — anything JSON can carry — so the cast is made once, here,
 * rather than at every call site.
 */
type JsonPayload = Parameters<ISql['json']>[0];

/**
 * The tenant that owns this payment, resolved from the record it is attached
 * to.
 *
 * The agreement is preferred (the primary association), then the driver. When
 * neither is given there is nothing to derive a tenant from, and the caller
 * has to say which tenant the money belongs to — a receipt filed against the
 * wrong tenant is worse than a receipt that was refused.
 */
async function resolveTenant(sql: ISql, opts: IngestOpts): Promise<string | null> {
  if (opts.agreementId) {
    const rows = (await sql`
      select tenant_id from public.agreements where id = ${opts.agreementId}::uuid
    `) as Array<{ tenant_id: string }>;
    return rows[0]?.tenant_id ?? null;
  }
  if (opts.driverId) {
    const rows = (await sql`
      select tenant_id from public.drivers where id = ${opts.driverId}::uuid
    `) as Array<{ tenant_id: string }>;
    return rows[0]?.tenant_id ?? null;
  }
  return null;
}

/**
 * The driver a payment belongs to, when it is attached to an agreement.
 *
 * The payment row is driver-linked so the driver's portal can show what they
 * have paid; an agreement with no driver (a vehicle-let, before it is signed)
 * contributes no driver rather than a broken link.
 *
 * A driver that belongs to ANOTHER tenant is refused rather than linked. The
 * driver's portal reads their own payments, so linking a payment to a foreign
 * driver would show one tenant's money on another tenant's customer record —
 * and the agreement the payment was raised for would say something different
 * from the driver it was attached to.
 */
async function resolveDriverId(
  sql: ISql,
  agreementId: string | undefined,
  driverId: string | undefined,
  tenantId: string,
): Promise<string | null> {
  if (driverId) {
    const owned = (await sql`
      select id from public.drivers
       where id = ${driverId}::uuid
         and tenant_id = ${tenantId}::uuid
    `) as Array<{ id: string }>;
    if (!owned.length) {
      throw new Error('payment ingest rejected: driver belongs to a different tenant');
    }
    return driverId;
  }
  if (!agreementId) return null;
  const rows = (await sql`
    select driver_id from public.agreements
     where id = ${agreementId}::uuid
       and tenant_id = ${tenantId}::uuid
  `) as Array<{ driver_id: string | null }>;
  return rows[0]?.driver_id ?? null;
}

export async function ingestPayment(opts: IngestOpts): Promise<IngestResult> {
  if (!opts.amountPence || opts.amountPence <= 0) {
    // Nothing collectable (e.g. a £0 / failed provider event) — record nothing.
    return { created: false, paymentId: null, allocatedPence: 0 };
  }
  if (!Number.isInteger(opts.amountPence)) {
    throw new Error('payment ingest failed: amountPence must be a whole number of pence.');
  }

  const sql = await localDb();

  // Derive the owning tenant from the associated record so the payment (and any
  // allocations) land under the correct tenant rather than the transitional
  // default.
  const tenantId = await resolveTenant(sql, opts);
  if (!tenantId) {
    throw new Error('payment ingest failed: could not resolve tenant for payment');
  }
  // Reject a cross-tenant reference: the authenticated (webhook) tenant must own
  // the agreement/driver this payment claims to be for.
  if (opts.expectedTenantId && tenantId !== opts.expectedTenantId) {
    throw new Error('payment ingest rejected: agreement/driver belongs to a different tenant');
  }

  const driverId = await resolveDriverId(sql, opts.agreementId, opts.driverId, tenantId);
  const amountPence = BigInt(opts.amountPence);
  const receivedOn = opts.receivedOn ?? null;

  return withJournalTx(async (tx) => {
    // 1. The payment row. Idempotent on (source, idempotency_key): a replay
    //    of the same provider event finds the row it already made rather than
    //    counting the money twice.
    const inserted = (await tx`
      insert into public.payments
        (source, idempotency_key, amount_pence, status, received_on,
         agreement_id, driver_id, external_ref, raw, tenant_id)
      values (${opts.source}::public.payment_source,
              ${opts.idempotencyKey},
              ${amountPence.toString()},
              'confirmed'::public.payment_status,
              coalesce(${receivedOn}::date, current_date),
              ${opts.agreementId ?? null}::uuid,
              ${driverId ?? null}::uuid,
              ${opts.externalRef ?? null}::text,
              ${opts.raw === undefined ? null : tx.json(opts.raw as JsonPayload)}::jsonb,
              ${tenantId}::uuid)
      on conflict (source, idempotency_key) do nothing
      returning id, received_on::text as received_on
    `) as Array<{ id: string; received_on: string }>;

    if (!inserted.length) {
      // Already ingested. Return the existing id; DO NOT allocate again and DO
      // NOT post again — the journal's own idempotency key would return the
      // same entry, but going no further means a retry cannot even take the
      // period lock, so a retry never fails because a month was closed after
      // the original posting.
      const existing = (await tx`
        select id from public.payments
         where source = ${opts.source}::public.payment_source
           and idempotency_key = ${opts.idempotencyKey}
           and tenant_id = ${tenantId}::uuid
      `) as Array<{ id: string }>;
      return { created: false, paymentId: existing[0]?.id ?? null, allocatedPence: 0 };
    }

    const payment = inserted[0];

    // 2. Allocate the receipt to the agreement's oldest outstanding invoices.
    let allocatedPence = 0n;
    if (opts.agreementId) {
      const allocation = await allocatePaymentToInvoices(tx, {
        paymentId: payment.id,
        agreementId: opts.agreementId,
        amountPence,
        tenantId,
      });
      allocatedPence = allocation.allocatedPence;
    }

    // 3. The ledger entry: Dr Bank / Cr Trade Debtors, in the month the money
    //    was received. Same transaction, so the receipt and its entry cannot
    //    come apart.
    await postPaymentToLedger(
      tx,
      { userId: null, tenantId },
      {
        id: payment.id,
        amountPence,
        receivedOn: payment.received_on,
      },
    );

    return {
      created: true,
      paymentId: payment.id,
      allocatedPence: Number(allocatedPence),
    };
  });
}
