import { notFound } from 'next/navigation';
import { PageHeader, Card, CardTitle, Button } from '@/components/ui';
import { deploymentProfile } from '@/lib/deployment/profile';
import { addMyVehicleAction } from '@/lib/actions/owner-portal';

export const dynamic = 'force-dynamic';

const inputCls =
  'w-full rounded-md border border-hair bg-[var(--surface)] px-3 py-2.5 text-base text-cream focus:border-gold-bright focus:outline-none';

export default function AddVehiclePage() {
  // Only where the owner is their own tenant. Elsewhere the insurer or fleet
  // adds vehicles, and this page does not exist.
  if (!deploymentProfile().selfServeSignup) notFound();
  return (
    <>
      <PageHeader eyebrow="Add a vehicle" title="Tell us about your car" subtitle="We only need the registration to start; the rest helps us recognise it." />
      <Card className="max-w-xl">
        <CardTitle>Vehicle</CardTitle>
        <form action={addMyVehicleAction} className="space-y-4">
          <Field label="Registration number">
            <input name="registration" required autoCapitalize="characters" placeholder="ABC 123 XY" className={inputCls} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Make">
              <input name="make" placeholder="Toyota" className={inputCls} />
            </Field>
            <Field label="Model">
              <input name="model" placeholder="Corolla" className={inputCls} />
            </Field>
            <Field label="Year">
              <input name="model_year" type="number" inputMode="numeric" min="1980" max="2100" className={inputCls} />
            </Field>
            <Field label="Colour">
              <input name="colour" className={inputCls} />
            </Field>
          </div>
          <Button type="submit" variant="primary" className="w-full sm:w-auto">
            Add vehicle
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
