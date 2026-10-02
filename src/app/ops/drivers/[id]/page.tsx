import { notFound } from 'next/navigation';
import { PageHeader, Card, CardTitle, Badge, Money, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getDriver, getLookups } from '@/lib/queries';
import {
  getAgreementsForDriver, getCertificatesForDriver, getChargesForDriver, getPaymentsForDriver,
} from '@/lib/queries-ops';
import {
  formatDate, daysUntil, titleCase, driverStatusTone, agreementStatusTone, chargeStatusTone,
} from '@/lib/display';
import { listDriverNotifications } from '@/lib/comms';
import { messageDriverAction } from '@/lib/actions/comms';
import { getAuthContext } from '@/lib/auth/context';
import { listDriverDocuments } from '@/lib/driver-documents';
import { DriverDocuments } from '@/components/DriverDocuments';
import { deleteDriverDocumentAction, uploadDriverDocumentAction } from '@/lib/actions/driver-documents';

export const dynamic = 'force-dynamic';

const certTone = (s: string) =>
  ({ verified: 'profit', pending: 'warn', rejected: 'loss', expired: 'loss' }[s] as
    'profit' | 'warn' | 'loss' | undefined) ?? 'neutral';

function Spec({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-t border-hair-soft py-2.5 first:border-t-0">
      <p className="eyebrow text-parchment">{label}</p>
      <p className="mt-1 text-sm text-cream">{value}</p>
    </div>
  );
}

export default async function DriverDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const driver = await getDriver(id);
  if (!driver) notFound();

  const ctx = await getAuthContext();
  const [agreements, certs, charges, payments, lookups, notifications, documents] = await Promise.all([
    getAgreementsForDriver(id),
    getCertificatesForDriver(id),
    getChargesForDriver(id),
    getPaymentsForDriver(id),
    getLookups(),
    ctx?.tenantId ? listDriverNotifications(ctx.tenantId, id) : Promise.resolve([]),
    ctx?.tenantId ? listDriverDocuments(ctx.tenantId, id) : Promise.resolve([]),
  ]);

  const exp = daysUntil(driver.pco_licence_expiry);

  return (
    <>
      <PageHeader
        eyebrow="Drivers · Driver"
        title={driver.full_name}
        subtitle={driver.email ?? undefined}
        actions={<Button href="/ops/drivers" variant="ghost" size="sm"><Icon name="chevron" className="h-4 w-4 rotate-180" /> Drivers</Button>}
      />

      <section className="mt-4">
        <DriverDocuments
          documents={documents}
          driverId={id}
          uploadAction={uploadDriverDocumentAction}
          deleteAction={deleteDriverDocumentAction}
          intro="Every document for this driver in one place. A PCO licence or DVLA check added here also updates the driver's licence fields, so compliance reminders pick it up automatically."
        />
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Message driver</CardTitle>
          <form action={messageDriverAction} className="mt-3 space-y-2">
            <input type="hidden" name="driver_id" value={id} />
            <input
              name="subject"
              required
              placeholder="Subject"
              aria-label="Message subject"
              className="w-full rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none"
            />
            <textarea
              name="body"
              required
              rows={3}
              placeholder="Your message — sent by email and SMS where we have them."
              aria-label="Message body"
              className="w-full rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none"
            />
            <Button type="submit" variant="primary" size="sm"><Icon name="bell" className="h-4 w-4" /> Send</Button>
          </form>
        </Card>
        <Card>
          <CardTitle>Recent messages</CardTitle>
          {notifications.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No messages sent yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {notifications.map((n) => (
                <li key={n.id} className="flex items-center justify-between gap-2 border-t border-hair-soft pt-2 first:border-t-0 first:pt-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-cream">{n.subject ?? '—'}</p>
                    <p className="text-xs text-muted">{n.channel} · {n.recipient ?? '—'} · {formatDate(n.created_at)}</p>
                  </div>
                  <Badge tone={n.status === 'sent' ? 'profit' : n.status === 'failed' ? 'loss' : 'neutral'}>{n.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>Contact</CardTitle>
          <div className="mt-3">
            <Spec label="Status" value={<Badge tone={driverStatusTone(driver.status)}>{titleCase(driver.status)}</Badge>} />
            <Spec label="Email" value={driver.email ?? '—'} />
            <Spec label="Phone" value={driver.phone ?? '—'} />
          </div>
        </Card>

        <Card>
          <CardTitle>Licensing</CardTitle>
          <div className="mt-3">
            <Spec label="PCO licence no." value={driver.pco_licence_no ?? '—'} />
            <Spec
              label="PCO expiry"
              value={
                <span className="inline-flex items-center gap-2">
                  {formatDate(driver.pco_licence_expiry)}
                  {exp !== null && exp < 30 && (
                    <Badge tone={exp < 0 ? 'loss' : 'warn'}>{exp < 0 ? `${Math.abs(exp)}d overdue` : `${exp}d`}</Badge>
                  )}
                </span>
              }
            />
            <Spec label="DVLA checked" value={formatDate(driver.dvla_checked_on)} />
          </div>
        </Card>

        <Card>
          <CardTitle>Insurance</CardTitle>
          {certs.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No certificates on file.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {certs.map((c) => {
                const cExp = daysUntil(c.cover_to);
                return (
                  <li key={c.id} className="rounded-[var(--radius)] border border-hair-soft px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm text-cream">{c.insurer}</p>
                      <Badge tone={certTone(c.status)}>{titleCase(c.status)}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {c.policy_no} · to {formatDate(c.cover_to)}
                      {cExp !== null && cExp < 30 && ` · ${cExp < 0 ? 'expired' : `${cExp}d left`}`}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      {/* Agreements */}
      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">Agreements</h2>
        {agreements.length === 0 ? (
          <EmptyState title="No agreements" />
        ) : (
          <Table caption="Agreements">
            <thead>
              <tr><Th>Type</Th><Th>Vehicle</Th><Th>Status</Th><Th className="text-right">Weekly (net)</Th><Th>Start</Th><Th>{''}</Th></tr>
            </thead>
            <tbody>
              {agreements.map((a) => (
                <tr key={a.id}>
                  <Td className="text-cream">{a.type === 'rtb' ? 'Rent-to-Buy' : 'Standard'}</Td>
                  <Td>{lookups.vehicleById.get(a.vehicle_id)?.registration ?? '—'}</Td>
                  <Td><Badge tone={agreementStatusTone(a.status)}>{titleCase(a.status)}</Badge></Td>
                  <Td className="text-right"><Money pence={a.weekly_net_pence} /></Td>
                  <Td>{formatDate(a.start_date)}</Td>
                  <Td className="text-right"><Button href={`/ops/agreements/${a.id}`} variant="ghost" size="sm">View</Button></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Charges */}
        <div>
          <h2 className="mb-3 font-display text-xl text-cream">Charges</h2>
          {charges.length === 0 ? (
            <EmptyState title="No charges" />
          ) : (
            <Table caption="Charges">
              <thead>
                <tr><Th>Date</Th><Th>Type</Th><Th className="text-right">Amount</Th><Th>Status</Th></tr>
              </thead>
              <tbody>
                {charges.map((c) => (
                  <tr key={c.id}>
                    <Td>{formatDate(c.received_on)}</Td>
                    <Td className="text-cream">{c.type.toUpperCase()}</Td>
                    <Td className="text-right"><Money pence={c.amount_pence} /></Td>
                    <Td><Badge tone={chargeStatusTone(c.status)}>{titleCase(c.status)}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>

        {/* Payments */}
        <div>
          <h2 className="mb-3 font-display text-xl text-cream">Payment history</h2>
          {payments.length === 0 ? (
            <EmptyState title="No payments" />
          ) : (
            <Table caption="Payment history">
              <thead>
                <tr><Th>Date</Th><Th>Source</Th><Th>Status</Th><Th className="text-right">Amount</Th></tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <Td>{formatDate(p.received_on)}</Td>
                    <Td className="text-cream">{titleCase(p.source)}</Td>
                    <Td><Badge tone={p.status === 'confirmed' ? 'profit' : p.status === 'failed' ? 'loss' : 'warn'}>{titleCase(p.status)}</Badge></Td>
                    <Td className="text-right"><Money pence={p.amount_pence} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </section>
    </>
  );
}
