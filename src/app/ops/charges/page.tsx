import { PageHeader, Card, CardTitle, Stat, Badge, Money, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { getLookups } from '@/lib/queries';
import { listOpsCharges } from '@/lib/charges';
import { listChargeMediaForCharges, type ChargeMedia } from '@/lib/charge-media';
import { attachChargeEvidenceAction } from '@/lib/actions/charge-media';
import { createCharge, updateChargeStatus } from '@/lib/actions/ops';
import { getAuthContext } from '@/lib/auth/context';
import { chargesByType, driverRecoverySummary, unassignedCharges } from '@/lib/reconciliation';
import { formatDate, titleCase, chargeStatusTone } from '@/lib/display';

export const dynamic = 'force-dynamic';

const CHARGE_TYPES = ['pcn', 'congestion', 'ulez', 'dartford', 'toll', 'airport', 'other'];

export default async function ChargesPage() {
  const ctx = await getAuthContext();
  const tid = ctx?.tenantId ?? '';
  const [charges, lookups, recovery, byType, unassigned] = await Promise.all([
    tid ? listOpsCharges(tid) : Promise.resolve([]),
    getLookups(),
    tid ? driverRecoverySummary(tid) : Promise.resolve([]),
    tid ? chargesByType(tid) : Promise.resolve([]),
    tid ? unassignedCharges(tid) : Promise.resolve(0),
  ]);
  const toRecover = recovery.reduce((s, r) => s + r.outstanding_pence, 0);
  const mediaByCharge: Map<string, ChargeMedia[]> = tid
    ? await listChargeMediaForCharges(tid, charges.map((c) => c.id))
    : new Map();

  const now = Date.now();
  const reportOverdue = (c: { report_due_at: string | null; status: string }) =>
    !!c.report_due_at && new Date(c.report_due_at).getTime() < now && c.status === 'received';

  const outstanding = charges.filter((c) => !['paid_by_driver', 'paid_by_company', 'cancelled'].includes(c.status)).length;
  const overdueCount = charges.filter(reportOverdue).length;
  const totalValue = charges.reduce((s, c) => s + c.amount_pence, 0);

  return (
    <>
      <PageHeader
        eyebrow="Charges"
        help="page.charges"
        title="Pass-through charges"
        subtitle="PCNs, congestion, ULEZ, Dartford and tolls — all driver-liable. The 48-hour reporting clock is tracked so nothing becomes the company's cost."
      />

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Outstanding" value={outstanding} className="reveal" />
        <Stat label="Report overdue (48h)" value={overdueCount} tone={overdueCount > 0 ? 'loss' : 'profit'} className="reveal" />
        <Stat label="To recover from drivers" value={<Money pence={toRecover} showPence={false} />} tone={toRecover > 0 ? 'warn' : 'profit'} className="reveal" />
        <Stat label="Unassigned" value={unassigned} tone={unassigned > 0 ? 'loss' : 'profit'} className="reveal" />
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Driver reconciliation</CardTitle>
          {recovery.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nothing outstanding to recover from drivers.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {recovery.map((r) => (
                <li key={r.driver_id} className="flex items-center justify-between border-t border-hair-soft pt-2 text-sm first:border-t-0 first:pt-0">
                  <span className="text-cream">{r.driver_name} <span className="text-muted">· {r.count} charge(s)</span></span>
                  <span className="tnum text-[var(--color-loss)]"><Money pence={r.outstanding_pence} showPence={false} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardTitle>By type</CardTitle>
          {byType.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No open charges.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {byType.map((t) => (
                <li key={t.type} className="flex items-center justify-between border-t border-hair-soft pt-2 text-sm first:border-t-0 first:pt-0">
                  <span className="text-parchment">{titleCase(t.type)} <span className="text-muted">· {t.count}</span></span>
                  <span className="tnum text-cream"><Money pence={t.total_pence} showPence={false} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="mb-3 font-display text-xl text-cream">All charges</h2>
          {charges.length === 0 ? (
            <EmptyState title="No charges logged" />
          ) : (
            <Table caption="All charges">
              <thead>
                <tr>
                  <Th>Vehicle</Th><Th>Category / type</Th><Th>Ref</Th><Th>Received</Th><Th>Receipt</Th><Th>Evidence</Th>
                  <Th className="text-right">Amount</Th><Th>48h report</Th><Th>Status</Th><Th>{''}</Th>
                </tr>
              </thead>
              <tbody>
                {charges.map((c) => (
                  <tr key={c.id}>
                    <Td className="text-cream">{c.vehicle_reg ?? '—'}</Td>
                    <Td>
                      <span className="text-cream">{c.category ?? c.authority ?? c.type.toUpperCase()}</span>
                      {c.submitted_by_driver && <Badge tone="info" className="ml-1.5">Driver</Badge>}
                    </Td>
                    <Td>{c.reference ?? '—'}</Td>
                    <Td>{formatDate(c.received_on)}</Td>
                    <Td>
                      {c.has_receipt ? (
                        <a href={`/api/receipts/charge/${c.id}`} target="_blank" rel="noopener noreferrer" className="text-gold-bright hover:underline">View</a>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(mediaByCharge.get(c.id) ?? []).map((m, i) => (
                          <a key={m.id} href={`/api/receipts/media/${m.id}`} target="_blank" rel="noopener noreferrer" className="text-gold-bright hover:underline">
                            {m.kind === 'video' ? '▶' : '🖼'} {i + 1}
                          </a>
                        ))}
                        <form action={attachChargeEvidenceAction} className="inline-flex items-center gap-1">
                          <input type="hidden" name="charge_id" value={c.id} />
                          <input
                            type="file"
                            name="evidence"
                            aria-label={`Attach evidence for charge ${c.reference ?? c.id}`}
                            accept="image/*,video/*"
                            capture="environment"
                            className="w-24 text-[10px] text-muted file:mr-1 file:rounded file:border-0 file:bg-navy-2 file:px-1.5 file:py-0.5 file:text-[10px] file:text-cream"
                          />
                          <Button type="submit" variant="ghost" size="sm">Add</Button>
                        </form>
                      </div>
                    </Td>
                    <Td className="text-right"><Money pence={c.amount_pence} /></Td>
                    <Td>
                      {reportOverdue(c)
                        ? <Badge tone="loss">Overdue</Badge>
                        : c.status === 'received'
                          ? <Badge tone="warn">Pending</Badge>
                          : <Badge tone="profit">Reported</Badge>}
                    </Td>
                    <Td><Badge tone={chargeStatusTone(c.status)}>{titleCase(c.status)}</Badge></Td>
                    <Td>
                      <div className="flex justify-end gap-1.5">
                        {c.status === 'received' && (
                          <form action={updateChargeStatus.bind(null, c.id, 'driver_notified')}>
                            <Button type="submit" variant="ghost" size="sm">Notify</Button>
                          </form>
                        )}
                        {!['paid_by_driver', 'paid_by_company', 'cancelled'].includes(c.status) && (
                          <>
                            <form action={updateChargeStatus.bind(null, c.id, 'paid_by_driver')}>
                              <Button type="submit" variant="outline" size="sm">Driver paid</Button>
                            </form>
                            <form action={updateChargeStatus.bind(null, c.id, 'paid_by_company')}>
                              <Button type="submit" variant="ghost" size="sm">Co. paid</Button>
                            </form>
                          </>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>

        {/* Log a charge */}
        <Card>
          <CardTitle>Log a charge</CardTitle>
          <form action={createCharge} className="mt-4 space-y-3">
            <label className="block">
              <span className="eyebrow text-parchment">Vehicle</span>
              <select name="vehicle_id" required className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2">
                <option value="">Select vehicle…</option>
                {lookups.vehicles.map((v) => <option key={v.id} value={v.id}>{v.registration}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="eyebrow text-parchment">Driver (optional)</span>
              <select name="driver_id" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2">
                <option value="">Unassigned</option>
                {lookups.drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="eyebrow text-parchment">Type</span>
              <select name="type" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2">
                {CHARGE_TYPES.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="eyebrow text-parchment">Authority</span>
              <input name="authority" placeholder="TfL" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2" />
            </label>
            <label className="block">
              <span className="eyebrow text-parchment">Reference</span>
              <input name="reference" placeholder="PCN ref" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="eyebrow text-parchment">Amount (£)</span>
                <input name="amount" type="number" step="0.01" min="0" required placeholder="65.00" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream tnum focus-visible:outline-2" />
              </label>
              <label className="block">
                <span className="eyebrow text-parchment">Received</span>
                <input name="received_on" type="date" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2" />
              </label>
            </div>
            <Button type="submit" className="w-full">Log charge</Button>
          </form>
        </Card>
      </section>
    </>
  );
}
