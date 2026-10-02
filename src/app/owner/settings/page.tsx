import { PageHeader, Card, CardTitle, Button, EmptyState } from '@/components/ui';
import { PushOptIn } from '@/components/PushOptIn';
import { mySettings } from '@/lib/owner-portal';
import { updateMySettingsAction } from '@/lib/actions/owner-portal';
import { hasEntitlement } from '@/lib/entitlements';

export const dynamic = 'force-dynamic';

const inputCls =
  'w-full rounded-md border border-hair bg-[var(--surface)] px-3 py-2.5 text-base text-cream focus:border-gold-bright focus:outline-none';

export default async function OwnerSettingsPage() {
  const [s, pushTier] = await Promise.all([mySettings(), hasEntitlement('notifications.push')]);
  if (!s) {
    return (
      <>
        <PageHeader eyebrow="Settings" title="Your details" />
        <EmptyState title="No owner record linked" hint="Contact your insurer or fleet." />
      </>
    );
  }
  return (
    <>
      <PageHeader eyebrow="Settings" title="Your details" subtitle="Who you are, and when we should alert you." />
      <Card className="max-w-xl">
        <CardTitle>Contact</CardTitle>
        <form action={updateMySettingsAction} className="space-y-4">
          <Field label="Your name">
            <input name="name" defaultValue={s.name} required className={inputCls} />
          </Field>
          <Field label="Mobile number" hint="You sign in with this number. Ask your insurer or fleet to change it.">
            <input value={s.phone} readOnly aria-readonly className={`${inputCls} text-muted`} />
          </Field>
          <Field label="Email (optional)" hint="Reports are also emailed here if you give one.">
            <input name="email" type="email" defaultValue={s.email ?? ''} className={inputCls} />
          </Field>

          <h3 className="pt-2 text-xs font-semibold uppercase tracking-wider text-parchment">Alerts</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Night starts">
              <input name="night_from" type="time" defaultValue={s.night_from.slice(0, 5)} className={inputCls} />
            </Field>
            <Field label="Night ends">
              <input name="night_to" type="time" defaultValue={s.night_to.slice(0, 5)} className={inputCls} />
            </Field>
            <Field label="Speed limit (km/h)">
              <input name="speed_limit_kph" type="number" inputMode="numeric" min="30" max="250" defaultValue={s.speed_limit_kph} className={inputCls} />
            </Field>
            <Field label="Tracker silent for (hours)">
              <input name="offline_after_h" type="number" inputMode="numeric" min="1" max="168" defaultValue={s.offline_after_h} className={inputCls} />
            </Field>
          </div>
          <Field label="Timezone">
            <input name="timezone" defaultValue={s.timezone} className={inputCls} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-parchment">
            <input type="checkbox" name="alerts_sms" defaultChecked={s.alerts_sms} className="h-5 w-5" /> Send me alerts by text message
          </label>
          <Button type="submit" variant="primary" className="w-full sm:w-auto">
            Save
          </Button>
        </form>
      </Card>
      <Card className="mt-6 max-w-xl">
        <CardTitle className="mb-3">Alerts on this phone</CardTitle>
        <PushOptIn available={pushTier} />
      </Card>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}
