// src/lib/accounting/vat-codes.ts
// Resolving a VAT code, and working out which one an invoice belongs to.
//
// WHY THIS EXISTS
// ---------------
// `public.invoices.vat_code_id` existed since migration 0067 — and NOTHING
// EVER WROTE IT. Every invoice was created with the column null.
//
// That is not a cosmetic gap. The VAT return aggregates on it:
//
//   select vc.code, sum(i.net_pence), sum(i.vat_pence)
//     from public.invoices i
//     left join accounting.vat_codes vc on vc.id = i.vat_code_id
//    where i.status <> 'void' ...
//    group by vc.code
//
// With the column null, `vc.code` is null for every invoice, so the grouped
// rows never matched 'T1', 'T0' or 'T9'. Box 1 — the output VAT DUE to HMRC
// — was therefore always zero, while box 4 carried the whole of the sales
// net. The return said "you owe no VAT" and "you sold £40,000 of rentals"
// in the same breath. It was not a rounding error; it was the return
// under-reporting by the entire output VAT of every invoice ever raised.
//
// THE INFERENCE
// -------------
// Two codes, and only two, because vehicle rental has two:
//
//   vat_pence > 0  →  T1  standard-rated (20%)
//   vat_pence = 0  →  T0  zero-rated (0%)
//
// In a UK VAT return, output VAT on REDUCED-rate supplies (T5, 5%) belongs
// in box 1 alongside standard-rate output VAT — box 1 is "output VAT due",
// not "standard-rated VAT due" — so a reduced-rate invoice would still be
// T1 as far as the box is concerned. What the code decides is which BOX the
// net figure lands in, not the amount in box 1: box 1 carries the invoice's
// actual VAT, not a rate re-derived from the net.
//
// So the rule reduces to "is there VAT on this invoice or not", which is
// exactly what `vat_pence` says. Zero-rated (T0) is the right home for a
// rental invoice with no VAT on it.
//
// TENANT SCOPE
// ------------
// `accounting.vat_codes` is global reference data with an optional
// per-tenant override — the same shape as the chart of accounts. The
// application connects as a superuser, which bypasses row-level security, so
// the tenant is named in the SQL here.

import type { ISql } from 'postgres';

/**
 * The id of the VAT code a code names, or null when it names none.
 *
 * `tenantId` narrows the lookup to the tenant's own code when it has one;
 * the global code is the fallback. With no tenant, only the global code is
 * considered.
 */
export async function findVatCodeId(
  sql: ISql,
  code: string,
  tenantId?: string | null,
): Promise<string | null> {
  const rows = (await sql`
    select id
      from accounting.vat_codes
     where code = ${code}
       and (tenant_id is null or tenant_id = ${tenantId ?? null}::uuid)
     order by tenant_id nulls last
     limit 1
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * The VAT code an invoice carrying this much VAT belongs to.
 *
 * Pure, so the rule can be asserted without a database.
 */
export function vatCodeFor(vatPence: bigint): 'T0' | 'T1' {
  return vatPence === 0n ? 'T0' : 'T1';
}

/**
 * The id of the VAT code an invoice carrying this much VAT belongs to.
 *
 * Returns null when the seeded codes are missing — the caller decides
 * whether that is fatal. It is fatal for a posting (the invoice has to carry
 * a code or the VAT return cannot see it) and it is not fatal for a read.
 */
export async function inferVatCodeId(
  sql: ISql,
  vatPence: bigint,
  tenantId?: string | null,
): Promise<string | null> {
  return findVatCodeId(sql, vatCodeFor(vatPence), tenantId);
}

/**
 * The VAT code an invoice carrying this much VAT belongs to, or a typed error.
 *
 * For a write path. An invoice without a VAT code is an invoice the VAT
 * return cannot see, so the code is not optional there — it is the difference
 * between a return that reports the business's output VAT and one that
 * reports £0 while the sales figures say otherwise.
 *
 * The error names the code that was wanted, because "the T1 VAT code is
 * missing" says what to fix and "invoice_vat_code_required" does not.
 */
export async function requireInferredVatCodeId(
  sql: ISql,
  vatPence: bigint,
  tenantId?: string | null,
): Promise<string> {
  const code = vatCodeFor(vatPence);
  const id = await findVatCodeId(sql, code, tenantId);
  if (!id) throw new MissingVatCodeError(code, tenantId);
  return id;
}

/**
 * The VAT code an invoice needs is not in the chart.
 *
 * A named error rather than a null, because every caller of the "require"
 * form wants to stop rather than carry on: an invoice written without a code
 * is worse than an invoice that was not written at all.
 */
export class MissingVatCodeError extends Error {
  constructor(
    readonly code: string,
    readonly tenantId?: string | null,
  ) {
    super(
      `VAT codes: no code ${code}` +
        (tenantId ? ` for tenant ${tenantId}` : '') +
        '. The VAT code seed has not been applied — an invoice written without ' +
        'a code is invisible to the VAT return.',
    );
    this.name = 'MissingVatCodeError';
  }
}
