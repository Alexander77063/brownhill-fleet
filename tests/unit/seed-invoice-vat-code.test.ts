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
// "you sold £25,500 of rentals" in the same breath.
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
//
// And it checks the CHAIN the seed depends on, because a gate that only
// checks the seed's own text is a gate that passes when the migrations move
// out from under it. The seed calls a function; the function has to exist,
// has to mean what the seed assumes it means, and has to have a code to find.
// Those are facts about files that exist in this repository, so they can be
// checked without a database.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const SEED = resolve(ROOT, 'supabase/seed.sql');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');

const seed = readFileSync(SEED, 'utf8');

/** Every migration, in the order they are applied. */
const migrationNames = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const migrationText = migrationNames
  .map((name) => readFileSync(resolve(MIGRATIONS, name), 'utf8'))
  .join('\n');

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

/**
 * Split SQL on the commas that separate VALUES, ignoring the commas inside
 * parentheses, function calls and string literals.
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        // '' inside a literal is an escaped quote, not the end of it.
        if (text[i + 1] === quote) {
          current += text[++i];
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** The contents of the first balanced `(...)` after `marker`. */
function balancedGroupAfter(text: string, marker: string): string | null {
  const at = text.toLowerCase().indexOf(marker.toLowerCase());
  if (at === -1) return null;
  const open = text.indexOf('(', at + marker.length);
  if (open === -1) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (text[i + 1] === quote) {
          i++;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** The values an insert supplies, in column order. */
function insertValues(body: string): string[] {
  const tuple = balancedGroupAfter(body, 'values');
  if (tuple === null) return [];
  return splitTopLevel(tuple);
}

/** The first argument the seed passes to `accounting.invoice_vat_code_id`. */
function vatCodeArgument(value: string): string | null {
  const match = value.match(/accounting\.invoice_vat_code_id\s*\(([^,)]*)/i);
  return match ? match[1].trim() : null;
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

  it('derives the VAT code from the invoice\'s own VAT amount', () => {
    // The failure this guards against is drift, not a missing column: the
    // invoice could say one thing and the VAT code could be derived from
    // another, and the VAT return would then group an invoice under a code
    // that does not match its own arithmetic.
    //
    // So the invoice's vat_pence must not be a bare literal (a literal is a
    // second copy of the fact, and a second copy is what drifts), and the
    // argument the VAT code is derived from must be that very value.
    for (const insert of invoiceInserts(seed)) {
      const vatIndex = insert.columns.indexOf('vat_pence');
      const codeIndex = insert.columns.indexOf('vat_code_id');
      expect(vatIndex, 'the seeded invoice must carry a vat_pence column').toBeGreaterThanOrEqual(0);
      expect(codeIndex).toBe(vatIndex + 1);

      const values = insertValues(insert.body);
      expect(
        values.length,
        'the seeded invoice must supply one value per column',
      ).toBe(insert.columns.length);

      const vatValue = values[vatIndex];
      const codeValue = values[codeIndex];

      expect(
        vatValue,
        "the invoice's VAT amount must not be a bare literal — it and the VAT code's VAT amount must be the same value, not two copies of it",
      ).not.toMatch(/^\d+$/);

      expect(
        vatCodeArgument(codeValue),
        'the VAT code must be derived from the invoice\'s own VAT amount',
      ).toBe(vatValue);
    }
  });
});

describe('the chain the seed depends on', () => {
  it('is created by a migration', () => {
    // If the function is renamed, the seed raises at run time — but only in
    // the docker-backed gate, which is not the only thing that reads this
    // repository. The seed calls a name; the name has to exist.
    expect(migrationText).toMatch(
      /create\s+or\s+replace\s+function\s+accounting\.invoice_vat_code_id\s*\(\s*p_vat_pence\s+bigint\s*,\s*p_tenant\s+uuid\s*\)/i,
    );
  });

  it('sends an invoice that carries VAT to T1', () => {
    // The rule the seed relies on: VAT on the invoice means standard-rated
    // (T1), no VAT means zero-rated (T0). The VAT return groups on the code
    // and only T1 contributes to box 1, so a seeded invoice whose VAT were
    // mapped to anything else would still be invisible to the return.
    expect(migrationText).toMatch(/p_vat_pence\s*=\s*0\s+then\s+'T0'\s+else\s+'T1'/i);
  });

  it('has a T1 code for the function to find', () => {
    // The function raises when it finds nothing, which is the right
    // behaviour — the seed fails loudly rather than creating invoices the
    // return cannot see. But that only holds if a T1 code exists.
    expect(migrationText).toMatch(
      /insert\s+into\s+(accounting\.)?vat_codes\b[^;]*'T1'/is,
    );
  });

  it('keeps the code the tenant gets from being the global one by accident', () => {
    // The function prefers a tenant's own code over the global one. The
    // seeded global code (tenant_id null) is the fallback and is correct
    // for the demo tenant; what would NOT be correct is a function that
    // ignored the tenant entirely, because a real tenant's own code would
    // then never win.
    expect(migrationText).toMatch(/vc\.tenant_id\s+is\s+null\s+or\s+vc\.tenant_id\s*=\s*p_tenant/i);
  });
});
