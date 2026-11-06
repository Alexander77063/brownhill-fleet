// tests/unit/accounting/bank-import-page.test.ts
//
// The bank-import page: what it answers when the URL carries rubbish.
//
// WHY THIS FILE EXISTS
// --------------------
// The page reads the bank account by id:
//
//     where ba.id = ${id}::uuid
//
// The id comes straight from the URL, so it is whatever the visitor typed.
// Postgres does not return "no such row" for `__missing_bankId__::uuid` —
// it refuses to cast the string at all, and the page answers 500.
//
// A 500 on a URL the operator mistyped is a support call. The page has
// exactly the right answer available: `notFound()`. The page ALREADY calls
// it, one line later, for an id that is a uuid but names no row. The only
// thing missing is the check that says "this is not an id at all".
//
// The same page is served in two consoles — /admin for the operator and
// /accounts for the accountant — and both read the id the same way, so both
// are covered here.
//
// The database is faked, and the fake is FAITHFUL about the one thing under
// test: postgres.js sends the parameters separately from the SQL, and a
// `::uuid` cast of a string that is not a uuid is an error raised by the
// DATABASE. A fake that returned an empty row set for every query would hide
// the very thing this file is about.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const TENANT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const BANK_ID = '55555555-5555-5555-5555-555555555555';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requirePermission = vi.fn<(perm: string) => Promise<unknown>>();
requirePermission.mockResolvedValue({
  userId: USER_ID,
  tenantId: TENANT_ID,
  role: 'tenant_admin',
  permissions: [],
  memberships: [],
});

vi.mock('@/lib/auth/context', () => ({
  requirePermission: (perm: string) => requirePermission(perm),
  requireTenantContext: () => requirePermission('tenant.context'),
  contextCan: () => true,
}));

const h = vi.hoisted(() => ({ dbReached: 0, queries: [] as string[] }));

vi.mock('@/lib/auth/local-store', () => ({
  localDb: async () => {
    h.dbReached += 1;
    // A postgres.js tagged template: the SQL and the parameters are separate,
    // and the cast happens in the database.
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(' ');
      h.queries.push(text);
      const castsToUuid = text.includes('::uuid');
      const bad = values.some(
        (v) => typeof v === 'string' && !UUID_RE.test(v),
      );
      if (castsToUuid && bad) {
        return Promise.reject(new Error('invalid input syntax for type uuid'));
      }
      return Promise.resolve([]);
    };
    return sql as unknown as Awaited<ReturnType<typeof import('@/lib/auth/local-store').localDb>>;
  },
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import AdminImportPage from '@/app/admin/accounting/banks/[id]/import/page';
import AccountsImportPage from '@/app/accounts/accounting/banks/[id]/import/page';

/** Call a page with a URL id. */
function render(page: (p: { params: Promise<{ id: string }> }) => Promise<unknown>, id: string) {
  return page({ params: Promise.resolve({ id }) });
}

describe('the bank-import page, when the URL carries rubbish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.dbReached = 0;
    h.queries = [];
    requirePermission.mockResolvedValue({
      userId: USER_ID,
      tenantId: TENANT_ID,
      role: 'tenant_admin',
      permissions: [],
      memberships: [],
    });
  });

  it('answers 404 for an id that is not a uuid — the operator console', async () => {
    await expect(render(AdminImportPage, '__missing_bankId__')).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
  });

  it('answers 404 for an id that is not a uuid — the finance console', async () => {
    await expect(render(AccountsImportPage, '__missing_bankId__')).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
  });

  it('does not put a rubbish id into the database', async () => {
    await expect(render(AdminImportPage, '__missing_bankId__')).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(h.dbReached).toBe(0);
  });

  it('still looks up a real id — the page is not simply refusing everything', async () => {
    await expect(render(AdminImportPage, BANK_ID)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(h.dbReached).toBe(1);
    expect(h.queries.join(' ')).toContain('bank_accounts');
  });
});
