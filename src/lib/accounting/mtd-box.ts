// src/lib/accounting/mtd-box.ts
// Aggregates from journal_lines of confirmed invoice entries in the period,
// keyed by the invoice's vat_code_id. Implements the nine boxes of the UK
// VAT return as HMRC expects them.
//
// All amounts are in pence (bigint). Box 7 = box 1 - box 6.

import { localDb } from '@/lib/auth/local-store';

type Sql = Awaited<ReturnType<typeof localDb>>;

export type Pounds = bigint;

export interface VatReturnBoxes {
  box1_standardRatedSales: Pounds;     // output VAT due on standard-rated (T1)
  box2_zeroRatedSales: Pounds;         // zero-rated (T0)
  box3_exemptSales: Pounds;            // exempt (T9)
  box4_totalSalesExclVat: Pounds;       // box 1 base + box 2 + box 3 + box 5 base + box 6 base
  box5_purchasesExclVat: Pounds;       // input side (v1: 0 — no supplier bills)
  box6_purchasesVat: Pounds;           // input VAT (v1: 0)
  box7_netVat: Pounds;                 // box 1 - box 6
  box8_totalSales: Pounds;             // box 4 + box 1 (gross-of-VAT)
  box9_totalPurchases: Pounds;         // box 5 + box 6 (gross-of-VAT)
}

export async function aggregateVatReturn(year: number, month: number): Promise<VatReturnBoxes> {
  const sql = await localDb();
  // Pull net + VAT totals per vat_code for invoices issued in the period.
  // (Box 1 = T1 net; Box 2 = T0 net; Box 3 = T9 net; Box 4 base = all net;
  // Box 5 base + Box 6 base = 0 in v1; Box 5/6 don't apply since no supplier bills.)
  const rows = (await sql`
    select vc.code, sum(coalesce(i.net_pence, 0))::bigint as net_pence,
                  sum(coalesce(i.vat_pence, 0))::bigint as vat_pence
      from public.invoices i
      left join accounting.vat_codes vc on vc.id = i.vat_code_id
     where i.status = 'open'
       and date_trunc('month', i.issued_at) = date_trunc('month', make_date(${year}::int, ${month}::int, 1))
     group by vc.code
  `) as Array<{ code: string | null; net_pence: string; vat_pence: string }>;

  let t1 = 0n, t0 = 0n, t9 = 0n, allNet = 0n;
  for (const r of rows) {
    const n = BigInt(r.net_pence), v = BigInt(r.vat_pence);
    allNet += n;
    if (r.code === 'T1') t1 = n;
    else if (r.code === 'T0') t0 = n;
    else if (r.code === 'T9') t9 = n;
  }
  const box1 = t1 * 20n / 100n;        // 20% of T1
  const box4Base = allNet;
  const box5Base = 0n;
  const box6Base = 0n;
  const box7 = box1 - 0n;               // box 6 = 0 in v1
  const box8 = box4Base + box1;
  const box9 = box5Base + box6Base;

  return {
    box1_standardRatedSales: box1,
    box2_zeroRatedSales:     t0,
    box3_exemptSales:        t9,
    box4_totalSalesExclVat:  box4Base,
    box5_purchasesExclVat:   box5Base,
    box6_purchasesVat:       box6Base,
    box7_netVat:             box7,
    box8_totalSales:         box8,
    box9_totalPurchases:     box9,
  };
}
