/**
 * Reference numbering — one allocator for the human-readable references used
 * across the app: invoices, expenses, bookings, receipts, and so on. Numbers are
 * per-tenant, per-year, monotonic and concurrency-safe (INV-2026-000123).
 */

import { requireTenantContext } from '@/lib/auth/context';
import { createClient } from '@/lib/supabase/server';

export type RefKind = 'INV' | 'EXP' | 'BKG' | 'RCP' | 'PCN' | 'CRD' | (string & {});

/**
 * Allocate the next reference of `kind` for the current tenant, e.g.
 * `nextRef('INV')` → "INV-2026-000123". Each call consumes a number; call it once
 * per document at the point you persist it.
 */
export async function nextRef(kind: RefKind): Promise<string> {
  const ctx = await requireTenantContext();
  const sb = await createClient();
  const { data, error } = await sb.rpc('next_ref', { p_tenant: ctx.tenantId, p_kind: kind });
  if (error || !data) {
    throw new Error(`could not allocate ${kind} reference: ${error?.message ?? 'no value returned'}`);
  }
  return data;
}
