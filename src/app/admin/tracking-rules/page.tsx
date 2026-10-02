import { PageHeader, Card, CardTitle, Button, Badge, Table, Th, Td, EmptyState } from '@/components/ui';
import { contextCan, getAuthContext } from '@/lib/auth/context';
import { getTrackingRules, listPermittedZones } from '@/lib/tracking-rules';
import {
  saveTrackingRulesAction,
  addPermittedZoneAction,
  deactivatePermittedZoneAction,
} from '@/lib/actions/tracking-rules';

export const dynamic = 'force-dynamic';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export default async function TrackingRulesPage() {
  const ctx = await getAuthContext();
  if (!ctx || !ctx.tenantId || !contextCan(ctx, 'tenant.settings')) {
    return (
      <Wrap>
        <PageHeader eyebrow="Settings" title="Tracking rules" />
        <Card>
          <p className="text-sm text-muted">You don&apos;t have permission to manage tracking rules for this organisation.</p>
        </Card>
      </Wrap>
    );
  }
  const [rules, zones] = await Promise.all([getTrackingRules(ctx.tenantId), listPermittedZones(ctx.tenantId)]);

  return (
    <Wrap>
      <PageHeader
        eyebrow="Settings"
        title="Tracking rules"
        subtitle="Alert you (and the driver) when a vehicle is used in a way you haven't authorised. Every rule is off until you turn it on, so nothing fires as noise."
      />

      <Card>
        <CardTitle>Unauthorised-use alerts</CardTitle>
        <form action={saveTrackingRulesAction} className="mt-3 space-y-4">
          <label className="flex items-start gap-2 text-sm text-cream">
            <input type="checkbox" name="out_of_hours_enabled" value="1" defaultChecked={rules.out_of_hours_enabled} className="mt-1 accent-[var(--color-gold)]" />
            <span>
              <span className="font-semibold">Out-of-hours movement</span>
              <span className="block text-xs text-muted">Alert when a vehicle is driven outside your permitted hours.</span>
            </span>
          </label>
          {/* Stacks before `sm`: three time/text inputs plus the pl-6 indent do not fit
              in 320px (WCAG 1.4.10 Reflow). */}
          <div className="grid grid-cols-1 gap-2 pl-6 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-wider text-parchment">Allowed from</span>
              <input type="time" name="allowed_from" defaultValue={rules.allowed_from?.slice(0, 5) ?? ''} className={`${inputCls} w-full`} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-wider text-parchment">Allowed to</span>
              <input type="time" name="allowed_to" defaultValue={rules.allowed_to?.slice(0, 5) ?? ''} className={`${inputCls} w-full`} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-wider text-parchment">Timezone</span>
              <input type="text" name="timezone" defaultValue={rules.timezone} className={`${inputCls} w-full`} />
            </label>
          </div>

          <label className="flex items-start gap-2 text-sm text-cream">
            <input type="checkbox" name="no_booking_movement_enabled" value="1" defaultChecked={rules.no_booking_movement_enabled} className="mt-1 accent-[var(--color-gold)]" />
            <span>
              <span className="font-semibold">Movement with no booking</span>
              <span className="block text-xs text-muted">Alert when a vehicle moves with no active booking and no active agreement (an RTB/PCO car under an agreement is exempt).</span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm text-cream">
            <input type="checkbox" name="permitted_area_enabled" value="1" defaultChecked={rules.permitted_area_enabled} className="mt-1 accent-[var(--color-gold)]" />
            <span>
              <span className="font-semibold">Out-of-area movement</span>
              <span className="block text-xs text-muted">Alert when a vehicle is driven outside every permitted zone (defined below).</span>
            </span>
          </label>

          <Button type="submit" variant="primary" size="sm">Save rules</Button>
        </form>
      </Card>

      <Card className="mt-4">
        <CardTitle>Permitted zones</CardTitle>
        <p className="mt-1 text-xs text-muted">Circular areas your vehicles are expected to stay within. Used by the out-of-area rule.</p>
        {zones.length === 0 ? (
          <div className="mt-3"><EmptyState title="No zones yet" hint="Add one below to use the out-of-area alert." /></div>
        ) : (
          <div className="mt-3">
            <Table caption="Permitted zones">
              <thead>
                <tr><Th>Name</Th><Th>Centre</Th><Th className="text-right">Radius</Th><Th>Status</Th><Th>{''}</Th></tr>
              </thead>
              <tbody>
                {zones.map((z) => (
                  <tr key={z.id}>
                    <Td className="text-cream">{z.name}</Td>
                    <Td className="font-mono text-xs text-parchment">{z.lat.toFixed(4)}, {z.lng.toFixed(4)}</Td>
                    <Td className="text-right tnum">{(z.radius_m / 1000).toFixed(1)} km</Td>
                    <Td><Badge tone={z.is_active ? 'profit' : 'neutral'}>{z.is_active ? 'Active' : 'Off'}</Badge></Td>
                    <Td>
                      {z.is_active && (
                        <form action={deactivatePermittedZoneAction}>
                          <input type="hidden" name="zone_id" value={z.id} />
                          <Button type="submit" variant="ghost" size="sm">Remove</Button>
                        </form>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        <form action={addPermittedZoneAction} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <input name="name" required placeholder="Zone name" aria-label="Zone name" className={inputCls} />
          <input name="lat" required inputMode="decimal" placeholder="Latitude" aria-label="Latitude" className={inputCls} />
          <input name="lng" required inputMode="decimal" placeholder="Longitude" aria-label="Longitude" className={inputCls} />
          <input name="radius_m" inputMode="numeric" placeholder="Radius (m, default 5000)" aria-label="Radius in metres" className={inputCls} />
          <Button type="submit" variant="outline" size="sm" className="sm:col-span-4">Add zone</Button>
        </form>
      </Card>
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</div>;
}
