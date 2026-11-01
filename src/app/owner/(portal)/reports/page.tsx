import Link from 'next/link';
import { PageHeader, Card, EmptyState } from '@/components/ui';
import { periodLabel } from '@/lib/owner-report-run';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function OwnerReportsPage() {
  const sb = await createClient();
  const { data } = await sb.from('owner_reports').select('id, period, generated_at, data').order('period', { ascending: false });
  const reports = (data ?? []) as Array<{ id: string; period: string; generated_at: string; data: { totals?: { distanceKm?: number; alerts?: number } } }>;

  return (
    <>
      <PageHeader eyebrow="Reports" title="Your monthly reports" subtitle="A protection report for every month, kept here as it was sent." />
      {reports.length === 0 ? (
        <EmptyState title="No reports yet" hint="Your first report arrives on the 1st of next month." />
      ) : (
        <ul className="space-y-3">
          {reports.map((r) => (
            <li key={r.id}>
              <Link href={`/owner/reports/${r.period}`} className="block">
                <Card className="transition hover:border-gold-bright">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-display text-cream">{periodLabel(r.period)}</span>
                    <span className="text-sm text-muted">
                      {r.data.totals?.distanceKm ?? 0} km · {r.data.totals?.alerts ?? 0} alert{(r.data.totals?.alerts ?? 0) === 1 ? '' : 's'}
                    </span>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
