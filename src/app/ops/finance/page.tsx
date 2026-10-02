import { PageHeader, Card, CardTitle, Stat, Badge, Money, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { getFleetEconomics, getVehicles } from '@/lib/queries';
import { getVatByQuarter, getFinanceAgreements } from '@/lib/queries-ops';
import { createFinanceAgreement } from '@/lib/actions/ops';
import { gfvScenarios } from '@/lib/finance';
import { formatDate, titleCase, gfvTone } from '@/lib/display';
import { getAuthContext } from '@/lib/auth/context';
import { getVatReturn, listRecentQuarters, vatReturnBoxes } from '@/lib/ops/vat-return';
import { VatReturnPanel } from './VatReturnPanel';

const inputCls = 'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export const dynamic = 'force-dynamic';

function quarterLabel(d: string): string {
  const dt = new Date(d);
  const q = Math.floor(dt.getMonth() / 3) + 1;
  return `Q${q} ${dt.getFullYear()}`;
}

export default async function FinancePage() {
  const [ctx, econ, vat, finance, vehicles] = await Promise.all([
    getAuthContext(),
    getFleetEconomics(),
    getVatByQuarter(),
    getFinanceAgreements(),
    getVehicles(),
  ]);

  // HMRC 9-box VAT return for the last four quarters (accrual basis), for the panel.
  const tid = ctx?.tenantId ?? '';
  const vatQuarters = tid
    ? await Promise.all(
        listRecentQuarters(4).map(async (q) => {
          const ret = await getVatReturn(tid, q.start);
          return { start: q.start, label: q.label, boxes: vatReturnBoxes(ret) };
        }),
      )
    : [];

  const financeByVehicle = new Map(finance.map((f) => [f.vehicle_id, f]));

  // Fleet totals.
  const totals = econ.reduce(
    (acc, e) => {
      acc.net += e.contracted_annual_net_pence ?? 0;
      acc.lease += e.annual_lease_pence ?? 0;
      acc.maint += e.maintenance_12m_pence ?? 0;
      acc.ved += e.ved_annual_pence ?? 0;
      acc.profit += e.contracted_annual_profit_pence ?? 0;
      return acc;
    },
    { net: 0, lease: 0, maint: 0, ved: 0, profit: 0 },
  );
  const fleetMargin = totals.net > 0 ? Math.round((totals.profit / totals.net) * 1000) / 10 : 0;
  const netVatDue = vat.reduce((s, v) => s + (v.net_vat_pence ?? 0), 0);

  const rtbVehicles = econ.filter((e) => e.agreement_type === 'rtb');

  return (
    <>
      <PageHeader
        eyebrow="Finance & VAT"
        help="page.finance"
        title="Finance & VAT"
        subtitle="Cash-basis VAT by quarter, contracted per-vehicle P&L, and the GFV settlement exposure on rent-to-buy vehicles."
      />

      {/* Record a finance agreement */}
      <Card className="reveal">
        <CardTitle>Record a finance agreement</CardTitle>
        <form action={createFinanceAgreement} className="mt-4 flex flex-wrap gap-3">
          {/* <label> wrappers: the caption text was visible but not programmatically
              associated with its control (WCAG 1.3.1 / 4.1.2). Layout is unchanged. */}
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Vehicle</span>
            <select name="vehicle_id" required className={inputCls}>
              <option value="">Select vehicle…</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.registration}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Funder</span>
            <input name="funder" placeholder="Lender" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Reference</span>
            <input name="reference" placeholder="Agreement ref" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Initial rental (£)</span>
            <input name="initial_rental" type="number" step="0.01" min="0" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Monthly payment (£)</span>
            <input name="monthly_payment" type="number" step="0.01" min="0" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">APR (%)</span>
            <input name="apr" type="number" step="0.01" min="0" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Term (months)</span>
            <input name="term_months" type="number" required min="1" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Start</span>
            <input name="start_on" type="date" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Amount financed (£)</span>
            <input name="amount_financed" type="number" step="0.01" min="0" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">GFV / balloon (£)</span>
            <input name="gfv_amount" type="number" step="0.01" min="0" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">GFV due</span>
            <input name="gfv_due_on" type="date" className={inputCls} />
          </label>
          <div className="flex items-end">
            <Button type="submit" variant="primary">Save finance agreement</Button>
          </div>
        </form>
      </Card>

      <section className="mt-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Contracted net (annual)" value={<Money pence={totals.net} showPence={false} />} className="reveal" />
        <Stat label="Contracted profit (annual)" value={<Money pence={totals.profit} showPence={false} signed />} tone="profit" className="reveal" />
        <Stat label="Fleet margin" value={`${fleetMargin}%`} tone="gold" className="reveal" />
        <Stat label="Net VAT (all quarters)" value={<Money pence={netVatDue} showPence={false} />} tone={netVatDue > 0 ? 'loss' : 'profit'} className="reveal" />
      </section>

      {/* VAT by quarter */}
      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">Cash-basis VAT by quarter</h2>
        {vat.length === 0 ? (
          <EmptyState title="No VAT activity yet" hint="VAT is recognised when cash is received." />
        ) : (
          <Table caption="Cash-basis VAT by quarter">
            <thead>
              <tr>
                <Th>Quarter</Th>
                <Th className="text-right">Gross received</Th>
                <Th className="text-right">Output VAT</Th>
                <Th className="text-right">Input VAT (maint.)</Th>
                <Th className="text-right">Net VAT due</Th>
              </tr>
            </thead>
            <tbody>
              {vat.map((v) => (
                <tr key={v.quarter_start}>
                  <Td className="text-cream">{quarterLabel(v.quarter_start)}</Td>
                  <Td className="text-right"><Money pence={v.gross_received_pence} /></Td>
                  <Td className="text-right"><Money pence={v.output_vat_pence} /></Td>
                  <Td className="text-right"><Money pence={v.input_vat_maintenance_pence} /></Td>
                  <Td className="text-right"><Money pence={v.net_vat_pence} signed /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {/* HMRC 9-box VAT return (accrual) + downloads */}
      <section className="mt-4">
        <VatReturnPanel quarters={vatQuarters} />
      </section>

      {/* Per-vehicle P&L */}
      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">Per-vehicle P&amp;L (contracted, annual)</h2>
        {econ.length === 0 ? (
          <EmptyState title="No vehicles" />
        ) : (
          <Table caption="Per-vehicle profit and loss, contracted annual">
            <thead>
              <tr>
                <Th>Vehicle</Th><Th>Hire</Th>
                <Th className="text-right">Net</Th><Th className="text-right">Lease</Th>
                <Th className="text-right">Maint.</Th><Th className="text-right">VED</Th>
                <Th className="text-right">Profit</Th><Th className="text-right">Margin</Th>
              </tr>
            </thead>
            <tbody>
              {econ.map((e) => {
                const net = e.contracted_annual_net_pence ?? 0;
                const profit = e.contracted_annual_profit_pence ?? 0;
                const margin = net > 0 ? Math.round((profit / net) * 1000) / 10 : 0;
                return (
                  <tr key={e.vehicle_id}>
                    <Td className="text-cream">{e.registration}</Td>
                    <Td>{e.agreement_type ? (e.agreement_type === 'rtb' ? 'RTB' : 'Standard') : '—'}</Td>
                    <Td className="text-right"><Money pence={net} showPence={false} /></Td>
                    <Td className="text-right"><Money pence={e.annual_lease_pence ?? 0} showPence={false} /></Td>
                    <Td className="text-right"><Money pence={e.maintenance_12m_pence ?? 0} showPence={false} /></Td>
                    <Td className="text-right"><Money pence={e.ved_annual_pence ?? 0} showPence={false} /></Td>
                    <Td className="text-right"><Money pence={profit} showPence={false} signed /></Td>
                    <Td className="text-right tnum">{margin}%</Td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-hair">
                <Td className="font-display text-cream">Fleet</Td>
                <Td>{''}</Td>
                <Td className="text-right"><Money pence={totals.net} showPence={false} /></Td>
                <Td className="text-right"><Money pence={totals.lease} showPence={false} /></Td>
                <Td className="text-right"><Money pence={totals.maint} showPence={false} /></Td>
                <Td className="text-right"><Money pence={totals.ved} showPence={false} /></Td>
                <Td className="text-right"><Money pence={totals.profit} showPence={false} signed /></Td>
                <Td className="text-right tnum text-gold-bright">{fleetMargin}%</Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </section>

      {/* GFV exposure */}
      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">GFV settlement exposure (RTB)</h2>
        {rtbVehicles.length === 0 ? (
          <EmptyState title="No rent-to-buy vehicles" hint="GFV exposure only applies to RTB agreements." />
        ) : (
          <Table caption="GFV settlement exposure">
            <thead>
              <tr>
                <Th>Vehicle</Th><Th>GFV status</Th><Th>GFV due</Th>
                <Th className="text-right">3yr gross</Th><Th className="text-right">Funder GFV</Th>
                <Th className="text-right">Net after settlement</Th><Th>Viable</Th>
              </tr>
            </thead>
            <tbody>
              {rtbVehicles.map((e) => {
                const threeYearGross = ((e.contracted_annual_net_pence ?? 0) - (e.annual_lease_pence ?? 0) - (e.ved_annual_pence ?? 0)) * 3;
                const gfv = financeByVehicle.get(e.vehicle_id)?.gfv_amount_pence ?? 0;
                const scenario = gfv > 0 ? gfvScenarios(threeYearGross, [gfv])[0] : null;
                return (
                  <tr key={e.vehicle_id}>
                    <Td className="text-cream">{e.registration}</Td>
                    <Td><Badge tone={gfvTone(e.gfv_status)}>{titleCase(e.gfv_status)}</Badge></Td>
                    <Td>{formatDate(e.gfv_due_on)}</Td>
                    <Td className="text-right"><Money pence={threeYearGross} showPence={false} signed /></Td>
                    <Td className="text-right">{gfv > 0 ? <Money pence={gfv} showPence={false} /> : '—'}</Td>
                    <Td className="text-right">{scenario ? <Money pence={scenario.netAfterSettlementPence} showPence={false} signed /> : '—'}</Td>
                    <Td>{scenario ? <Badge tone={scenario.viable ? 'profit' : 'loss'}>{scenario.viable ? 'Viable' : 'At risk'}</Badge> : '—'}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
