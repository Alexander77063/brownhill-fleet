import Link from 'next/link';
import { PageHeader, Card, CardTitle, Stat, Badge, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { HelpHint } from '@/components/HelpHint';
import { getDrivers } from '@/lib/queries';
import { formatDate, daysUntil, titleCase, driverStatusTone } from '@/lib/display';
import { inviteDriverAction } from '@/lib/actions/driver-invite';
import { createInsuranceCertificate } from '@/lib/actions/ops';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export const dynamic = 'force-dynamic';

export default async function DriversPage() {
  const drivers = await getDrivers();
  const active = drivers.filter((d) => d.status === 'active').length;
  const vetting = drivers.filter((d) => d.status === 'vetting' || d.status === 'lead').length;

  return (
    <>
      <PageHeader
        eyebrow="Drivers"
        help="page.drivers"
        title="Driver register"
        subtitle="PCO licences, DVLA checks and vetting status across every driver. Expiring licences are flagged automatically."
      />

      {/* 2-up before `sm` — three across overflowed the page at 320px (WCAG 1.4.10). */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Stat label="Drivers" value={drivers.length} className="reveal" />
        <Stat label="Active" value={active} tone="profit" className="reveal" />
        <Stat label="In pipeline" value={vetting} tone="warn" className="reveal" />
      </section>

      <Card className="reveal mt-5">
        <div className="flex items-center gap-2">
          <CardTitle>Invite a driver</CardTitle>
          <HelpHint id="drivers.invite" label="Invite a driver" />
        </div>
        <form action={inviteDriverAction} className="mt-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Name</span>
            <input type="text" name="full_name" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Login email</span>
            <input type="email" name="email" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Phone</span>
            <input type="text" name="phone" className={inputCls} />
          </label>
          <Button type="submit" variant="primary" size="sm">Invite driver</Button>
        </form>
        <p className="mt-3 text-xs text-muted">
          Creates their driver login and links it to a new driver record. They&apos;ll get an email invite when email is
          configured; otherwise they can sign in at /login with this email using the &lsquo;Email link&rsquo; option.
        </p>
      </Card>

      <Card className="reveal mt-5">
        <CardTitle>Record insurance</CardTitle>
        <form action={createInsuranceCertificate} className="mt-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Driver</span>
            <select name="driver_id" required className={inputCls}>
              <option value="">Select driver…</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>{d.full_name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Insurer</span>
            <input type="text" name="insurer" required className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Policy number</span>
            <input type="text" name="policy_no" required className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Cover from</span>
            <input type="date" name="cover_from" required className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Cover to</span>
            <input type="date" name="cover_to" required className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Status</span>
            <select name="status" className={inputCls}>
              <option value="verified">Verified</option>
              <option value="pending">Pending</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
          <label className="flex items-center gap-2 py-1.5">
            <input type="checkbox" name="company_interested_party" />
            <span className="text-sm text-cream">Company is an interested party</span>
          </label>
          <Button type="submit" variant="primary" size="sm">Record insurance</Button>
        </form>
        <p className="mt-3 text-xs text-muted">
          Ops-recorded certificate. Drivers can also upload their own from the driver portal.
        </p>
      </Card>

      <section className="mt-5">
        {drivers.length === 0 ? (
          <EmptyState title="No drivers yet" hint="Add your first driver to begin vetting." />
        ) : (
          <Table caption="Drivers">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>PCO licence</Th>
                <Th>PCO expiry</Th>
                <Th>DVLA checked</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => {
                const exp = daysUntil(d.pco_licence_expiry);
                const expiring = exp !== null && exp < 30;
                return (
                  <tr key={d.id} className="group transition-colors hover:bg-[var(--surface-soft)]">
                    <Td className="font-display text-cream">
                      <Link href={`/ops/drivers/${d.id}`} className="hover:text-gold-bright">{d.full_name}</Link>
                    </Td>
                    <Td><Badge tone={driverStatusTone(d.status)}>{titleCase(d.status)}</Badge></Td>
                    <Td>{d.pco_licence_no ?? '—'}</Td>
                    <Td>
                      {d.pco_licence_expiry ? (
                        <span className="inline-flex items-center gap-2">
                          {formatDate(d.pco_licence_expiry)}
                          {expiring && (
                            <Badge tone={exp !== null && exp < 0 ? 'loss' : 'warn'}>
                              {exp !== null && exp < 0 ? `${Math.abs(exp)}d overdue` : `${exp}d`}
                            </Badge>
                          )}
                        </span>
                      ) : '—'}
                    </Td>
                    <Td>{formatDate(d.dvla_checked_on)}</Td>
                    <Td className="text-right">
                      {/* Decorative — the name cell already links here with a real name. */}
                      <Link
                        href={`/ops/drivers/${d.id}`}
                        aria-hidden="true"
                        tabIndex={-1}
                        className="text-gold-bright opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <Icon name="chevron" className="h-4 w-4" />
                      </Link>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
