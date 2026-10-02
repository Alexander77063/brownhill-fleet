import Link from 'next/link';
import { PageHeader, Card, Badge, EmptyState } from '@/components/ui';
import { myAlerts, myVehicles } from '@/lib/owner-portal';
import { ALERT_LABEL, ALERT_MEANING, alertMessage } from '@/lib/alerts/messages';
import { hasEntitlement } from '@/lib/entitlements';
import { relativeTime } from '@/lib/display';
import { mySettings } from '@/lib/owner-portal';

export const dynamic = 'force-dynamic';

const TONE: Record<string, 'profit' | 'warn' | 'loss' | 'neutral'> = {
  info: 'neutral',
  warning: 'warn',
  critical: 'loss',
};

export default async function OwnerAlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ vehicle?: string }>;
}) {
  const { vehicle } = await searchParams;
  const [alerts, vehicles, settings, smsTier] = await Promise.all([
    myAlerts({ vehicleId: vehicle || undefined }),
    myVehicles(),
    mySettings(),
    hasEntitlement('notifications.sms'),
  ]);
  const tz = settings?.timezone ?? 'Africa/Lagos';

  return (
    <>
      <PageHeader
        eyebrow="Alerts"
        title="What happened"
        subtitle="Anything out of the ordinary with your vehicles, newest first."
      />

      {vehicles.length > 1 && (
        <nav aria-label="Filter by vehicle" className="mb-4 flex flex-wrap gap-2 text-sm">
          <Link href="/owner/alerts" className={vehicle ? 'text-muted hover:text-cream' : 'text-gold-bright'}>
            All
          </Link>
          {vehicles.map((v) => (
            <Link
              key={v.id}
              href={`/owner/alerts?vehicle=${v.id}`}
              className={vehicle === v.id ? 'text-gold-bright' : 'text-muted hover:text-cream'}
            >
              {v.registration}
            </Link>
          ))}
        </nav>
      )}

      {!smsTier && (
        <p className="mb-4 text-sm text-muted">
          You see alerts here. Get them by text message the moment they happen on Gold.
        </p>
      )}

      {alerts.length === 0 ? (
        <EmptyState title="Nothing to report" hint="When something happens with your vehicle, it appears here." />
      ) : (
        <ul className="space-y-3">
          {alerts.map((a) => (
            <li key={a.id}>
              <Card>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-display text-cream">
                    {ALERT_LABEL[a.kind]} · {a.vehicle.registration}
                  </p>
                  <Badge tone={TONE[a.severity] ?? 'neutral'}>{a.severity}</Badge>
                </div>
                <p className="mt-1 text-sm text-parchment">
                  {alertMessage({
                    kind: a.kind,
                    occurredAt: a.occurredAt,
                    timezone: tz,
                    vehicle: a.vehicle,
                    lat: a.lat,
                    lng: a.lng,
                    speedKph: a.speedKph,
                    detail: a.detail,
                  })}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {relativeTime(a.occurredAt)} · {ALERT_MEANING[a.kind]}
                </p>
                {a.lat != null && a.lng != null && (
                  <a
                    className="mt-1 inline-block text-xs text-gold-bright hover:underline"
                    href={`https://maps.google.com/?q=${a.lat},${a.lng}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Where this was
                  </a>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
