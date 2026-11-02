// src/lib/accounting/invoice-shared.ts
// The parts of the invoice register that BOTH the server and the browser may
// use: the shapes, and the money formatting.
//
// WHY THIS IS A SEPARATE FILE
// --------------------------
// The Void control on the register is a client component — it opens a dialog,
// posts to the API and refreshes the page. It needs one thing from the
// register module: a way to print £1,234.56.
//
// But `./invoice-register.ts` is the module that RUNS THE QUERIES, and running
// the queries means opening the application's direct Postgres connection,
// which lives behind `import 'server-only'` (via `@/lib/auth/local-store`).
// So the client component importing the formatter from there pulled a
// server-only module into the browser bundle, and the production build
// refused it:
//
//     You're importing a component that needs "server-only". That only works
//     in a Server Component which is not supported in the pages/ directory.
//
// The failure was found by the DOCKER build, not by the test suite: the
// vitest run was green, `pnpm typecheck` was green, and the production build
// failed. That is what this split is for — the formatter and the shapes have
// no server dependency, so they can live in a module the browser may import,
// and the module that talks to the database stays server-side where it
// belongs.
//
// The rule this file exists to keep: **a module the browser may import must
// not import anything that reaches the database.** There is no lint rule for
// it in this project, so the separation is enforced by the build — which is
// why the build is the thing that has to keep running.

/** The statuses an invoice can be in. */
export type InvoiceStatus = 'open' | 'paid' | 'part_paid' | 'void' | 'overdue';

export interface InvoiceRegisterRow {
  id: string;
  number: string | null;
  /** 'YYYY-MM-DD'. */
  issued_on: string;
  /** 'YYYY-MM-DD'. */
  due_on: string;
  gross_pence: string;
  net_pence: string;
  vat_pence: string;
  /** 'open' | 'paid' | 'part_paid' | 'void' | 'overdue'. */
  status: string;
  customer_name: string | null;
  vehicle_registration: string | null;
  /** What has been received against it, from CONFIRMED payments only. */
  allocated_pence: string;
  /** The journal entry that posted it. Null when it was never posted. */
  posted_journal_id: string | null;
}

/**
 * £1,234.56 — pence in, pounds out.
 *
 * A bigint-safe formatter. `formatGBP` takes a JavaScript number, which is
 * the wrong type for money that is stored as a bigint: passing the string
 * through `Number()` would round anything above 2^53 pence, and passing the
 * number straight in would lose the fraction.
 */
export function formatPence(pence: string | bigint): string {
  const n = typeof pence === 'bigint' ? pence : BigInt(pence || '0');
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return `${sign}£${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** What is still owed on an invoice. Never negative. */
export function outstandingPence(row: InvoiceRegisterRow): bigint {
  const outstanding = BigInt(row.gross_pence) - BigInt(row.allocated_pence);
  return outstanding > 0n ? outstanding : 0n;
}
