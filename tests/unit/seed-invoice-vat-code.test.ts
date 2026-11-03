// tests/unit/seed-invoice-vat-code.test.ts
//
// The demo seed's invoices must carry a VAT code.
//
// WHY THIS FILE EXISTS
// --------------------
// `public.invoices.vat_code_id` existed since migration 0067 and NOTHING
// EVER WROTE IT. Every invoice was created with the column null, and the VAT
// return groups on it:
//
//   select vc.code, sum(i.net_pence), sum(i.vat_pence)
//     from public.invoices i
//     left join accounting.vat_codes vc on vc.id = i.vat_code_id
//    where i.status <> 'void'
//    group by vc.code
//
// With the column null, `vc.code` is null for every invoice, so the grouped
// rows never matched 'T1' or 'T0'. `aggregateVatReturn` adds every row's net
// to box 4 whatever its code, but only sets box 1 from the row whose code IS
// 'T1' — so box 1, the output VAT DUE to HMRC, was permanently zero while
// box 4 carried the month's net sales. The return said "you owe no VAT" and
// "you sold £40,000 of rentals" in the same breath.
//
// The application was fixed (the rent cron writes the code) and the history
// was fixed (migration 0086 backfills every invoice that has none). The DEMO
// SEED was not: it runs AFTER the migrations, so its thirty invoices are
// created after the backfill has already run, and it leaves them with a null
// code. The local environment — the one a reviewer opens, the one a new
// developer trusts, the one that is handed over as the reproducible
// environment — shows every monthly VAT return reporting £0 of output VAT
// while box 4 carries that month's net sales: across the thirty seeded weeks,
// £25,500 of net sales with £5,100 of output VAT the return cannot see.
//
// The seed must therefore write the code, using the SAME rule the
// application uses: `accounting.invoice_vat_code_id`, the function migration
// 0086 created.
//
// THE SEED IS READ, NOT RUN
// -------------------------
// Running it needs a database. This reads the file and checks what it
// inserts, which is the part that was wrong — the column list and the value.
// `hosted/tests/seed-fail-closed.sh` is the gate that actually runs the seed
// against a freshly migrated database; this one says what the seed must
// contain before anyone gets that far.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SEED = resolve(process.cwd(), 'supabase/seed.sql');
const seed = readFileSync(SEED, 'utf8');

/** Every `insert into invoices (...)` in the seed, with its column list. */
function invoiceInserts(source: string): Array<{ columns: string[]; body: string }> {
  const found: Array<{ columns: string[]; body: string }> = [];
  const pattern = /insert\s+into\s+invoices\s*\(([^)]*)\)([\s\S]*?);/gi;
  for (const match of source.matchAll(pattern)) {
    found.push({
      columns: match[1]
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean),
      body: match[2],
    });
  }
  return found;
}

describe('the demo seed', () => {
  it('creates invoices at all', () => {
    // If the seed ever stops creating invoices, the checks below would pass
    // vacuously — the same trap the SQL contract gates used to have.
    expect(invoiceInserts(seed).length).toBeGreaterThan(0);
  });

  it('gives every invoice a vat_code_id column', () => {
    for (const insert of invoiceInserts(seed)) {
      expect(
        insert.columns,
        'every seeded invoice must carry a vat_code_id — the VAT return groups on it',
      ).toContain('vat_code_id');
    }
  });

  it('fills the vat_code_id with the rule the application uses', () => {
    for (const insert of invoiceInserts(seed)) {
      // Not a literal null, and not a guess: the same function the rent cron
      // and the backfill use, so the demo tenant's codes cannot drift from
      // the codes a real tenant gets.
      expect(
        insert.body,
        'the seeded vat_code_id must come from accounting.invoice_vat_code_id',
      ).toContain('accounting.invoice_vat_code_id');
    }
  });
});
