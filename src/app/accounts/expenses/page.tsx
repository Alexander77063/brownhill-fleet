import { PageHeader, Card, CardTitle, Money, Table, Th, Td, EmptyState } from '@/components/ui';
import { formatDate } from '@/lib/display';
import { requireTenantContext, contextCan } from '@/lib/auth/context';
import { expenseSummaryByCategory, listExpenses } from '@/lib/expenses';

export const dynamic = 'force-dynamic';

export default async function AccountsExpensesPage() {
  const ctx = await requireTenantContext();
  const canRead = contextCan(ctx, 'billing.read');
  if (!canRead) {
    return (
      <>
        <PageHeader eyebrow="Accounts" title="Expenses" />
        <Card>
          <p className="text-sm text-muted">
            You don&apos;t have permission to read expenses. Ask the ops admin to grant
            you <code>billing.read</code>.
          </p>
        </Card>
      </>
    );
  }
  const [summary, recent] = await Promise.all([
    expenseSummaryByCategory(ctx.tenantId),
    listExpenses(ctx.tenantId, 50),
  ]);
  const total = summary.reduce((s, c) => s + c.total_pence, 0);
  return (
    <>
      <PageHeader
        eyebrow="Accounts · Expenses"
        title="Expenses"
        subtitle="Per-category totals + the 50 most recent expense rows. Recording & editing live at /ops/expenses."
      />
      <Card>
        <CardTitle>By category</CardTitle>
        {summary.length === 0 ? (
          <EmptyState title="No expenses yet" />
        ) : (
          <Table caption="Expenses by category">
            <thead>
              <tr><Th>Category</Th><Th className="text-right">Total</Th></tr>
            </thead>
            <tbody>
              {summary.map((c) => (
                <tr key={c.category}>
                  <Td className="text-cream">{c.category}</Td>
                  <Td className="text-right font-mono"><Money pence={c.total_pence} /></Td>
                </tr>
              ))}
              <tr>
                <Td className="font-display text-cream">Total</Td>
                <Td className="text-right font-display font-mono"><Money pence={total} /></Td>
              </tr>
            </tbody>
          </Table>
        )}
      </Card>
      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">Recent</h2>
        {recent.length === 0 ? (
          <EmptyState title="Nothing recorded yet" />
        ) : (
          <Table caption="Recent expenses">
            <thead>
              <tr><Th>Date</Th><Th>Category</Th><Th>Reference</Th><Th>Description</Th><Th className="text-right">Amount</Th></tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.id}>
                  <Td>{formatDate(e.incurred_on)}</Td>
                  <Td>{e.category ?? '—'}</Td>
                  <Td className="font-mono text-xs">{e.reference}</Td>
                  <Td className="text-cream">{e.description ?? '—'}</Td>
                  <Td className="text-right font-mono"><Money pence={e.amount_pence ?? 0} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}