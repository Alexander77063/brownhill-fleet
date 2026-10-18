import { PageHeader, Card, CardTitle, Table, Th, Td, EmptyState, Money } from '@/components/ui';
import { localDb } from '@/lib/auth/local-store';
import { requireTenantContext, contextCan } from '@/lib/auth/context';

export const dynamic = 'force-dynamic';

/**
 * /accounts/accounting/coa — chart of accounts viewer (read-only here;
 * writes are out of scope for this iteration). The reviewer flagged the
 * absence of this page from the original integration; landing a stub that
 * renders every account is the v1 follow-up the home tile was promising.
 *
 * Add/edit accounts is a v2 feature per spec §7. The seeded FRS 102 chart
 * (0065_accounting_coa_seed.sql) covers the 31 accounts a Brownhill
 * tenant needs to file P&L, balance sheet, cashflow, and the 9-box VAT.
 */
export default async function CoaPage() {
  const ctx = await requireTenantContext();
  // Reading the chart of accounts falls under billing.read.
  if (!contextCan(ctx, 'billing.read')) {
    return (
      <>
        <PageHeader eyebrow="Accounts · Accounting" title="Chart of accounts" />
        <Card>
          <p className="text-sm text-muted">
            You don&apos;t have the <code>billing.read</code> permission required to read the chart of accounts.
          </p>
        </Card>
      </>
    );
  }

  const sql = await localDb();
  const rows = (await sql`
    select id, code, name, type, normal_side, archived_at
      from accounting.chart_of_accounts
     order by code
  `) as Array<{
    id: string; code: string; name: string;
    type: string; normal_side: string; archived_at: string | null;
  }>;

  return (
    <>
      <PageHeader
        eyebrow="Accounts · Accounting"
        title="Chart of accounts"
        subtitle={`FRS 102 baseline (0065_accounting_coa_seed.sql) — ${rows.length} accounts. Read-only here; editing accounts is a v2 feature per spec §7.`}
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No accounts yet"
          hint="If the schema migrations ran (0064–0068) but no rows appear, the seed file may not have run. Run 0065_accounting_coa_seed.sql on the live database."
        />
      ) : (
        <Card>
          <Table caption="Chart of accounts">
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Normal side</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="font-mono">{r.code}</Td>
                  <Td className="text-cream">{r.name}</Td>
                  <Td>{r.type}</Td>
                  <Td>{r.normal_side}</Td>
                  <Td>
                    {r.archived_at
                      ? <span className="text-muted">archived</span>
                      : <span className="text-[var(--color-profit)]">active</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Card className="mt-4">
        <CardTitle>What the reports expect</CardTitle>
        <ul className="mt-3 space-y-2 text-sm text-muted">
          <li><span className="font-mono text-cream">1100 Trade Debtors</span> — AR aging bucket totals (amount owed vs. paid).</li>
          <li><span className="font-mono text-cream">2210 VAT Payable</span> — Box 1 / Box 5 output VAT due to HMRC.</li>
          <li><span className="font-mono text-cream">1200 Bank</span> — bank-rec clearing account (matched against `accounting.bank_accounts`).</li>
          <li><span className="font-mono text-cream">5910 Bank Charges</span> — bank-fee posting target.</li>
          <li><span className="font-mono text-cream">5000–5999 expenses</span> — P&L expense totals by code range.</li>
          <li><span className="font-mono text-cream">4000–4999 revenue</span> — P&L revenue totals by code range.</li>
        </ul>
      </Card>
    </>
  );
}