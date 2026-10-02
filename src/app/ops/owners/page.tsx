import Link from 'next/link';
import { PageHeader, Card, CardTitle, Button, Badge, Table, Th, Td, EmptyState } from '@/components/ui';
import { requireTenantContext } from '@/lib/auth/context';
import { listOwners } from '@/lib/owners';
import { regionProvider } from '@/lib/region';
import { createOwnerAction } from '@/lib/actions/owners';

export const dynamic = 'force-dynamic';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export default async function OwnersPage() {
  const ctx = await requireTenantContext();
  const owners = await listOwners(ctx.tenantId);
  const phoneExample = regionProvider().phone.example;

  return (
    <>
      <PageHeader
        eyebrow="Owners"
        title="Vehicle owners"
        subtitle="The people whose vehicles you look after — policyholders, customers, staff. Attach vehicles to them and they can sign in with their phone to see their own."
      />

      <section className="mt-5">
        {owners.length === 0 ? (
          <EmptyState title="No owners yet" hint="Add one below, or import vehicles with owner columns." />
        ) : (
          <Table caption="Vehicle owners">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Phone</Th>
                <Th>Email</Th>
                <Th className="text-right">Vehicles</Th>
                <Th>Account</Th>
              </tr>
            </thead>
            <tbody>
              {owners.map((o) => (
                <tr key={o.id}>
                  <Td className="font-display text-cream">
                    <Link href={`/ops/owners/${o.id}`} className="hover:text-gold-bright">
                      {o.name}
                    </Link>
                  </Td>
                  <Td>{o.phone}</Td>
                  <Td>{o.email ?? '—'}</Td>
                  <Td className="text-right tnum">{o.vehicles}</Td>
                  <Td>{o.user_id ? <Badge tone="profit">signed in</Badge> : <span className="text-muted">not yet</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <Card className="mt-6 max-w-2xl">
        <CardTitle>New owner</CardTitle>
        <form action={createOwnerAction} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Full name">
              <input name="name" required className={`${inputCls} w-full`} />
            </Field>
            <Field label="Mobile number" hint="They sign in with this number.">
              <input name="phone" type="tel" required placeholder={phoneExample} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Email (optional)">
              <input name="email" type="email" className={`${inputCls} w-full`} />
            </Field>
            <Field label="National ID (optional)">
              <input name="nin" className={`${inputCls} w-full`} />
            </Field>
          </div>
          <Button type="submit" variant="primary" size="sm">
            Add owner
          </Button>
        </form>
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
