// src/lib/accounting/bank-import.ts
//
// Writing a bank statement's lines into the ledger.
//
// WHY THIS IS A MODULE AND NOT ROUTE CODE
// ----------------------------------------
// A bank line is the ONE thing in the product that can CREATE a close
// warning: the row lands with status 'unmatched', and the close preflight
// counts unmatched lines dated in the month. So an import that lands in the
// middle of somebody's close would close a month over a line the operator
// never saw — which is the whole thing the close's confirmation exists to
// prevent.
//
// The close and this write therefore have to be ORDERED. That ordering is a
// per-(tenant, period) advisory lock, and the lock only orders anything if
// it is held in the SAME transaction as the inserts. A lock taken on a
// pooled connection outside a transaction is released at the end of that
// statement, and orders nothing.
//
// Which means the transaction cannot belong to the caller: a caller who
// opens the transaction and forgets the lock has written a statement that is
// not ordered against the close, and nothing about that is visible in
// review — it is a silent hole in a guarantee.
//
// So this module owns the transaction. There is one way in, and it is
// ordered.
//
// WHY THE MONTHS COME FROM `posted_at`
// ------------------------------------
// A bank line posts into the month the BANK posted it, so the month that
// matters is `posted_at`, read in UTC — the same clock the preflight counts
// on. `bank_imports.period_id` is a different thing: it is the tenant's most
// recent OPEN period, which is where the file is filed, and it has nothing
// to do with which month a line belongs to. Locking the wrong month orders
// nothing.
//
// WHY THE IDS ARE KEPT AGAINST THE LINE INDEX
// --------------------------------------------
// A re-upload that skips a duplicate would otherwise shift every later id by
// one, and the auto-matcher would attach a match to the wrong bank line.
// So the id is keyed on the index of the line in the input, not appended to
// a list.

import type { Sql } from 'postgres';
import { takePeriodLocks } from './period-lock';

/** One line of a bank statement, as the parser produced it. */
export interface BankLineInput {
  postedAt: Date;
  /** Signed: debits are negative. */
  amountPence: bigint;
  description: string;
  counterparty: string | null;
}

/**
 * The ids of the lines that were actually inserted, keyed by their index in
 * `lines`.
 *
 * A line that was already there (the unique constraint on
 * (bank_import_id, posted_at, amount_pence, description, counterparty) makes
 * a re-upload a no-op) is simply absent from the map. The caller uses the
 * map to decide which lines to auto-match, and a duplicate line must not be
 * matched a second time.
 */
export type InsertedBankLines = Map<number, string>;

/**
 * Insert a statement's lines, ordered against the close.
 *
 * The caller gets the transaction and the lock as one thing: it cannot
 * write a bank line that is not ordered against the close of the month that
 * line belongs to.
 *
 * `sql` is the pool — this function opens its own transaction, because the
 * lock and the inserts have to share one, and because a caller-supplied
 * transaction is a caller-supplied chance to forget the lock.
 */
export async function insertBankLines(args: {
  sql: Sql;
  tenantId: string;
  bankImportId: string;
  bankAccountId: string;
  lines: ReadonlyArray<BankLineInput>;
}): Promise<InsertedBankLines> {
  const { sql, tenantId, bankImportId, bankAccountId, lines } = args;

  // The months this statement touches, in UTC. A statement that spans two
  // months touches both, and both are locked.
  const monthsTouched = new Map<string, { year: number; month: number }>();
  for (const line of lines) {
    const year = line.postedAt.getUTCFullYear();
    const month = line.postedAt.getUTCMonth() + 1;
    const key = `${year}:${month}`;
    if (!monthsTouched.has(key)) monthsTouched.set(key, { year, month });
  }

  const insertedByIndex: InsertedBankLines = new Map<number, string>();

  await (sql.begin(async (tx) => {
    // THE LOCK, FIRST. Everything below is ordered against the close of
    // every month this statement touches.
    await takePeriodLocks(tx, tenantId, [...monthsTouched.values()]);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const rows = (await tx`
        insert into accounting.bank_transactions
          (bank_import_id, bank_account_id, posted_at, amount_pence,
           description, counterparty, tenant_id)
        values (
          ${bankImportId}::uuid,
          ${bankAccountId}::uuid,
          ${line.postedAt.toISOString()},
          ${line.amountPence.toString()}::bigint,
          ${line.description},
          ${line.counterparty},
          ${tenantId}::uuid
        )
        on conflict (bank_import_id, posted_at, amount_pence, description, counterparty)
        do nothing
        returning id
      `) as Array<{ id: string }>;
      if (rows.length) insertedByIndex.set(i, rows[0].id);
    }
  }) as unknown as Promise<void>);

  return insertedByIndex;
}
