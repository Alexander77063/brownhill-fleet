import { PageHeader, Card, CardTitle, EmptyState } from '@/components/ui';
import { getSessionProfile } from '@/lib/auth';
import { listDriverVehicles } from '@/lib/charges';
import { getMyDamageReports } from '@/lib/queries-driver-damage';
import { ReportDamageForm } from './ReportDamageForm';

export const dynamic = 'force-dynamic';

export default async function DriverReportPage() {
  const p = await getSessionProfile();
  if (!p?.driverId) {
    return (
      <>
        <PageHeader eyebrow="Report" title="Report damage or an issue" />
        <EmptyState title="No active driver account" hint="Ask your fleet team to finish setting you up." />
      </>
    );
  }

  const [vehicles, myReports] = await Promise.all([
    listDriverVehicles(p.driverId),
    getMyDamageReports(p.driverId),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Report"
        title="Report damage or an issue"
        subtitle="Tell the office about something you've noticed on your car — a new scratch, a warning light, a panel crack. The earlier the office knows, the easier it is to recover costs or schedule work."
      />

      <Card className="mt-4 max-w-2xl">
        {vehicles.length === 0 ? (
          <EmptyState
            title="No vehicle on file"
            hint="Once your agreement has a vehicle attached, you can submit damage reports here."
          />
        ) : (
          <ReportDamageForm vehicles={vehicles} />
        )}
      </Card>

      <Card className="mt-4 max-w-2xl">
        <CardTitle>Your recent reports</CardTitle>
        {myReports.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No reports yet — clean record.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {myReports.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-2 border-t border-hair-soft py-2 first:border-t-0">
                <span className="font-mono text-xs text-muted">{r.createdAt.slice(0, 10)}</span>
                <span className="font-medium text-cream capitalize">{r.severity}</span>
                <span className="text-cream">{r.description.slice(0, 100)}{r.description.length > 100 ? '…' : ''}</span>
                <span className={`ml-auto rounded-full px-2 py-0.5 text-xs ${statusTone(r.status)}`}>{statusLabel(r.status)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function statusTone(s: string): string {
  switch (s) {
    case 'open': return 'bg-amber-100 text-amber-800';
    case 'reviewed': return 'bg-blue-100 text-blue-800';
    case 'in_repair': return 'bg-violet-100 text-violet-800';
    case 'resolved': return 'bg-emerald-100 text-emerald-800';
    case 'rejected': return 'bg-rose-100 text-rose-800';
    default: return 'bg-gray-100 text-gray-700';
  }
}

function statusLabel(s: string): string {
  return s.replace('_', ' ');
}