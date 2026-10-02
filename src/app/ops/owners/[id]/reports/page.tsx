import { notFound } from 'next/navigation';
import { PageHeader, Button, Card, EmptyState } from '@/components/ui';
import { ReportView } from '@/components/owner/ReportView';
import { requireTenantContext } from '@/lib/auth/context';
import type { OwnerReportData } from '@/lib/owner-report';
import { periodLabel } from '@/lib/owner-report-run';
import { getOwner } from '@/lib/owners';
import { createServiceClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function OwnerReportsForStaff({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { id } = await params;
  const { period } = await searchParams;
  const ctx = await requireTenantContext();
  const owner = await getOwner(ctx.tenantId, id);
  if (!owner) notFound();
  const sb = createServiceClient();
  const { data } = await sb
    .from('owner_reports')
    .select('period, data')
    .eq('tenant_id', ctx.tenantId)
    .eq('owner_id', id)
    .order('period', { ascending: false });
  const reports = (data ?? []) as unknown as Array<{ period: string; data: OwnerReportData }>;
  const selected = reports.find((r) => r.period === period) ?? reports[0];

  return (
    <>
      <PageHeader
        eyebrow="Protection reports"
        title={owner.name}
        subtitle={selected ? periodLabel(selected.period) : 'No reports yet'}
        actions={
          <Button href={`/ops/owners/${id}`} variant="ghost" size="sm">
            Owner
          </Button>
        }
      />
      {reports.length > 1 && (
        <nav aria-label="Report month" className="mb-4 flex flex-wrap gap-3 text-sm">
          {reports.map((r) => (
            <a key={r.period} href={`/ops/owners/${id}/reports?period=${r.period}`} className={r.period === selected?.period ? 'text-gold-bright' : 'text-muted hover:text-cream'}>
              {periodLabel(r.period)}
            </a>
          ))}
        </nav>
      )}
      {selected ? (
        <ReportView data={selected.data} />
      ) : (
        <Card>
          <EmptyState title="No reports yet" hint="Reports are generated on the 1st of each month for owners with a vehicle." />
        </Card>
      )}
    </>
  );
}
