import { PageHeader } from '@/components/ui';
import { getVehicles } from '@/lib/queries';
import { RtbCalculator, type RtbVehicleOption } from '@/components/rtb/RtbCalculator';

export const dynamic = 'force-dynamic';

/**
 * The rent-to-buy calculator, on its own page.
 *
 * The same component is embedded in the "New agreement" form; here it is
 * free-standing, so a price can be worked out before any agreement exists.
 * Every figure is editable and nothing is written to the database — the
 * calculator answers questions, it does not create deals.
 */
export default async function RtbCalculatorPage() {
  const vehicles = await getVehicles();

  const options: RtbVehicleOption[] = vehicles.map((v) => ({
    id: v.id,
    registration: v.registration,
    list_value_pence: v.list_value_pence,
    residual_estimate_pence: v.residual_estimate_pence,
  }));

  return (
    <>
      <PageHeader
        eyebrow="Rent-to-buy"
        help="page.rtb"
        title="Rent-to-buy calculator"
        subtitle="Price a rent-to-buy deal, solve it backwards from the car, or check what it earns Brownhill. Nothing is saved here — the figures you settle on go into the agreement."
      />
      <RtbCalculator variant="standalone" vehicles={options} />
    </>
  );
}
