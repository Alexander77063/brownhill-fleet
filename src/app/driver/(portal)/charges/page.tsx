import { PageHeader, Card, Badge, Money, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getSessionProfile } from '@/lib/auth';
import { getCharges } from '@/lib/queries';
import { formatDate, titleCase, chargeStatusTone } from '@/lib/display';
import { DisputeButton } from './DisputeButton';

export const dynamic = 'force-dynamic';

const DISPUTABLE = new Set(['received', 'driver_notified']);

export default async function DriverCharges() {
  const p = await getSessionProfile();
  if (!p?.driverId) {
    return (
      <>
        <PageHeader eyebrow="Pass-through" title="Charges" />
        <EmptyState title="No active agreement linked to your account" />
      </>
    );
  }

  // RLS scopes charges to the signed-in driver automatically.
  const charges = await getCharges();
  const outstanding = charges
    .filter((c) => ['received', 'driver_notified', 'driver_liable', 'disputed'].includes(c.status))
    .reduce((s, c) => s + c.amount_pence, 0);

  return (
    <>
      <PageHeader
        eyebrow="Pass-through"
        title="Charges"
        subtitle="PCNs, congestion, ULEZ, Dartford and tolls incurred while you held the vehicle."
      />

      {/* Liability note */}
      <Card className="reveal mb-4 border-[var(--color-warn)]/40">
        <div className="flex items-start gap-3">
          <span className="text-[var(--color-warn)]"><Icon name="alert" /></span>
          <div>
            <p className="text-sm text-cream">You are liable for these charges</p>
            <p className="mt-1 text-sm text-muted">
              Under your hire agreement, all road-use charges incurred in the vehicle are your responsibility. You must
              report any incident within <span className="text-parchment">48 hours</span>. If you believe a charge is
              wrong, raise a dispute and ops will challenge it with the issuing authority.
            </p>
          </div>
        </div>
      </Card>

      <section className="mb-4 grid grid-cols-2 gap-3 sm:gap-4">
        <Card className="reveal">
          <p className="eyebrow text-parchment">Outstanding charges</p>
          <p className="mt-2 font-display text-3xl tnum text-[var(--color-loss)]"><Money pence={outstanding} /></p>
        </Card>
        <Card className="reveal">
          <p className="eyebrow text-parchment">Total this year</p>
          <p className="mt-2 font-display text-3xl tnum text-cream">{charges.length}</p>
          <p className="text-xs text-muted">recorded charges</p>
        </Card>
      </section>

      {charges.length === 0 ? (
        <EmptyState title="No charges on record" hint="Keep it that way — drive carefully and mind the zones." />
      ) : (
        <Table caption="Your charges">
          <thead>
            <tr>
              <Th>Type</Th><Th>Authority</Th><Th>Received</Th><Th>Amount</Th><Th>Status</Th><Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {charges.map((c) => (
              <tr key={c.id}>
                <Td className="text-cream">{titleCase(c.type)}</Td>
                <Td>{c.authority ?? '—'}</Td>
                <Td>{formatDate(c.received_on)}</Td>
                <Td><Money pence={c.amount_pence} /></Td>
                <Td><Badge tone={chargeStatusTone(c.status)}>{titleCase(c.status)}</Badge></Td>
                <Td>{DISPUTABLE.has(c.status) ? <DisputeButton id={c.id} /> : <span className="text-muted">—</span>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
