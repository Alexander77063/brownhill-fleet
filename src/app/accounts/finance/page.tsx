import { PageHeader, Card, CardTitle, Money, Table, Th, Td, EmptyState } from '@/components/ui';
import { formatDate } from '@/lib/display';
import { getVatByQuarter, getFinanceAgreements } from '@/lib/queries-ops';
import { requireTenantContext, contextCan } from '@/lib/auth/context';
import { listRecentQuarters, getVatReturn, vatReturnBoxes } from '@/lib/ops/vat-return';

export const dynamic = 'force-dynamic';

export default async function AccountsFinancePage() {
  const ctx = await requireTenantContext();
  const canBilling = contextCan(ctx, 'billing.read');
  if (!canBilling) {
    return (
      <>
        <PageHeader eyebrow="Accounts" title="Finance" />
        <Card>
          <p className="text-sm text-muted">
            You don&apos;t have permission to read finance. Ask the ops admin to grant
            you <code>billing.read</code>.
          </p>
        </Card>
      </>
    );
  }
  const [byQuarter, finance] = await Promise.all([
    getVatByQuarter(),
    getFinanceAgreements(),
  ]);

  // Latest two VAT-return boxes — accountants want to see what the box figures
  // would be without leaving the portal.
  const recentQuarters = listRecentQuarters(2);
  const vatBoxes = await Promise.all(
    recentQuarters.map(async (q) => ({
      quarter: q,
      boxes: await getVatReturn(ctx.tenantId, q.start).catch(() => null),
    })),
  );

  return (
    <>
      <PageHeader
        eyebrow="Accounts · Finance"
        title="Finance & VAT"
        subtitle="VAT-by-quarter rollups, the last two VAT-return boxes, and any HP/finance agreements on fleet vehicles."
      />

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>VAT by quarter (cash basis)</CardTitle>
          {byQuarter.length === 0 ? (
            <EmptyState title="No VAT recorded yet" />
          ) : (
            <Table caption="VAT by quarter">
              <thead>
                <tr>
                  <Th>Quarter</Th>
                  <Th className="text-right">Received</Th>
                  <Th className="text-right">Output</Th>
                  <Th className="text-right">Input (maint.)</Th>
                  <Th className="text-right">Net</Th>
                </tr>
              </thead>
              <tbody>
                {byQuarter.map((q) => (
                  <tr key={q.quarter_start}>
                    <Td className="text-cream">{q.quarter_start.slice(0, 7)}</Td>
                    <Td className="text-right font-mono"><Money pence={q.gross_received_pence ?? 0} /></Td>
                    <Td className="text-right font-mono"><Money pence={q.output_vat_pence ?? 0} /></Td>
                    <Td className="text-right font-mono"><Money pence={q.input_vat_maintenance_pence ?? 0} /></Td>
                    <Td className="text-right font-mono"><Money pence={q.net_vat_pence ?? 0} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardTitle>Latest VAT-return boxes (accrual)</CardTitle>
          {vatBoxes.every((v) => !v.boxes) ? (
            <EmptyState title="No VAT return built yet" hint="The operator runs the rollup at /ops/finance." />
          ) : (
            <div className="space-y-3 text-sm">
              {vatBoxes.map((v) => (
                <div key={v.quarter.start} className="rounded-md border border-hair-soft p-3">
                  <p className="eyebrow text-parchment">{v.quarter.label}</p>
                  {v.boxes ? (
                    <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1">
                      {vatReturnBoxes(v.boxes).map((box) => (
                        <li key={box.n} className="flex items-center justify-between gap-3">
                          <span className="text-muted">Box {box.n} · {box.label}</span>
                          <span className="font-mono">{box.value}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs text-muted">Not yet computed.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>

      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">Finance agreements</h2>
        {finance.length === 0 ? (
          <EmptyState title="No finance agreements on file" />
        ) : (
          <Table caption="Finance agreements">
            <thead>
              <tr>
                <Th>Vehicle</Th>
                <Th>Lender</Th>
                <Th className="text-right">Balance</Th>
                <Th>Term end</Th>
                <Th>GFV</Th>
              </tr>
            </thead>
            <tbody>
              {finance.map((f) => {
                const fa = f as unknown as Record<string, unknown>;
                return (
                  <tr key={String(fa.id ?? Math.random())}>
                    <Td className="text-cream">{String(fa.vehicle_registration ?? fa.vehicle_id ?? '—')}</Td>
                    <Td>{String(fa.lender ?? '—')}</Td>
                    <Td className="text-right font-mono"><Money pence={Number(fa.balance_pence ?? 0)} /></Td>
                    <Td>{fa.term_end ? formatDate(String(fa.term_end)) : '—'}</Td>
                    <Td className="font-mono"><Money pence={Number(fa.gfv_pence ?? 0)} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <p className="mt-3 text-xs text-muted">
          Recording and editing lives at <a className="text-gold-bright hover:underline" href="/ops/finance">/ops/finance</a>.
        </p>
      </section>
    </>
  );
}