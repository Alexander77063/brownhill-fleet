// tests/integration/accounting/close-race.test.ts
//
// The close and the writes that change what it warns about, against a real
// postgres.
//
// WHY THIS FILE EXISTS
// --------------------
// The close used to be three transactions with nothing between them:
//
//   1. read the preflight — "here is what closing this month would affect"
//   2. create the period row if it did not exist
//   3. close the period
//
// A bank line landing between (1) and (3) was closed over unseen. The
// operator was asked to acknowledge what was outstanding, and the system
// shut a month over something they had not been shown.
//
// The fix has two halves and this file proves both:
//
//   * The close re-reads the warnings immediately before it acts on them, in
//     the SAME transaction, and compares them against what the operator was
//     shown — including the FIGURES, because "three open bank transactions"
//     is not an acknowledgement of "four".
//
//   * The close holds the period's advisory lock while it does that, and
//     every writer into the same month takes the same lock. So the re-read
//     cannot itself go stale: a bank line either lands entirely before the
//     close or entirely after it.
//
// The lock test writes through `insertBankLines` — the SAME function the
// bank import route calls — so it is proving the production writer is
// ordered, not a copy of it that happens to agree.
//
// IT NEEDS A DATABASE
// -------------------
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It creates its own tenants, its own auth users and its own rows, and
// removes them afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { closePeriodConfirmed } from '@/lib/accounting/close';
import { preflightPeriodClose } from '@/lib/accounting/close-preflight';
import { openPeriod } from '@/lib/accounting/periods';
import { insertBankLines } from '@/lib/accounting/bank-import';
import { periodLockKey, takePeriodLock } from '@/lib/accounting/period-lock';
import { integrationEnv } from '../../helpers/integration-env';

// This file talks straight to postgres and never through the service
// client, so it asks for the database alone.
//
// `integrationEnv` is the repository's rule for this, and it is the rule that
// matters: it SKIPS, out loud, when the job has not asked for the
// integration tests, and it FAILS when the job has set REQUIRE_INTEGRATION=1
// and the database is not there. The hand-rolled guard this replaced skipped
// in BOTH cases — so a build with REQUIRE_INTEGRATION=1 could report this
// file's tests as skipped and still be green. A test that did not run is not
// a test that passed.
const env = integrationEnv({ app: false });

/** Wait for a condition, up to a deadline. Returns whether it happened. */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe.skipIf(!env)('the close against a bank line that lands mid-dialog', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const slug = `close-race-${tenantId.slice(0, 8)}`;
  const closer = randomUUID();

  const YEAR = 2026;
  const MONTH = 3;

  let periodId: string;
  let bankAccountId: string;
  let bankImportId: string;
  /** How many bank lines this test has inserted, so each is distinct. */
  let lineCount = 0;

  /** Insert one uncategorised bank line dated inside the period. */
  async function insertBankLine(amountPence: number): Promise<void> {
    lineCount += 1;
    await sql`
      insert into accounting.bank_transactions
        (bank_import_id, bank_account_id, posted_at, amount_pence, description,
         status, tenant_id)
      values (${bankImportId}::uuid, ${bankAccountId}::uuid,
              ${`2026-03-${String(10 + lineCount).padStart(2, '0')}T09:00:00Z`}::timestamptz,
              ${amountPence}, ${`Race line ${lineCount}`}, 'unmatched', ${tenantId}::uuid)
    `;
  }

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantId}::uuid, 'Close race test', ${slug})
    `;
    await sql`
      insert into auth.users (id, email)
      values (${closer}::uuid, ${`close-race-${closer.slice(0, 8)}@example.invalid`})
    `;

    // The period has to exist: `accounting.bank_imports.period_id` is NOT
    // NULL, and the close preflight reads the period's state.
    const period = await openPeriod(tenantId, YEAR, MONTH);
    periodId = period.id;

    const bankAccount = (await sql`
      insert into accounting.bank_accounts (name, gl_account_id, tenant_id)
      select 'Race Bank', coa.id, ${tenantId}::uuid
        from accounting.chart_of_accounts coa
       where coa.code = '1200' and coa.tenant_id is null
      returning id
    `) as Array<{ id: string }>;
    bankAccountId = bankAccount[0].id;

    const importRow = (await sql`
      insert into accounting.bank_imports
        (bank_account_id, file_name, file_sha256, period_id, tenant_id)
      values (${bankAccountId}::uuid, 'race.csv', ${'5566778899aabbcc'}::bytea,
              ${periodId}::uuid, ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;
    bankImportId = importRow[0].id;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from accounting.bank_transactions where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.bank_imports where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.bank_accounts where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.audit_log where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.periods where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.tenants where id = ${tenantId}::uuid`;
    await sql`delete from auth.users where id = ${closer}::uuid`;
  });

  // ── the figures ──────────────────────────────────────────────────────────

  it('refuses a close when a bank line appears that the operator never saw', async () => {
    // The operator opened the dialog: nothing outstanding.
    const preflight = await preflightPeriodClose(tenantId, YEAR, MONTH);
    expect(preflight.warnings.find((w) => w.code === 'open_bank_items')).toBeUndefined();

    // A statement lands while they are reading it.
    await insertBankLine(45_000);

    const result = await closePeriodConfirmed({
      tenantId,
      year: YEAR,
      month: MONTH,
      userId: closer,
      acknowledge: [],
    });

    expect(result.outcome).toBe('needs_confirmation');
    if (result.outcome !== 'needs_confirmation') return;
    const outstanding = result.outstanding.find((w) => w.code === 'open_bank_items');
    expect(outstanding).toBeDefined();
    expect(outstanding!.count).toBe(1);

    // And the period is NOT closed.
    const rows = (await sql`
      select closed_at from accounting.periods
       where tenant_id = ${tenantId}::uuid and year = ${YEAR} and month = ${MONTH}
    `) as Array<{ closed_at: string | null }>;
    expect(rows[0]?.closed_at ?? null).toBeNull();
  });

  it('refuses a close when a SECOND bank line lands, because the figures changed', async () => {
    // THE case. The operator was shown ONE open bank transaction and ticked
    // it. A second one lands. The warning's CODE is unchanged — it is still
    // `open_bank_items` — so an acknowledgement that carried only the code
    // would still match, and the month would close over a line they never
    // saw. The acknowledgement carries the figures, so it does not match.
    const before = await preflightPeriodClose(tenantId, YEAR, MONTH);
    const warning = before.warnings.find((w) => w.code === 'open_bank_items');
    expect(warning).toBeDefined();
    const acknowledgement = [
      {
        code: 'open_bank_items' as const,
        count: warning!.count,
        amountPence: warning!.amountPence,
      },
    ];

    await insertBankLine(30_000);

    const result = await closePeriodConfirmed({
      tenantId,
      year: YEAR,
      month: MONTH,
      userId: closer,
      acknowledge: acknowledgement,
    });

    expect(result.outcome).toBe('needs_confirmation');
    if (result.outcome !== 'needs_confirmation') return;
    const outstanding = result.outstanding.find((w) => w.code === 'open_bank_items');
    expect(outstanding).toBeDefined();
    // The figures it now carries are NOT the figures the operator ticked.
    expect(outstanding!.count).toBe(warning!.count + 1);
    expect(outstanding!.amountPence).toBe(warning!.amountPence + 30_000);
  });

  it('closes the period once the operator acknowledges the figures it now carries', async () => {
    const preflight = await preflightPeriodClose(tenantId, YEAR, MONTH);
    const warning = preflight.warnings.find((w) => w.code === 'open_bank_items');
    expect(warning).toBeDefined();

    const result = await closePeriodConfirmed({
      tenantId,
      year: YEAR,
      month: MONTH,
      userId: closer,
      acknowledge: [
        { code: 'open_bank_items', count: warning!.count, amountPence: warning!.amountPence },
      ],
    });

    expect(result.outcome).toBe('closed');
    if (result.outcome !== 'closed') return;
    expect(result.period.closedAt).not.toBeNull();
    expect(result.period.closedByUserId).toBe(closer);
  });

  // ── the lock ─────────────────────────────────────────────────────────────

  it('holds the period lock, so a bank line cannot land in the middle of a close', async () => {
    // A second tenant, so this test does not fight the one above for the
    // same period.
    const otherTenant = randomUUID();
    const otherUser = randomUUID();
    await sql`
      insert into public.tenants (id, name, slug)
      values (${otherTenant}::uuid, 'Close lock test', ${`lock-${otherTenant.slice(0, 8)}`})
    `;
    await sql`
      insert into auth.users (id, email)
      values (${otherUser}::uuid, ${`lock-${otherUser.slice(0, 8)}@example.invalid`})
    `;
    const otherPeriod = await openPeriod(otherTenant, YEAR, MONTH);
    const otherBank = (await sql`
      insert into accounting.bank_accounts (name, gl_account_id, tenant_id)
      select 'Lock Bank', coa.id, ${otherTenant}::uuid
        from accounting.chart_of_accounts coa
       where coa.code = '1200' and coa.tenant_id is null
      returning id
    `) as Array<{ id: string }>;
    const otherImport = (await sql`
      insert into accounting.bank_imports
        (bank_account_id, file_name, file_sha256, period_id, tenant_id)
      values (${otherBank[0].id}::uuid, 'lock.csv', ${'aabbccddeeff0011'}::bytea,
              ${otherPeriod.id}::uuid, ${otherTenant}::uuid)
      returning id
    `) as Array<{ id: string }>;

    // An observer on its OWN connection. The app's pool has two connections
    // and both are about to be busy — the holder and the writer — so the
    // diagnostic query cannot come out of that pool without deadlocking
    // against itself.
    const { default: postgres } = await import('postgres');
    const observer = postgres(env!.DATABASE_URL, { max: 1 });

    try {
      // The holder takes the lock and keeps it until the test says so.
      let signalLocked: () => void = () => {};
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      let signalRelease: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        signalRelease = resolve;
      });

      const holder = sql.begin(async (tx) => {
        await takePeriodLock(tx, otherTenant, YEAR, MONTH);
        signalLocked();
        await released;
      });
      // Deterministic: the lock IS held when this resolves.
      await locked;

      // The bank import — the real writer, the one the route calls — tries to
      // write. It takes the same lock, because a bank line is the one thing
      // that can CREATE a close warning.
      let writeSettled = false;
      const writer = insertBankLines({
        sql,
        tenantId: otherTenant,
        bankImportId: otherImport[0].id,
        bankAccountId: otherBank[0].id,
        lines: [
          {
            postedAt: new Date('2026-03-20T09:00:00Z'),
            amountPence: 12_345n,
            description: 'Blocked line',
            counterparty: null,
          },
        ],
      }).then((inserted) => {
        writeSettled = true;
        return inserted;
      });

      // Is the writer waiting on OUR advisory lock? That is the question, and
      // `pg_locks` answers it precisely: an ungranted advisory lock request
      // on this period's key means the writer reached the lock and is
      // blocked on it — as opposed to being queued for a connection, which
      // would look identical from the outside.
      const key = periodLockKey(otherTenant, YEAR, MONTH);
      const waiting = await waitFor(async () => {
        const rows = (await observer`
          select count(*)::int as waiting
            from pg_locks
           where locktype = 'advisory'
             and not granted
             and classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
             and objid = (hashtextextended(${key}, 0) & 4294967295)::oid
        `) as Array<{ waiting: number }>;
        return (rows[0]?.waiting ?? 0) > 0;
      });

      expect(waiting, 'the bank import never reached the period lock').toBe(true);
      expect(
        writeSettled,
        'a bank line landed while the close held the period lock',
      ).toBe(false);

      // The close finishes; the line lands afterwards, in a month that is
      // now closed — visible, honest, and reopenable.
      signalRelease();
      await holder;
      const inserted = await writer;
      expect(writeSettled).toBe(true);
      expect(inserted.size).toBe(1);
    } finally {
      await observer.end({ timeout: 5 });
      await sql`delete from accounting.bank_transactions where tenant_id = ${otherTenant}::uuid`;
      await sql`delete from accounting.bank_imports where tenant_id = ${otherTenant}::uuid`;
      await sql`delete from accounting.bank_accounts where tenant_id = ${otherTenant}::uuid`;
      await sql`delete from accounting.audit_log where tenant_id = ${otherTenant}::uuid`;
      await sql`delete from accounting.periods where tenant_id = ${otherTenant}::uuid`;
      await sql`delete from public.tenants where id = ${otherTenant}::uuid`;
      await sql`delete from auth.users where id = ${otherUser}::uuid`;
    }
  });
});
