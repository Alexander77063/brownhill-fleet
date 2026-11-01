import { notFound } from 'next/navigation';
import { PageHeader, Button } from '@/components/ui';
import { ReportView } from '@/components/owner/ReportView';
import type { OwnerReportData } from '@/lib/owner-report';
import { periodLabel } from '@/lib/owner-report-run';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function OwnerReportPage({ params }: { params: Promise<{ period: string }> }) {
  const { period } = await params;
  if (!/^\d{4}-\d{2}$/.test(period)) notFound();
  const sb = await createClient();
  const { data } = await sb.from('owner_reports').select('data').eq('period', period).maybeSingle();
  if (!data) notFound();
  const report = data.data as unknown as OwnerReportData;

  return (
    <>
      <PageHeader
        eyebrow="Protection report"
        title={periodLabel(period)}
        subtitle="How your vehicles were looked after this month."
        actions={
          <span className="no-print">
            <Button href="/owner/reports" variant="ghost" size="sm">
              All reports
            </Button>
          </span>
        }
      />
      <ReportView data={report} />
      <p className="no-print mt-4 text-xs text-muted">To keep a copy, use your browser&apos;s Print and choose Save as PDF.</p>
    </>
  );
}
