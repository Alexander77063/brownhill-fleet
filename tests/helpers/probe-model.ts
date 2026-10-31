// Temporary probe: what does the schema model know about these tables?
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { buildSchemaModel } from './schema-model';

const REPO = path.resolve(__dirname, '../..');
const shim = {
  name: '0000_supabase_shim.sql',
  sql: readFileSync(path.join(REPO, 'standalone/sql/0000_supabase_shim.sql'), 'utf8'),
};
const migrations = readdirSync(path.join(REPO, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ name: f, sql: readFileSync(path.join(REPO, 'supabase/migrations', f), 'utf8') }));
const model = buildSchemaModel([shim, ...migrations]);
for (const t of ['invoices', 'payments', 'payment_allocations', 'agreements']) {
  const tab = model.get('public', t);
  console.log(`\n=== public.${t} === origin=${tab?.origin} columns=${tab ? tab.columns.size : 'MISSING'}`);
  if (tab) console.log([...tab.columns].sort().join(', '));
}
