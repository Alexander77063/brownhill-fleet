// src/lib/accounting/chart-of-accounts.ts
// Resolving an account in the chart of accounts by its code — once, for
// everybody.
//
// WHY THIS EXISTS
// ---------------
// Six places in the product asked the database for an account by code, each
// with its own SQL and its own idea of what to do when the account was not
// there:
//
//   const rows = await sql`select id from accounting.chart_of_accounts where code = '2210'`;
//   const id = rows[0].id;
//
// Two things were wrong with that shape, and both of them bit.
//
// 1. IT CRASHED WITHOUT SAYING WHY. `[0].id` on an empty array is a
//    `TypeError: Cannot read properties of undefined (reading 'id')` — no
//    account code, no table, no hint. The MTD VAT submission did exactly
//    this against code '2200' (VAT Output), an account no migration ever
//    seeded, so a return HMRC had already accepted died with that message
//    and never reached the ledger.
//
// 2. IT COULD PICK THE WRONG ROW. Migration 0069 made the accounting tables
//    per-tenant: `unique (tenant_id, code)`, with the global rows carrying
//    `tenant_id IS NULL`. A lookup by code alone therefore matches a
//    tenant's own account AND the global one, and `[0]` takes whichever the
//    planner happened to produce first.
//
// This module does the lookup once. It prefers the tenant's own account over
// the global one, names the code as a PARAMETER rather than splicing it into
// the query, and a missing account raises a typed error that names the code.
//
// TENANT SCOPE
// ------------
// `accounting.chart_of_accounts` is global reference data with an optional
// per-tenant override — see migration 0081's header and migration 0083,
// which restores the global uniqueness that 0069 dropped. The application
// connects as a superuser, which bypasses row-level security, so the tenant
// is named in the SQL here.

import type { ISql } from 'postgres';

/** A row of `accounting.chart_of_accounts`. */
export interface CoaAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  normal_balance: string;
}

/**
 * The account a code names, or null when it names none.
 *
 * `tenantId` narrows the lookup to the tenant's own account when it has one;
 * the global account is the fallback. With no tenant, only the global
 * account is considered.
 */
export async function findAccount(
  sql: ISql,
  code: string,
  tenantId?: string | null,
): Promise<CoaAccount | null> {
  const rows = (await sql`
    select id, code, name, type::text as type, normal_balance::text as normal_balance
      from accounting.chart_of_accounts
     where code = ${code}
       and (tenant_id is null or tenant_id = ${tenantId ?? null}::uuid)
     order by tenant_id nulls last
     limit 1
  `) as Array<CoaAccount>;
  return rows[0] ?? null;
}

/**
 * The id of the account a code names, or null when it names none.
 *
 * For a caller that has its own way of reporting a missing account — the API
 * routes answer the operator with a 500 and a readable message.
 */
export async function findAccountId(
  sql: ISql,
  code: string,
  tenantId?: string | null,
): Promise<string | null> {
  const account = await findAccount(sql, code, tenantId);
  return account ? account.id : null;
}

/**
 * The id of the account a code names.
 *
 * Throws `MissingChartOfAccountsError` when it names none. Use this where a
 * missing account must stop the operation rather than be reported: a ledger
 * posting has no correct behaviour without the account it posts to.
 */
export async function requireAccountId(
  sql: ISql,
  code: string,
  tenantId?: string | null,
): Promise<string> {
  const account = await findAccount(sql, code, tenantId);
  if (!account) throw new MissingChartOfAccountsError(code, tenantId);
  return account.id;
}

/**
 * The chart of accounts does not contain the account a posting needs.
 *
 * A named error rather than a `TypeError`, because the difference matters to
 * whoever reads the log: "no account with code 2200" says the seed is
 * incomplete, which is a different problem from "something was undefined".
 */
export class MissingChartOfAccountsError extends Error {
  constructor(
    readonly code: string,
    readonly tenantId?: string | null,
  ) {
    super(
      `Chart of accounts: no account with code ${code}` +
        (tenantId ? ` for tenant ${tenantId}` : '') +
        '. The accounting seed is incomplete — the migrations that create the ' +
        'chart of accounts have not all been applied.',
    );
    this.name = 'MissingChartOfAccountsError';
  }
}
