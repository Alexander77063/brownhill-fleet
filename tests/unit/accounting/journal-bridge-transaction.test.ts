// tests/unit/accounting/journal-bridge-transaction.test.ts
//
// The ledger's atomicity, as a contract.
//
// WHY THIS TEST EXISTS
// --------------------
// `accounting.journal_lines` carries a deferred balance trigger:
//
//   create constraint trigger trg_journal_lines_balanced
//     after insert or update on accounting.journal_lines
//     deferrable initially deferred
//     for each row execute function accounting.journal_balanced();
//
// Deferred on purpose: the check has to run once every line of an entry is
// present, not after the first one. Which means it runs at the COMMIT of the
// enclosing transaction — and ONLY then is it meaningful.
//
// The bridge used to write its entry, its lines and its audit-log row as
// three separate autocommitted statements on a pooled connection. So the
// trigger fired at the end of EACH line insert, seeing one line at a time.
//
// Measured against a real postgres: inserting the first line of a two-line
// entry that way fails with
//
//   ERROR: journal <id> unbalanced: debits=120 credits=0
//
// and the journal_entries row — committed before the lines were attempted —
// stays behind as an orphan with no lines. The same writes inside one
// transaction commit cleanly.
//
// Three call sites took that path: the reconciliation queue's "mark as a VAT
// payment" and "mark as a bank fee" actions, and the MTD VAT submission. The
// first two are the operator's most-used buttons on the reconciliation screen
// and both of them failed.
//
// WHAT THIS TEST PROVES
// ----------------------
//   1. `withJournalTx` opens ONE transaction and the work inside it happens
//      inside that transaction.
//   2. When the work throws, the transaction is rolled back and the error
//      reaches the caller. A half-written entry must not survive.
//   3. Every commit function writes through the transaction handle it is
//      given, and never opens a transaction of its own.
//
// The third is the one that matters for the future: the commit functions
// TAKE a transaction handle as their first argument, so a call site that
// forgets one does not compile. `pnpm typecheck` is the enforcement; this
// test is the proof that the argument is used rather than ignored.
//
// It needs no database. The connection is a fake that records the SQL it is
// asked to run and the transactions opened against it — so the thing under
// test is the bridge's transaction discipline, not Postgres. The fake stands
// in for `localDb()`, which is the only way the bridge reaches a database.

import { describe, expect, it, vi } from 'vitest';
import type { ISql } from 'postgres';
import {
  commitJournalForBankTransaction,
  commitJournalForInvoice,
  commitJournalForPayment,
  commitJournalForVatSubmission,
  withJournalTx,
} from '@/lib/accounting/journal-bridge';
import { postVatPaymentJournal } from '@/lib/accounting/journal';

// The bridge reaches the database through `localDb()`. The fake connection is
// handed to it through this box; `vi.hoisted` lifts the box above the mock
// factory, which vitest hoists above the imports.
const db = vi.hoisted(() => ({ pool: null as unknown }));

vi.mock('@/lib/auth/local-store', () => ({
  localDb: async () => db.pool,
}));

type Row = Record<string, unknown>;

interface Fake {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  /** Every SQL statement, in order, across the pool and its transactions. */
  calls: string[];
  /** How many transactions were opened. */
  begun: number;
  /** Set when a transaction's work threw. */
  rolledBack: boolean;
  begin(fn: (tx: Fake) => Promise<unknown>): Promise<unknown>;
}

/**
 * A stand-in for a postgres.js connection.
 *
 * It answers the bridge's queries from a small table, so the bridge's own
 * logic runs for real — the same queries, in the same order, against the same
 * shape of answers. What it adds is the bookkeeping a real connection cannot
 * show us from the outside: which statements ran, and inside how many
 * transactions.
 */
function fakeConnection(rowsFor: (sqlText: string) => Row[], sharedCalls?: string[]): Fake {
  // The statement log is shared by construction, not by property assignment:
  // the callable closes over this array, so a transaction has to be handed
  // the SAME array to end up in the same log.
  const calls = sharedCalls ?? [];
  const pool = ((strings: TemplateStringsArray) => {
    const text = strings.join(' ? ');
    calls.push(text);
    return Promise.resolve(rowsFor(text));
  }) as unknown as Fake;

  pool.calls = calls;
  pool.begun = 0;
  pool.rolledBack = false;

  pool.begin = async (fn: (tx: Fake) => Promise<unknown>) => {
    pool.begun += 1;
    // The transaction shares the pool's statement log: the point of the test
    // is WHICH statements ran, and in which transaction.
    const tx = fakeConnection(rowsFor, calls);
    try {
      return await fn(tx);
    } catch (err) {
      pool.rolledBack = true;
      throw err;
    }
  };

  return pool;
}

/** The answers the bridge needs to get through a posting. */
function bridgeRows(sqlText: string): Row[] {
  if (sqlText.includes('select closed_at, locked_at')) return [];
  if (sqlText.includes('insert into accounting.periods')) return [{ id: 'period-1' }];
  if (sqlText.includes('select id from accounting.journal_entries')) return [];
  if (sqlText.includes('insert into accounting.journal_entries')) return [{ id: 'journal-1' }];
  if (sqlText.includes('insert into accounting.journal_lines')) return [{ id: 'line-1' }];
  if (sqlText.includes('insert into accounting.audit_log')) return [{ id: 'audit-1' }];
  if (sqlText.includes('update accounting.bank_transactions')) return [];
  if (sqlText.includes('update accounting.vat_submissions')) return [];
  if (sqlText.includes('update public.invoices')) return [];
  if (sqlText.includes('update public.payments')) return [];
  return [];
}

const CTX = { userId: '11111111-1111-1111-1111-111111111111', tenantId: '22222222-2222-2222-2222-222222222222' };

/** The shape a VAT payment posts — one of the reconciliation queue's buttons. */
function vatPaymentResult(bankTxId: string) {
  return postVatPaymentJournal({
    bankTxId,
    amount: 120n,
    vatPayableAccountId: 'acct-vat-payable',
    bankGlAccountId: 'acct-bank',
  });
}

describe('the journal bridge and its transaction', () => {
  it('opens exactly one transaction and does the work inside it', async () => {
    const pool = fakeConnection(bridgeRows);
    db.pool = pool;

    const journalId = await withJournalTx(async (tx) =>
      commitJournalForBankTransaction(tx, CTX, vatPaymentResult('bank-1'), 'bank-1'),
    );

    expect(journalId).toBe('journal-1');
    expect(pool.begun).toBe(1);

    // Every write the posting makes happened inside the transaction — the
    // entry, its lines and its audit-log row.
    const writes = pool.calls.filter((c) => /insert into accounting\./.test(c));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((c) => c.includes('insert into accounting.journal_entries'))).toBe(true);
    expect(writes.some((c) => c.includes('insert into accounting.journal_lines'))).toBe(true);
    expect(writes.some((c) => c.includes('insert into accounting.audit_log'))).toBe(true);
  });

  it('rolls the transaction back when the work throws, and rethrows', async () => {
    const pool = fakeConnection(bridgeRows);
    db.pool = pool;

    await expect(
      withJournalTx(async () => {
        throw new Error('the ledger refused this posting');
      }),
    ).rejects.toThrow('the ledger refused this posting');

    expect(pool.begun).toBe(1);
    expect(pool.rolledBack).toBe(true);
  });

  it('never opens a transaction of its own — it writes through the handle it is given', async () => {
    // The handle is a transaction that is already open. If the commit
    // function tried to open another one it would be nesting inside it.
    const pool = fakeConnection(bridgeRows);
    const tx = fakeConnection(bridgeRows, pool.calls);

    await commitJournalForBankTransaction(
      tx as unknown as ISql,
      CTX,
      vatPaymentResult('bank-2'),
      'bank-2',
    );

    expect(tx.begun).toBe(0);
    expect(pool.begun).toBe(0);
  });

  it('writes every kind of posting through the handle it is given', async () => {
    // Four rules, four commit functions, one contract: the caller owns the
    // transaction. A commit function that opened its own would write outside
    // the caller's transaction, and the caller's other writes would commit
    // separately — which is the failure this whole file is about.
    const pool = fakeConnection(bridgeRows);
    const tx = fakeConnection(bridgeRows, pool.calls);

    const bank = vatPaymentResult('bank-3');
    const invoice = {
      lines: [
        { accountId: 'acct-ar', debitPence: 120n, creditPence: 0n },
        { accountId: 'acct-sales', debitPence: 0n, creditPence: 120n },
      ],
      sumDebits: 120n,
      sumCredits: 120n,
      sourceType: 'invoice' as const,
      sourceId: 'inv-1',
    };
    const payment = {
      lines: [
        { accountId: 'acct-bank', debitPence: 120n, creditPence: 0n },
        { accountId: 'acct-ar', debitPence: 0n, creditPence: 120n },
      ],
      sumDebits: 120n,
      sumCredits: 120n,
      sourceType: 'payment' as const,
      sourceId: 'pay-1',
    };
    const vat = {
      lines: [
        { accountId: 'acct-vat-output', debitPence: 120n, creditPence: 0n },
        { accountId: 'acct-vat-payable', debitPence: 0n, creditPence: 120n },
      ],
      sumDebits: 120n,
      sumCredits: 120n,
      sourceType: 'vat_submission' as const,
      sourceId: 'sub-1',
    };

    const handle = tx as unknown as ISql;
    await commitJournalForInvoice(handle, CTX, invoice, 'inv-1');
    await commitJournalForPayment(handle, CTX, payment, 'pay-1');
    await commitJournalForVatSubmission(handle, CTX, vat, 'sub-1');
    await commitJournalForBankTransaction(handle, CTX, bank, 'bank-3');

    expect(tx.begun).toBe(0);
    expect(pool.begun).toBe(0);
    expect(pool.calls.filter((c) => c.includes('insert into accounting.journal_entries')).length).toBe(4);
  });
});
