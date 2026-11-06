#!/usr/bin/env node
// hosted/tests/user-test/seed-report.mjs
//
// What the demo tenant actually contains, table by table.
//
// WHY THIS EXISTS
// ---------------
// The user test drives every page as every role. A page that renders 200 with
// an empty table is indistinguishable, from the operator's chair, from a page
// with a broken query — and the whole point of handing this over is that the
// operator can tell the difference. So the sweep asserts that a page shows
// REAL DATA, and this report is where that data is accounted for.
//
// It also catches the thing that matters most at handover: a table the product
// needs and the seed does not populate. An empty `accounting.bank_accounts`
// means the reconciliation screen has nothing to reconcile, and nobody finds
// out until a paying customer tries.
//
// It reads the schema from the database rather than from a list in the
// repository, so a migration that adds a table is reported here without
// anybody remembering to update a file.
//
//   DATABASE_URL=postgres://… node hosted/tests/user-test/seed-report.mjs
//
// Environment:
//   DATABASE_URL   the database to report on (required)
//   TENANT_ID      the tenant to report on (default: the demo tenant)

import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('seed-report: DATABASE_URL is not set.');
  process.exit(2);
}

const TENANT_ID =
  process.env.TENANT_ID ?? 'b1111111-1111-1111-1111-111111111111';

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

/**
 * Every table in the schemas the product reads, with its column list.
 *
 * `tenant_id` is the marker for "belongs to a tenant". A table without one is
 * global (a lookup, a catalogue) and its count is reported as-is.
 */
const tables = await sql`
  select c.table_schema as schema, c.table_name as name,
         (c.column_name = 'tenant_id') as tenant_scoped
  from information_schema.columns c
  where c.table_schema in ('public', 'accounting')
    and c.column_name = 'tenant_id'
  group by 1, 2, 3
  order by 1, 2`;

const globalTables = await sql`
  select c.table_schema as schema, c.table_name as name
  from information_schema.tables c
  where c.table_schema in ('public', 'accounting')
    and c.table_type = 'BASE TABLE'
    and not exists (
      select 1 from information_schema.columns x
      where x.table_schema = c.table_schema
        and x.table_name = c.table_name
        and x.column_name = 'tenant_id'
    )
  order by 1, 2`;

const rows = [];
for (const t of tables) {
  const count = await sql.unsafe(
    `select
       count(*) filter (where tenant_id = $1::uuid)::int as mine,
       count(*) filter (where tenant_id is null)::int as global
     from "${t.schema}"."${t.name}"`,
    [TENANT_ID],
  );
  rows.push({
    scope: 'tenant',
    schema: t.schema,
    name: t.name,
    count: count[0].mine,
    global: count[0].global,
  });
}
for (const t of globalTables) {
  const count = await sql.unsafe(
    `select count(*)::int as n from "${t.schema}"."${t.name}"`,
  );
  rows.push({ scope: 'global', schema: t.schema, name: t.name, count: count[0].n, global: 0 });
}

//
// THREE STATES, NOT TWO.
//
// The first version of this report counted a tenant-scoped table with
// `where tenant_id = $1` and called a table with zero such rows EMPTY. That
// is wrong, and it was wrong in the direction that matters: migration 0081
// made the chart of accounts and the VAT codes tenant-scoped through a
// NULLABLE `tenant_id`, where a NULL row is the GLOBAL BASELINE every tenant
// inherits and a non-NULL row is that tenant's own override. The demo tenant
// has no overrides, so the count came back 0 for a table that holds the 34
// accounts the product reads on every screen. The report said "EMPTY" about a
// table that is full.
//
// So a tenant-scoped table is counted twice: the rows that belong to THIS
// tenant, and the rows that belong to every tenant. The two answers mean
// different things and the report shows both.
//
//   * mine > 0                 — the tenant has its own rows. Fine.
//   * mine = 0, global > 0     — the tenant has NO rows of its own, but the
//                                table is not blank. For the COA and the VAT
//                                codes that is the design: the baseline IS
//                                the tenant's chart of accounts. For anything
//                                else it is a gap — the tenant can see
//                                nothing of its own — so it is listed
//                                separately rather than called empty.
//   * mine = 0, global = 0     — nobody's rows. This is the genuine gap: the
//                                product reads this table and the seed
//                                leaves it blank.
const populated = rows.filter((r) => r.count > 0 || r.global > 0);
const empty = rows.filter((r) => r.count === 0 && r.global === 0);
const baselineOnly = rows.filter((r) => r.count === 0 && r.global > 0);

console.log('='.repeat(78));
console.log(`seed-report: tenant ${TENANT_ID}`);
console.log('='.repeat(78));
console.log(
  `${rows.length} tables — ${populated.length} with content, ${empty.length} empty, ` +
    `${baselineOnly.length} with only shared rows`,
);
console.log('');

const bySchema = new Map();
for (const r of rows) {
  if (!bySchema.has(r.schema)) bySchema.set(r.schema, []);
  bySchema.get(r.schema).push(r);
}

for (const [schema, list] of bySchema) {
  console.log(`${schema}`);
  for (const r of list) {
    const mark = r.count === 0 && r.global === 0 ? ' EMPTY ' : String(r.count).padStart(6);
    const shared = r.global > 0 ? `  (+${r.global} shared)` : '';
    console.log(`  ${mark}  ${r.name}${r.scope === 'global' ? '   (global)' : ''}${shared}`);
  }
  console.log('');
}

if (empty.length) {
  console.log('EMPTY TABLES — the product reads these, and the seed leaves them blank');
  console.log('-'.repeat(78));
  for (const r of empty) console.log(`  ${r.schema}.${r.name}${r.scope === 'global' ? ' (global)' : ''}`);
  console.log('');
}

if (baselineOnly.length) {
  console.log('SHARED ROWS ONLY — the table has content, but none of it belongs to this tenant');
  console.log('-'.repeat(78));
  for (const r of baselineOnly) {
    console.log(`  ${r.schema}.${r.name} — ${r.global} shared row(s), 0 of its own`);
  }
  console.log('');
  console.log(
    'For the chart of accounts and the VAT codes this is the design: a NULL',
  );
  console.log(
    'tenant_id row is the baseline every tenant inherits (migration 0081), so',
  );
  console.log(
    'the tenant reads those rows. For any other table it is a gap — the tenant',
  );
  console.log('has nothing of its own to show.');
  console.log('');
}

await sql.end({ timeout: 5 });
