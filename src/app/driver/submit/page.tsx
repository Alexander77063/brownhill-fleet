import { PageHeader, Card, EmptyState } from '@/components/ui';
import { getSessionProfile } from '@/lib/auth';
import { listDriverSubmittableCategories, listDriverVehicles } from '@/lib/charges';
import { SubmitReceiptForm } from './SubmitReceiptForm';

export const dynamic = 'force-dynamic';

export default async function DriverSubmitPage() {
  const p = await getSessionProfile();
  if (!p?.driverId) {
    return (
      <>
        <PageHeader eyebrow="Submit" title="Submit a receipt" />
        <EmptyState title="No active driver account" hint="Ask your fleet team to finish setting you up." />
      </>
    );
  }

  const [categories, vehicles] = await Promise.all([
    listDriverSubmittableCategories(p.driverId),
    listDriverVehicles(p.driverId),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Submit"
        title="Receipts & charges"
        subtitle="Send tolls, congestion, PCNs, fuel and parking to the office — linked to your vehicle."
      />
      <Card className="mt-4 max-w-2xl">
        {categories.length === 0 ? (
          <EmptyState title="Nothing to submit yet" hint="Your fleet team hasn't enabled any driver categories." />
        ) : (
          <SubmitReceiptForm categories={categories} vehicles={vehicles} />
        )}
      </Card>
    </>
  );
}
