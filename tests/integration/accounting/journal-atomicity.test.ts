// tests/integration/accounting/journal-atomicity.test.ts
//
// The ledger's atomicity, against a real postgres.
//
// The unit test beside this one (tests/unit/accounting/journal-bridge-
// transaction.test.ts) proves the bridge's transaction DISCIPLINE with a fake
// connection. This file proves the thing that actually matters: that a
// posting made through the real code, against the real schema, either lands
// whole or does not land at all.
//
// THE PROPERTY
// ------------
// `accounting.journal_lines` carries a deferred balance trigger:
//
//   create constraint trigger trg_journal_lines_balanced
//     after insert or update on accounting.journal_lines
//     deferrable initially deferred
//     for each row execute function accounting.journal_balanced();
//
// Deferred on purpose — the balance can only be judged once every line of an
// entry is present. So the check runs at COMMIT of the enclosing
// transaction, and only there is it meaningful.
//
// Write the same entry WITHOUT a transaction and the trigger fires at the end
// of each individual statement: the first line is judged on its own, the
// entry is rejected as unbalanced, and the entry row — already committed —
// stays behind as an ORPHAN with no lines.
//
// So:
//
//   1. a balanced entry commits with every one of its lines and its audit
//      row;
//   2. an unbalanced entry commits NOTHING — no entry row, no lines, no
//      audit row;
//   3. and the same unbalanced entry written WITHOUT a transaction DOES
//      leave an orphan.
//
// Test 3 is the one that keeps tests 1 and 2 honest. It reproduces the old
// behaviour deliberately and asserts that the orphan really does appear. If
// that ever stops being true — if the trigger stops firing, or the schema
// changes — the test fails, and the two tests above stop meaning anything.
//
// IT NEEDS A DATABASE
// -------------------
// A real postgres with the migrations applied. Without DATABASE_URL the whole
// file is skipped, OUT LOUD — a skipped check and a passing check look the
// same in a build log, and this one is worth knowing about.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It creates its own tenant and user, and removes them afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { commitJournalForPayment, withJournalTx } from '@/lib/accounting/journal-bridge';
import { postPaymentJournal, type PostResult } from '@/lib/accounting/journal';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[integration] DATABASE_URL is not set — the accounting ledger tests are being SKIPPED.\n' +
      '            They need a real postgres with the migrations applied. See hosted/README.md.',
  );
}

describe.skipIf(!DATABASE_URL)('the ledger against a real postgres', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const userId = randomUUID();
  const slug = `ledger-atomicity-${tenantId.slice(0, 8)}`;

  let bankGlId = '';
  let arAccountId = '';
  let periodId = '';

  const ctx = { userId, tenantId };

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantId}::uuid, 'Ledger atomicity test', ${slug})
    `;
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}::uuid, ${`${slug}@brownhill.test`}, '{"role":"ops"}'::jsonb)
    `;

    const accounts = (await sql`
      select code, id from accounting.chart_of_accounts
       where code in ('1100', '1200') and tenant_id is null
    `) as Array<{ code: string; id: string }>;
    const byCode = new Map(accounts.map((a) => [a.code, a.id]));
    bankGlId = byCode.get('1200') ?? '';
    arAccountId = byCode.get('1100') ?? '';
    if (!bankGlId || !arAccountId) {
      throw new Error('The chart of accounts is missing 1200 (Bank) or 1100 (Trade Debtors).');
    }

    // The period the postings land in — the current one, so the bridge's own
    // upsert finds this row rather than creating a second one.
    const now = new Date();
    const periodRows = (await sql`
      insert into accounting.periods (tenant_id, year, month)
      values (${tenantId}::uuid, ${now.getUTCFullYear()}, ${now.getUTCMonth() + 1})
      on conflict (tenant_id, year, month) do update set year = excluded.year
      returning id
    `) as Array<{ id: string }>;
    periodId = periodRows[0].id;
  });

  afterAll(async () => {
    if (!sql) return;
    // In dependency order: the tenant cannot go until nothing points at it.
    await sql`delete from accounting.journal_lines where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.journal_entries where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.audit_log where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.periods where tenant_id = ${tenantId}::uuid`;
    await sql`delete from auth.users where id = ${userId}::uuid`;
    await sql`delete from public.tenants where id = ${tenantId}::uuid`;
  });

  it('commits a balanced entry with every one of its lines and its audit row', async () => {
    const paymentId = randomUUID();
    const result = postPaymentJournal({
      paymentId,
      gross: 120n,
      bankAccountGlId: bankGlId,
      arAccountId,
    });

    const journalId = await withJournalTx((tx) => commitJournalForPayment(tx, ctx, result, paymentId));

    const entries = (await sql`
      select id from accounting.journal_entries where id = ${journalId}::uuid
    `) as Array<{ id: string }>;
    expect(entries.length).toBe(1);

    const lines = (await sql`
      select debit_pence, credit_pence from accounting.journal_lines
       where journal_id = ${journalId}::uuid
    `) as Array<{ debit_pence: string; credit_pence: string }>;
    expect(lines.length).toBe(2);
    const debits = lines.reduce((sum, l) => sum + BigInt(l.debit_pence), 0n);
    const credits = lines.reduce((sum, l) => sum + BigInt(l.credit_pence), 0n);
    expect(debits).toBe(120n);
    expect(credits).toBe(120n);

    const audit = (await sql`
      select id from accounting.audit_log
       where entity_id = ${journalId}::uuid and action = 'journal_posted'
    `) as Array<{ id: string }>;
    expect(audit.length).toBe(1);
  });

  it('commits NOTHING when the entry does not balance', async () => {
    const paymentId = randomUUID();
    // Each line on its own is a legal line — one side positive, the other
    // zero — so the row-level check passes. The entry as a whole is short by
    // 20p, which is the deferred trigger's business.
    const unbalanced: PostResult = {
      lines: [
        { accountId: bankGlId, debitPence: 120n, creditPence: 0n },
        { accountId: arAccountId, debitPence: 0n, creditPence: 100n },
      ],
      sumDebits: 120n,
      sumCredits: 100n,
      sourceType: 'payment',
      sourceId: paymentId,
    };

    // Counted, not assumed: the tenant may already hold a legitimate entry
    // from the test above, and "there are no lines" is only meaningful
    // against what was there before.
    const count = async (table: 'journal_lines' | 'audit_log') => {
      const rows = (await sql.unsafe(
        `select count(*)::int as n from accounting.${table} where tenant_id = $1::uuid`,
        [tenantId],
      )) as Array<{ n: number }>;
      return rows[0].n;
    };
    const linesBefore = await count('journal_lines');
    const auditBefore = await count('audit_log');

    await expect(
      withJournalTx((tx) => commitJournalForPayment(tx, ctx, unbalanced, paymentId)),
    ).rejects.toThrow(/unbalanced/);

    // The whole thing rolled back: no entry, no lines, no audit row. An
    // orphan entry with no lines is what a posting outside a transaction
    // leaves behind, and it is the thing this whole file exists to prevent.
    const entries = (await sql`
      select id from accounting.journal_entries
       where tenant_id = ${tenantId}::uuid and source_id = ${paymentId}::uuid
    `) as Array<{ id: string }>;
    expect(entries.length).toBe(0);

    expect(await count('journal_lines')).toBe(linesBefore);
    expect(await count('audit_log')).toBe(auditBefore);
  });

  it('really would leave an orphan without a transaction — so the two tests above are not vacuous', async () => {
    // This is the old behaviour, reproduced on purpose: the entry row is
    // written and committed on its own, and then the first line is written
    // and committed on its own. The deferred trigger fires at the end of the
    // SECOND statement, sees one line, and rejects the entry — leaving the
    // entry row behind with no lines at all.
    const paymentId = randomUUID();

    const entryRows = (await sql`
      insert into accounting.journal_entries
        (period_id, description, source_type, source_id, posted_by_user_id, tenant_id)
      values (${periodId}::uuid, 'orphan proof', 'payment', ${paymentId}::uuid,
              ${userId}::uuid, ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;
    const orphanId = entryRows[0].id;

    await expect(
      sql`
        insert into accounting.journal_lines
          (journal_id, account_id, debit_pence, credit_pence, tenant_id)
        values (${orphanId}::uuid, ${bankGlId}::uuid, 120, 0, ${tenantId}::uuid)
      `,
    ).rejects.toThrow(/unbalanced/);

    // The orphan: the entry is still there, and it has no lines.
    const orphans = (await sql`
      select id from accounting.journal_entries where id = ${orphanId}::uuid
    `) as Array<{ id: string }>;
    expect(orphans.length).toBe(1);

    const orphanLines = (await sql`
      select id from accounting.journal_lines where journal_id = ${orphanId}::uuid
    `) as Array<{ id: string }>;
    expect(orphanLines.length).toBe(0);
  });
});
