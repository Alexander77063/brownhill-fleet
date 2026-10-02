import Link from 'next/link';
import { getTenantAiStatus } from '@/lib/ops/assistant';
import { ReportGenerator } from '@/components/ops/ReportGenerator';
import { PageHeader, Card, CardTitle, Table, Th, Td } from '@/components/ui';
import { requireTenantContext } from '@/lib/auth/context';
import { createServiceClient } from '@/lib/supabase/server';
import { periodLabel } from '@/lib/owner-report-run';
import type { OwnerReportData } from '@/lib/owner-report';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const [status, ctx] = await Promise.all([getTenantAiStatus().catch(() => null), requireTenantContext()]);
  const ready = !!status?.ready;

  // The insurer's roll-up of the owners' monthly protection reports — the
  // latest period on file, sorted by the things an underwriter looks at.
  const sb = createServiceClient();
  const { data: latest } = await sb.from('owner_reports').select('period').eq('tenant_id', ctx.tenantId).order('period', { ascending: false }).limit(1).maybeSingle();
  const period = latest?.period ?? null;
  const { data: rows } = period
    ? await sb.from('owner_reports').select('owner_id, data, vehicle_owners(name)').eq('tenant_id', ctx.tenantId).eq('period', period)
    : { data: [] as never[] };
  const portfolio = ((rows ?? []) as unknown as Array<{ owner_id: string; data: OwnerReportData; vehicle_owners: { name: string } | { name: string }[] | null }>)
    .map((r) => ({
      ownerId: r.owner_id,
      name: (Array.isArray(r.vehicle_owners) ? r.vehicle_owners[0] : r.vehicle_owners)?.name ?? '—',
      km: r.data.totals.distanceKm,
      alerts: r.data.totals.alerts,
      expired: r.data.totals.expiredDocs,
      dueSoon: r.data.totals.dueSoonDocs,
      vehicles: r.data.vehicles.length,
    }))
    .sort((a, b) => b.expired - a.expired || b.alerts - a.alerts || b.km - a.km);

  return (
    <>
      <PageHeader
        eyebrow="Reports"
        help="page.reports"
        title="Generate a report"
        subtitle="Board packs, investor updates and VAT summaries — written by your AI from your own data."
      />

      <ReportGenerator ready={ready} />

      {period && portfolio.length > 0 && (
        <Card className="mt-6 p-0">
          <div className="flex items-baseline justify-between px-4 pt-4">
            <CardTitle>Protection reports — {periodLabel(period)}</CardTitle>
            <span className="text-xs text-muted">{portfolio.length} owners · expired documents first</span>
          </div>
          <Table caption={`Owner protection reports for ${periodLabel(period)}`}>
            <thead>
              <tr>
                <Th>Owner</Th>
                <Th className="text-right">Vehicles</Th>
                <Th className="text-right">Distance</Th>
                <Th className="text-right">Alerts</Th>
                <Th className="text-right">Expired</Th>
                <Th className="text-right">Due soon</Th>
              </tr>
            </thead>
            <tbody>
              {portfolio.map((p) => (
                <tr key={p.ownerId}>
                  <Td className="text-cream">
                    <Link href={`/ops/owners/${p.ownerId}/reports?period=${period}`} className="hover:text-gold-bright">
                      {p.name}
                    </Link>
                  </Td>
                  <Td className="text-right tnum">{p.vehicles}</Td>
                  <Td className="text-right tnum">{p.km} km</Td>
                  <Td className="text-right tnum">{p.alerts}</Td>
                  <Td className={`text-right tnum ${p.expired > 0 ? 'text-[var(--color-loss)]' : ''}`}>{p.expired}</Td>
                  <Td className="text-right tnum">{p.dueSoon}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
