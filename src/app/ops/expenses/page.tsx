import { PageHeader, Card, CardTitle, Stat, Badge, Button, Table, Th, Td, EmptyState, Money } from '@/components/ui';
import { getAuthContext } from '@/lib/auth/context';
import { expenseSummaryByCategory, listCategories, listExpenses, listVehicleOptions } from '@/lib/expenses';
import {
  createCategoryAction,
  recordExpenseAction,
  setCategoryVatTreatmentAction,
  toggleCategoryDriverSubmittableAction,
} from '@/lib/actions/expenses';
import { VAT_TREATMENTS } from '@/lib/expenses';
import { formatDate } from '@/lib/display';

export const dynamic = 'force-dynamic';

const inputCls =
  'w-full rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export default async function ExpensesPage() {
  const ctx = await getAuthContext();
  const tenantId = ctx?.tenantId ?? '';
  const [categories, expenses, summary, vehicles] = await Promise.all([
    tenantId ? listCategories(tenantId, { includeInactive: true }) : Promise.resolve([]),
    tenantId ? listExpenses(tenantId) : Promise.resolve([]),
    tenantId ? expenseSummaryByCategory(tenantId) : Promise.resolve([]),
    tenantId ? listVehicleOptions(tenantId) : Promise.resolve([]),
  ]);
  const expenseCats = categories.filter((c) => c.kind === 'expense' && c.is_active);
  const total = summary.reduce((s, c) => s + c.total_pence, 0);

  return (
    <>
      <PageHeader eyebrow="Finance" title="Expenses & categories" subtitle="Categorised costs with generated references (EXP-…), receipts and driver-submittable categories." />

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Total recorded" value={<Money pence={total} showPence={false} />} className="reveal" />
        <Stat label="Entries" value={expenses.length} className="reveal" />
        <Stat label="Categories" value={categories.length} className="reveal" />
        <Stat label="Top category" value={summary[0]?.category ?? '—'} className="reveal" />
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Record an expense</CardTitle>
          <form action={recordExpenseAction} className="mt-3 space-y-2">
            <select name="category_id" aria-label="Expense category" className={inputCls} defaultValue="">
              <option value="">Uncategorised</option>
              {expenseCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select name="vehicle_id" aria-label="Vehicle this expense relates to" className={inputCls} defaultValue="">
              <option value="">No vehicle</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.registration}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input name="amount" required inputMode="decimal" placeholder="Amount (£)" aria-label="Amount in pounds" className={inputCls} />
              <input name="incurred_on" type="date" aria-label="Date incurred" className={inputCls} />
            </div>
            <input name="description" placeholder="Description (optional)" aria-label="Description" className={inputCls} />
            <label className="block">
              <span className="mb-1 block text-xs text-parchment">Receipt photo (optional)</span>
              <input name="receipt" type="file" accept="image/*,application/pdf" capture="environment" className={`${inputCls} file:mr-2 file:rounded file:border-0 file:bg-navy-2 file:px-2 file:py-1 file:text-xs file:text-cream`} />
            </label>
            <Button type="submit" variant="primary" size="sm">Record expense</Button>
          </form>
        </Card>

        <Card>
          <CardTitle>Categories</CardTitle>
          <p className="mt-1 text-xs text-muted">
            Tenant-defined. Mark a category <span className="text-parchment">driver-submittable</span> to let drivers attach photos to it.
          </p>

          <form action={createCategoryAction} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
            <input name="name" required placeholder="New category" aria-label="New category name" className={inputCls} />
            <select name="kind" aria-label="Category kind" className={inputCls} defaultValue="expense">
              <option value="expense">Expense</option>
              <option value="charge">Charge</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs text-parchment">
              <input type="checkbox" name="driver_submittable" value="1" defaultChecked className="accent-gold-bright" />
              Driver
            </label>
            <select name="vat_treatment" aria-label="VAT treatment (for the HMRC VAT return)" className={`${inputCls} sm:col-span-2`} defaultValue="standard" title="VAT treatment (for the HMRC VAT return)">
              <option value="standard">Standard-rated VAT (20%)</option>
              <option value="zero">Zero-rated</option>
              <option value="exempt">Exempt</option>
              <option value="outside">Outside scope</option>
            </select>
            <Button type="submit" variant="outline" size="sm">Add category</Button>
          </form>

          {categories.length > 0 && (
            <ul className="mt-4 space-y-1.5">
              {categories.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2">
                    <span className={c.is_active ? 'text-cream' : 'text-muted line-through'}>{c.name}</span>
                    <Badge tone={c.kind === 'charge' ? 'warn' : 'neutral'}>{c.kind}</Badge>
                    {c.driver_submittable && <Badge tone="info">driver</Badge>}
                    <Badge tone="gold">VAT: {c.vat_treatment}</Badge>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <form action={setCategoryVatTreatmentAction} className="flex items-center gap-1">
                      <input type="hidden" name="category_id" value={c.id} />
                      <select name="vat_treatment" aria-label={`VAT treatment for ${c.name}`} defaultValue={c.vat_treatment} className={`${inputCls} py-1 text-xs`}>
                        {VAT_TREATMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <Button type="submit" variant="ghost" size="sm">Set VAT</Button>
                    </form>
                    <form action={toggleCategoryDriverSubmittableAction}>
                      <input type="hidden" name="category_id" value={c.id} />
                      <input type="hidden" name="submittable" value={c.driver_submittable ? '0' : '1'} />
                      <Button type="submit" variant="ghost" size="sm">
                        {c.driver_submittable ? 'Disable driver' : 'Enable driver'}
                      </Button>
                    </form>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">Recent expenses</h2>
        {expenses.length === 0 ? (
          <EmptyState title="No expenses yet" hint="Record your first cost above." />
        ) : (
          <Table caption="Recent expenses">
            <thead>
              <tr><Th>Reference</Th><Th>Date</Th><Th>Category</Th><Th>Description</Th><Th>Receipt</Th><Th className="text-right">Amount</Th></tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id}>
                  <Td className="font-mono text-xs text-parchment">{e.reference}</Td>
                  <Td>{formatDate(e.incurred_on)}</Td>
                  <Td>{e.category ?? '—'}</Td>
                  <Td className="text-cream">{e.description ?? '—'}</Td>
                  <Td>
                    {e.has_receipt ? (
                      <a href={`/api/receipts/expense/${e.id}`} target="_blank" rel="noopener noreferrer" className="text-gold-bright hover:underline">
                        View
                      </a>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td className="text-right"><Money pence={e.amount_pence} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
