import { notFound } from 'next/navigation';
import { PageHeader, Card, CardTitle, Badge, Button } from '@/components/ui';
import { myVehicle } from '@/lib/owner-portal';
import { formatDate, relativeTime } from '@/lib/display';
import { raiseOwnerRequestAction } from '@/lib/actions/requests';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, { text: string; tone: 'profit' | 'warn' | 'loss' | 'neutral' }> = {
  valid: { text: 'Valid', tone: 'profit' },
  recorded: { text: 'Recorded', tone: 'profit' },
  due_soon: { text: 'Due soon', tone: 'warn' },
  expired: { text: 'Expired', tone: 'loss' },
  missing: { text: 'Not recorded', tone: 'neutral' },
  elsewhere: { text: 'Held elsewhere', tone: 'neutral' },
};

export default async function OwnerVehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await myVehicle(id);
  if (!v) notFound();

  return (
    <>
      <PageHeader
        eyebrow="Your vehicle"
        title={v.registration}
        subtitle={`${v.make} ${v.model}${v.colour ? ` · ${v.colour}` : ''}`}
        actions={
          <Button href="/owner" variant="ghost" size="sm">
            All vehicles
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Where it is</CardTitle>
          {v.lastSeenAt ? (
            <>
              <p className="text-sm text-parchment">Last moved {relativeTime(v.lastSeenAt)}.</p>
              {v.lat != null && v.lng != null && (
                <a
                  className="mt-2 inline-block text-sm text-gold-bright hover:underline"
                  href={`https://maps.google.com/?q=${v.lat},${v.lng}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open location in Maps
                </a>
              )}
              {v.last24h && (
                <p className="mt-3 text-sm text-muted">
                  Last 24 hours: about {v.last24h.distanceKm} km.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">The tracker has not reported yet.</p>
          )}
        </Card>

        <Card>
          <CardTitle>Tracker</CardTitle>
          {v.device ? (
            <>
              <p className="text-sm text-parchment">
                {v.device.kind === 'hardware' ? 'Fitted tracker' : 'Phone tracking'} ·{' '}
                {v.device.active ? <Badge tone="profit">active</Badge> : <Badge tone="warn">paused</Badge>}
              </p>
              {v.device.kind === 'hardware' && (
                <p className="mt-1 text-xs text-muted">
                  {v.device.fittedAt ? `Fitted ${formatDate(v.device.fittedAt.slice(0, 10))}` : 'Fitting pending'}
                  {v.device.warrantyUntil ? ` · warranty until ${formatDate(v.device.warrantyUntil)}` : ''}
                  {v.device.fittedAt && !v.device.firstPingAt ? ' · not reporting yet' : ''}
                </p>
              )}
              {v.device.kind === 'hardware' && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-gold-bright">Report a problem with the tracker</summary>
                  <form action={raiseOwnerRequestAction} className="mt-2 space-y-2">
                    <input type="hidden" name="kind" value="device_fault" />
                    <input type="hidden" name="vehicle_id" value={v.id} />
                    <label className="block">
                      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">What is wrong?</span>
                      <textarea
                        name="note"
                        required
                        rows={3}
                        className="w-full rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none"
                        placeholder="e.g. the app has not shown the car move for two days"
                      />
                    </label>
                    <Button type="submit" size="sm" variant="outline">
                      Send to support
                    </Button>
                    <p className="text-xs text-muted">We will check the unit remotely and book a visit if it needs one. Repairs within the warranty are free.</p>
                  </form>
                </details>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">No tracker is set up for this vehicle yet.</p>
          )}
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-parchment">Immobilisation</h3>
          <p className="mt-1 text-sm text-muted">
            {v.immobilisation.requested === 'immobilise'
              ? `Engine cut ${v.immobilisation.status ?? 'requested'} ${v.immobilisation.at ? relativeTime(v.immobilisation.at) : ''}.`
              : 'Not immobilised.'}{' '}
            {v.immobilisation.hardwareConnected
              ? 'Only our on-call team can send an engine command, after speaking to you, and only while the car is stopped. Ask for it from Help.'
              : 'This vehicle does not have an immobiliser relay fitted.'}
          </p>
        </Card>
      </div>

      <Card className="mt-4">
        <CardTitle>Documents and renewals</CardTitle>
        <ul className="divide-y divide-hair">
          {v.compliance.map((c) => {
            const s = STATUS_LABEL[c.status] ?? STATUS_LABEL.missing;
            return (
              <li key={c.key} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <div>
                  <p className="text-sm text-cream">{c.label}</p>
                  <p className="text-xs text-muted">
                    {c.expiresOn
                      ? c.daysLeft != null && c.daysLeft < 0
                        ? `Expired ${formatDate(c.expiresOn)}`
                        : `Expires ${formatDate(c.expiresOn)}${c.daysLeft != null ? ` · ${c.daysLeft} days` : ''}`
                      : c.managedOn
                        ? `Kept on ${c.managedOn.label}`
                        : c.mandatory
                          ? 'Required'
                          : 'Optional'}
                  </p>
                </div>
                <Badge tone={s.tone}>{s.text}</Badge>
              </li>
            );
          })}
        </ul>
        {v.serviceDueMiles != null && (
          <p className="mt-3 text-sm text-muted">Next service due at {v.serviceDueMiles.toLocaleString()} miles.</p>
        )}
      </Card>
    </>
  );
}
