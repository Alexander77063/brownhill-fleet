import Link from 'next/link';
import { PageHeader, Card, CardTitle, Badge, EmptyState } from '@/components/ui';
import { myVehicles } from '@/lib/owner-portal';
import { relativeTime } from '@/lib/display';
import { deploymentProfile } from '@/lib/deployment/profile';
import { getAuthContext } from '@/lib/auth/context';
import { vehiclesAwaitingPayment } from '@/lib/collection/invoices';
import { payFirst } from '@/lib/region';

export const dynamic = 'force-dynamic';

export default async function OwnerHome() {
  const vehicles = await myVehicles();
  // NG-2: a vehicle whose addition invoice is unpaid is not protected yet.
  const ctx = payFirst() ? await getAuthContext() : null;
  const awaiting = ctx?.tenantId ? await vehiclesAwaitingPayment(ctx.tenantId).catch(() => new Set<string>()) : new Set<string>();
  // On the shared instance the owner IS their tenant, so they add their own cars.
  const canAdd = deploymentProfile().selfServeSignup;
  return (
    <>
      <PageHeader
        eyebrow="Your vehicles"
        title={vehicles.length === 1 ? 'Your vehicle' : 'Your vehicles'}
        subtitle="Where each one is, and when it last moved."
      />
      {vehicles.length === 0 ? (
        <EmptyState
          title="No vehicles yet"
          hint={canAdd ? 'Add your first vehicle to start protecting it.' : 'Your insurer or fleet will add your vehicle here.'}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {vehicles.map((v) => (
            <Card key={v.id}>
              <div className="flex items-baseline justify-between gap-2">
                <CardTitle>{v.registration}</CardTitle>
                {awaiting.has(v.id) ? (
                  <Link href="/owner/billing">
                    <Badge tone="warn">awaiting payment</Badge>
                  </Link>
                ) : (
                  <Badge>{v.status.replace('_', ' ')}</Badge>
                )}
              </div>
              <p className="text-sm text-parchment">
                {v.make} {v.model}
                {v.colour ? ` · ${v.colour}` : ''}
              </p>
              <p className="mt-2 text-sm text-muted">
                {v.lastSeenAt ? <>Last moved {relativeTime(v.lastSeenAt)}</> : 'Not yet seen — the tracker has not reported.'}
              </p>
              {v.lat != null && v.lng != null && (
                <a
                  className="mt-1 inline-block text-sm text-gold-bright hover:underline"
                  href={`https://maps.google.com/?q=${v.lat},${v.lng}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open location in Maps
                </a>
              )}
              <Link href={`/owner/vehicles/${v.id}`} className="mt-3 inline-block text-sm text-gold-bright hover:underline">
                Details →
              </Link>
            </Card>
          ))}
        </div>
      )}
      {canAdd && (
        <p className="mt-6">
          <Link href="/owner/add-vehicle" className="text-gold-bright hover:underline">
            + Add a vehicle
          </Link>
        </p>
      )}
    </>
  );
}
