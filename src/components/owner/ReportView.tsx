import { Card, CardTitle, Badge, Stat } from '@/components/ui';
import type { OwnerReportData } from '@/lib/owner-report';
import { periodLabel } from '@/lib/owner-report-run';
import { ALERT_LABEL } from '@/lib/alerts/messages';
import type { AlertKind } from '@/lib/alerts/messages';
import { formatDate } from '@/lib/display';

const DOC_TONE: Record<string, 'profit' | 'warn' | 'loss' | 'neutral'> = {
  valid: 'profit',
  recorded: 'profit',
  due_soon: 'warn',
  expired: 'loss',
  missing: 'neutral',
  elsewhere: 'neutral',
};
/** "2 h 30 min" — hours floored, so the two parts never disagree. */
function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

const DOC_TEXT: Record<string, string> = {
  valid: 'Valid',
  recorded: 'Recorded',
  due_soon: 'Due soon',
  expired: 'Expired',
  missing: 'Not recorded',
  elsewhere: 'Held elsewhere',
};

/**
 * The Vehicle Protection Report, rendered ONLY from the stored snapshot so the
 * page an owner opens in March shows the numbers they were sent in March.
 * Shared by the owner portal and the insurer's roll-up; print styles make
 * "save as PDF" a clean one-pager.
 */
export function ReportView({ data, printable = true }: { data: OwnerReportData; printable?: boolean }) {
  return (
    <article className="space-y-4 print:space-y-3">
      {printable && (
        <style>{`@media print { nav, header, aside, .no-print { display: none !important; } body { background: #fff; color: #111; } }`}</style>
      )}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Distance" value={`${data.totals.distanceKm} km`} />
        <Stat label="Trips" value={data.totals.trips} />
        <Stat label="Alerts" value={data.totals.alerts} tone={data.totals.alerts > 0 ? 'warn' : 'profit'} />
        <Stat
          label="Documents"
          value={data.totals.expiredDocs > 0 ? `${data.totals.expiredDocs} expired` : data.totals.dueSoonDocs > 0 ? `${data.totals.dueSoonDocs} due soon` : 'All in date'}
          tone={data.totals.expiredDocs > 0 ? 'loss' : data.totals.dueSoonDocs > 0 ? 'warn' : 'profit'}
        />
      </section>

      {data.vehicles.map((v) => (
        <Card key={v.id}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>{v.registration}</CardTitle>
            <span className="text-sm text-muted">
              {v.make} {v.model}
            </span>
          </div>

          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <dt className="text-muted">Distance</dt>
            <dd className="text-cream sm:col-span-2">{v.distanceKm} km over {v.trips} trip{v.trips === 1 ? '' : 's'}</dd>
            <dt className="text-muted">Time moving</dt>
            <dd className="text-cream sm:col-span-2">{duration(v.movingMinutes)}</dd>
            <dt className="text-muted">Tracker</dt>
            <dd className="text-cream sm:col-span-2">
              {v.device.kind ? (
                <>
                  {v.device.kind === 'hardware' ? 'Fitted tracker' : 'Phone tracking'} · {v.device.pings.toLocaleString()} reports · longest silence{' '}
                  {duration(v.device.longestGapMinutes)} ·{' '}
                  <Badge tone={v.device.status === 'online' ? 'profit' : v.device.status === 'offline' ? 'loss' : 'neutral'}>{v.device.status}</Badge>
                </>
              ) : (
                'No tracker'
              )}
            </dd>
            {v.serviceDueMiles != null && (
              <>
                <dt className="text-muted">Next service</dt>
                <dd className="text-cream sm:col-span-2">at {v.serviceDueMiles.toLocaleString()} miles</dd>
              </>
            )}
          </dl>

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-parchment">Alerts</h3>
          {v.alerts.total === 0 ? (
            <p className="text-sm text-muted">None this month.</p>
          ) : (
            <p className="text-sm text-parchment">
              {Object.entries(v.alerts.byKind)
                .map(([k, n]) => `${n} × ${ALERT_LABEL[k as AlertKind].toLowerCase()}`)
                .join(', ')}
              .
            </p>
          )}

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-parchment">Documents and renewals</h3>
          <ul className="divide-y divide-hair">
            {v.compliance.map((c) => (
              <li key={c.key} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5 text-sm">
                <span className="text-cream">{c.label}</span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {c.expiresOn ? formatDate(c.expiresOn) : c.mandatory ? 'Required' : 'Optional'}
                  <Badge tone={DOC_TONE[c.status] ?? 'neutral'}>{DOC_TEXT[c.status] ?? c.status}</Badge>
                </span>
              </li>
            ))}
          </ul>

          {v.fuel && (
            <>
              <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-parchment">Fuel</h3>
              <p className="text-sm text-parchment">
                {v.fuel.fills} fill{v.fuel.fills === 1 ? '' : 's'}, {v.fuel.litres} litres
                {v.fuel.kmPerLitre != null ? `, about ${v.fuel.kmPerLitre} km per litre` : ''}
                {v.fuel.anomalies > 0 ? ` — ${v.fuel.anomalies} unusual fill${v.fuel.anomalies === 1 ? '' : 's'} flagged` : ''}.
              </p>
            </>
          )}
        </Card>
      ))}

      <p className="text-xs text-muted">
        {periodLabel(data.period)} (measured in UTC) · prepared {formatDate(data.generatedAt.slice(0, 10))} for {data.owner.name}. Figures are as recorded at that time.
      </p>
    </article>
  );
}
