import { PageHeader, Card, CardTitle, Stat, Badge, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getObligations, getCertificates, getLookups } from '@/lib/queries';
import { resolveObligation } from '@/lib/actions/ops';
import { getAuthContext } from '@/lib/auth/context';
import { getBlockedEntities, getTflStatus } from '@/lib/compliance';
import { markTflUploadedAction, refreshObligationsAction } from '@/lib/actions/compliance';
import { todayISO } from '@/lib/cron';
import { formatDate, daysUntil, titleCase, severityTone } from '@/lib/display';

export const dynamic = 'force-dynamic';

const SEV_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };
const certTone = (s: string) =>
  ({ verified: 'profit', pending: 'warn', rejected: 'loss', expired: 'loss' }[s] as
    'profit' | 'warn' | 'loss' | undefined) ?? 'neutral';

export default async function CompliancePage() {
  const ctx = await getAuthContext();
  const today = todayISO();
  const [obligations, certs, lookups, tfl, blocked] = await Promise.all([
    getObligations(),
    getCertificates(),
    getLookups(),
    ctx?.tenantId ? getTflStatus(ctx.tenantId, today) : Promise.resolve(null),
    ctx?.tenantId ? getBlockedEntities(ctx.tenantId) : Promise.resolve({ vehicles: 0, drivers: 0 }),
  ]);
  const blockedTotal = blocked.vehicles + blocked.drivers;

  const sorted = [...obligations].sort((a, b) => {
    const r = (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9);
    return r !== 0 ? r : new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
  });

  const critical = obligations.filter((o) => o.severity === 'critical').length;
  const overdue = obligations.filter((o) => o.status === 'overdue' || (daysUntil(o.due_date) ?? 0) < 0).length;
  const expiringCerts = certs.filter((c) => {
    const d = daysUntil(c.cover_to);
    return d !== null && d < 30;
  }).length;

  return (
    <>
      <PageHeader
        eyebrow="Compliance"
        help="page.compliance"
        title="Compliance & risk"
        subtitle="Every dated obligation — licences, DVLA, MOT/VED, GFV settlement, PCN reporting — on one surface, ranked by severity."
        actions={
          <form action={refreshObligationsAction}>
            <Button type="submit" variant="outline" size="sm"><Icon name="clock" className="h-4 w-4" /> Refresh</Button>
          </form>
        }
      />

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Open obligations" value={obligations.length} className="reveal" />
        <Stat label="Critical" value={critical} tone={critical > 0 ? 'loss' : 'profit'} className="reveal" />
        <Stat label="Overdue" value={overdue} tone={overdue > 0 ? 'warn' : 'profit'} className="reveal" />
        <Stat
          label="Blocked from hire"
          value={blockedTotal}
          tone={blockedTotal > 0 ? 'loss' : 'profit'}
          className="reveal"
        />
      </section>

      {tfl && (
        <section className="mt-4">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>TfL weekly upload</CardTitle>
                <p className="mt-1 text-sm text-muted">
                  Due by <span className="text-cream">Monday 12:00</span> · week of {formatDate(tfl.period)}
                  {blockedTotal > 0 && (
                    <> · <span className="text-[var(--color-loss)]">{blockedTotal} record(s) blocked from hire</span></>
                  )}
                </p>
              </div>
              {tfl.uploaded ? (
                <Badge tone="profit">Uploaded{tfl.uploadedAt ? ` · ${formatDate(tfl.uploadedAt)}` : ''}</Badge>
              ) : (
                <form action={markTflUploadedAction}>
                  <Button type="submit" variant="primary" size="sm">
                    <Icon name="check" className="h-4 w-4" /> Mark uploaded
                  </Button>
                </form>
              )}
            </div>
          </Card>
        </section>
      )}

      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">Obligations</h2>
        {sorted.length === 0 ? (
          <EmptyState title="Nothing outstanding" hint="All licences, insurance and finance milestones are clear." />
        ) : (
          <Card className="p-0">
            <ul className="divide-y divide-[var(--color-hair-soft)]">
              {sorted.map((o) => {
                const d = daysUntil(o.due_date);
                return (
                  <li key={o.id} className="flex items-center gap-3 px-4 py-3">
                    <span className={`text-[var(--color-${severityTone(o.severity) === 'loss' ? 'loss' : severityTone(o.severity) === 'warn' ? 'warn' : 'info'})]`}>
                      <Icon name={o.status === 'overdue' || (d ?? 0) < 0 ? 'alert' : 'clock'} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-cream">{o.title}</p>
                      <p className="text-xs text-muted">{titleCase(o.type)} · {titleCase(o.entity_type)} · due {formatDate(o.due_date)}</p>
                    </div>
                    <Badge tone={severityTone(o.severity)}>
                      {d !== null && d < 0 ? `${Math.abs(d)}d overdue` : d !== null ? `${d}d` : titleCase(o.status)}
                    </Badge>
                    <form action={resolveObligation.bind(null, o.id)}>
                      <Button type="submit" variant="outline" size="sm"><Icon name="check" className="h-4 w-4" /> Resolve</Button>
                    </form>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </section>

      <section className="mt-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-xl text-cream">Insurance certificates</h2>
          {expiringCerts > 0 && <Badge tone="warn">{expiringCerts} expiring</Badge>}
        </div>
        {certs.length === 0 ? (
          <EmptyState title="No certificates on file" />
        ) : (
          <Table caption="Certificates on file">
            <thead>
              <tr><Th>Driver</Th><Th>Insurer</Th><Th>Policy</Th><Th>Cover to</Th><Th>Status</Th><Th>{''}</Th></tr>
            </thead>
            <tbody>
              {certs.map((c) => {
                const d = daysUntil(c.cover_to);
                const expiring = d !== null && d < 30;
                return (
                  <tr key={c.id}>
                    <Td className="text-cream">{lookups.driverById.get(c.driver_id)?.full_name ?? '—'}</Td>
                    <Td>{c.insurer}</Td>
                    <Td>{c.policy_no}</Td>
                    <Td>{formatDate(c.cover_to)}</Td>
                    <Td><Badge tone={certTone(c.status)}>{titleCase(c.status)}</Badge></Td>
                    <Td>{expiring && <Badge tone={d! < 0 ? 'loss' : 'warn'}>{d! < 0 ? 'Expired' : `${d}d left`}</Badge>}</Td>
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
