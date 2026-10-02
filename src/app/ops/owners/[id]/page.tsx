import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader, Card, CardTitle, Button, Badge, Table, Th, Td } from '@/components/ui';
import { requireTenantContext } from '@/lib/auth/context';
import { getOwner } from '@/lib/owners';
import { createClient } from '@/lib/supabase/server';
import { listRecentAlerts } from '@/lib/alerts/query';
import { ALERT_LABEL } from '@/lib/alerts/messages';
import { relativeTime } from '@/lib/display';
import { REQUEST_KINDS, REQUEST_LABEL } from '@/lib/requests';
import { raiseStaffRequestAction } from '@/lib/actions/requests';
import {
  attachVehicleAction,
  detachAccountAction,
  detachVehicleAction,
  resendInviteAction,
  updateOwnerAction,
} from '@/lib/actions/owners';

export const dynamic = 'force-dynamic';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export default async function OwnerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenantContext();
  const owner = await getOwner(ctx.tenantId, id);
  if (!owner) notFound();

  // Vehicles nobody owns yet, for the attach picker (RLS-scoped to this tenant).
  const sb = await createClient();
  const [{ data: unowned }, alerts] = await Promise.all([
    sb.from('vehicles').select('id, registration, make, model').is('owner_id', null).order('registration'),
    listRecentAlerts(ctx.tenantId, { ownerId: id, limit: 20 }),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Owner"
        title={owner.name}
        subtitle={`${owner.phone}${owner.email ? ` · ${owner.email}` : ''}`}
        actions={
          <Button href="/ops/owners" variant="ghost" size="sm">
            All owners
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Vehicles</CardTitle>
          {owner.vehicles.length === 0 ? (
            <p className="text-sm text-muted">No vehicles attached yet.</p>
          ) : (
            <Table caption={`Vehicles owned by ${owner.name}`}>
              <thead>
                <tr>
                  <Th>Registration</Th>
                  <Th>Vehicle</Th>
                  <Th>{''}</Th>
                </tr>
              </thead>
              <tbody>
                {owner.vehicles.map((v) => (
                  <tr key={v.id}>
                    <Td className="font-display text-cream">
                      <Link href={`/ops/fleet/${v.id}`} className="hover:text-gold-bright">
                        {v.registration}
                      </Link>
                    </Td>
                    <Td>
                      {v.make} {v.model}
                    </Td>
                    <Td className="text-right">
                      <form action={detachVehicleAction}>
                        <input type="hidden" name="owner_id" value={owner.id} />
                        <input type="hidden" name="vehicle_id" value={v.id} />
                        <Button type="submit" variant="ghost" size="sm" aria-label={`Detach ${v.registration}`}>
                          Detach
                        </Button>
                      </form>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {(unowned ?? []).length > 0 && (
            <form action={attachVehicleAction} className="mt-4 flex items-end gap-2">
              <input type="hidden" name="owner_id" value={owner.id} />
              <label className="block grow">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">Attach a vehicle</span>
                <select name="vehicle_id" required className={`${inputCls} w-full`}>
                  {(unowned ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.registration} · {v.make} {v.model}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" variant="outline" size="sm">
                Attach
              </Button>
            </form>
          )}
        </Card>

        <Card>
          <CardTitle>Account</CardTitle>
          {owner.user_id ? (
            <>
              <p className="text-sm text-parchment">
                <Badge tone="profit">signed in</Badge> This owner has an account linked to {owner.phone}.
              </p>
              <form action={detachAccountAction} className="mt-3">
                <input type="hidden" name="owner_id" value={owner.id} />
                <Button type="submit" variant="ghost" size="sm">
                  Detach account
                </Button>
                <p className="mt-1 text-[11px] text-muted">
                  Use this when the number has changed hands. The vehicles stay attached; the next sign-in with this number creates a fresh account.
                </p>
              </form>
            </>
          ) : (
            <>
              <p className="text-sm text-muted">Not signed in yet. They sign in at the login page with their mobile number.</p>
              {owner.vehicles[0] && (
                <form action={resendInviteAction} className="mt-3">
                  <input type="hidden" name="owner_id" value={owner.id} />
                  <input type="hidden" name="vehicle_id" value={owner.vehicles[0].id} />
                  <Button type="submit" variant="outline" size="sm">
                    Send sign-in SMS
                  </Button>
                  <p className="mt-1 text-[11px] text-muted">At most one message a week.</p>
                </form>
              )}
            </>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <CardTitle>Recent alerts</CardTitle>
        {alerts.length === 0 ? (
          <p className="text-sm text-muted">Nothing raised for this owner's vehicles yet.</p>
        ) : (
          <ul className="divide-y divide-hair">
            {alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                <span>
                  <Badge tone={a.severity === 'critical' ? 'loss' : a.severity === 'warning' ? 'warn' : 'neutral'}>{ALERT_LABEL[a.kind]}</Badge>{' '}
                  <span className="text-cream">{a.vehicle.registration}</span>
                </span>
                <span className="text-xs text-muted">
                  {relativeTime(a.occurred_at)}
                  {a.acknowledged_at ? ' · acknowledged' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-4 max-w-2xl">
        <CardTitle>Ask our team for help</CardTitle>
        <p className="mb-3 text-sm text-muted">
          Raise a request to the platform team on this owner&apos;s behalf. A stolen-vehicle or immobilise request pages the on-call team immediately.
          <Link href={`/ops/owners/${owner.id}/reports`} className="ml-2 text-gold-bright hover:underline">
            Protection reports →
          </Link>
        </p>
        <form action={raiseStaffRequestAction} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <input type="hidden" name="owner_id" value={owner.id} />
          <Field label="What">
            <select name="kind" required className={`${inputCls} w-full`}>
              {REQUEST_KINDS.map((k) => (
                <option key={k} value={k}>
                  {REQUEST_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Vehicle">
            <select name="vehicle_id" className={`${inputCls} w-full`}>
              <option value="">—</option>
              {owner.vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.registration}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note">
            <input name="note" className={`${inputCls} w-full`} />
          </Field>
          <div className="sm:col-span-3">
            <Button type="submit" variant="outline" size="sm">
              Raise request
            </Button>
          </div>
        </form>
      </Card>

      <Card className="mt-4 max-w-2xl">
        <CardTitle>Details and alert settings</CardTitle>
        <form action={updateOwnerAction} className="space-y-3">
          <input type="hidden" name="id" value={owner.id} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Full name">
              <input name="name" defaultValue={owner.name} required className={`${inputCls} w-full`} />
            </Field>
            <Field label="Email">
              <input name="email" type="email" defaultValue={owner.email ?? ''} className={`${inputCls} w-full`} />
            </Field>
            <Field label="National ID">
              <input name="nin" defaultValue={owner.nin ?? ''} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Night from">
              <input name="night_from" type="time" defaultValue={owner.night_from.slice(0, 5)} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Night to">
              <input name="night_to" type="time" defaultValue={owner.night_to.slice(0, 5)} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Timezone">
              <input name="timezone" defaultValue={owner.timezone} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Speed limit (km/h)">
              <input name="speed_limit_kph" type="number" min="30" max="250" defaultValue={owner.speed_limit_kph} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Offline after (hours)">
              <input name="offline_after_h" type="number" min="1" max="168" defaultValue={owner.offline_after_h} className={`${inputCls} w-full`} />
            </Field>
            <label className="flex items-center gap-1.5 self-end text-xs text-parchment">
              <input type="checkbox" name="alerts_sms" defaultChecked={owner.alerts_sms} /> Alerts by SMS
            </label>
          </div>
          <Button type="submit" variant="primary" size="sm">
            Save
          </Button>
        </form>
      </Card>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">{label}</span>
      {children}
    </label>
  );
}
