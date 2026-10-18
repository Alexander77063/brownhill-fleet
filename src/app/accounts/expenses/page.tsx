import { PageHeader, Card, CardTitle, Money, Table, Th, Td, EmptyState, Button } from '@/components/ui';
import { formatDate } from '@/lib/display';
import { requireTenantContext, contextCan } from '@/lib/auth/context';
import { expenseSummaryByCategory, listExpenses, listCategories, listVehicleOptions } from '@/lib/expenses';
import { recordExpenseAction } from '@/lib/actions/expenses';

// <form action={...}> requires void. recordExpenseAction returns a structured
// result for useFormState; the wrapper throws away the result so the form's
// action prop is well-typed.
async function submitExpense(fd: FormData): Promise<void> {
  await recordExpenseAction(fd);
}

export const dynamic = 'force-dynamic';

export default async function AccountsExpensesPage() {
  const ctx = await requireTenantContext();
  const canRead = contextCan(ctx, 'billing.read');
  const canWrite = contextCan(ctx, 'billing.write');
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

  const [summary, recent, categories, vehicles] = await Promise.all([
    expenseSummaryByCategory(ctx.tenantId),
    listExpenses(ctx.tenantId),
    canWrite ? listCategories(ctx.tenantId) : Promise.resolve([] as Awaited<ReturnType<typeof listCategories>>),
    canWrite ? listVehicleOptions(ctx.tenantId) : Promise.resolve([] as Awaited<ReturnType<typeof listVehicleOptions>>),
  ]);

  const total = summary.reduce((s, c) => s + c.total_pence, 0);

  return (
    <>
      <PageHeader
        eyebrow="Accounts · Expenses"
        title="Expenses"
        subtitle="Per-category totals + the 50 most recent expense rows. Recording & editing available below if granted."
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

      {canWrite && (
        <Card className="mt-4 max-w-2xl">
          <CardTitle>Record expense</CardTitle>
          {categories.length === 0 ? (
            <EmptyState title="No categories yet" hint="Create one at /ops/expenses first." />
          ) : (
            <form action={submitExpense} className="mt-4 space-y-3">
              <label className="block">
                <span className="eyebrow text-parchment">Category</span>
                <select name="category_id" required className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream">
                  <option value="">Select category…</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="eyebrow text-parchment">Amount (£)</span>
                <input
                  name="amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="125.00"
                  className="mt-1 w-full tnum rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream"
                />
              </label>
              <label className="block">
                <span className="eyebrow text-parchment">Incurred on</span>
                <input
                  name="incurred_on"
                  type="date"
                  required
                  className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream"
                />
              </label>
              <label className="block">
                <span className="eyebrow text-parchment">Description</span>
                <input
                  name="description"
                  placeholder="Diesel — vehicle ABC"
                  className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream"
                />
              </label>
              {vehicles.length > 0 && (
                <label className="block">
                  <span className="eyebrow text-parchment">Vehicle (optional)</span>
                  <select name="vehicle_id" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream">
                    <option value="">—</option>
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>{v.registration}</option>
                    ))}
                  </select>
                </label>
              )}
              <Button type="submit" className="w-full">Record expense</Button>
            </form>
          )}
        </Card>
      )}

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