import { PageHeader, Card, CardTitle, Button, Badge, Table, Th, Td } from '@/components/ui';
import { contextCan, getAuthContext } from '@/lib/auth/context';
import { getTenant, listMembers } from '@/lib/tenancy';
import { getTenantBilling } from '@/lib/billing';
import {
  addMemberAction,
  createTenantAction,
  openPortalAction,
  startCheckoutAction,
  updateMemberAction,
  updateSettingsAction,
} from '@/lib/actions/admin';

export const dynamic = 'force-dynamic';

const ROLES = ['owner', 'tenant_admin', 'md', 'director_exec', 'director_nonexec', 'ops', 'accounts', 'driver', 'investor'];
const STATUSES = ['active', 'suspended', 'cancelled'];
const MODULES: [string, string][] = [
  ['rental', 'Rental & agreements'],
  ['compliance', 'Compliance & documents'],
  ['bookings', 'Bookings & dispatch'],
  ['gps', 'GPS / telematics'],
];

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export default async function AdminPage() {
  const ctx = await getAuthContext();

  if (!ctx) {
    return <Centered>Please sign in to manage your organisation.</Centered>;
  }

  // Onboarding: a user with no tenant creates one and becomes its owner.
  if (!ctx.tenantId) {
    return (
      <Wrap>
        <PageHeader eyebrow="Admin" title="Create your organisation" subtitle="Set up your workspace to get started." />
        <Card className="max-w-md">
          <form action={createTenantAction} className="space-y-3">
            <Field label="Business name">
              <input name="name" required placeholder="Acme Cars Ltd" className={`${inputCls} w-full`} />
            </Field>
            <Field label="URL slug" hint="lowercase letters, numbers, hyphens">
              <input name="slug" required placeholder="acme-cars" className={`${inputCls} w-full`} />
            </Field>
            <Button type="submit" variant="primary" size="sm">Create organisation</Button>
          </form>
        </Card>
      </Wrap>
    );
  }

  const tenant = await getTenant(ctx.tenantId);
  const canSettings = contextCan(ctx, 'tenant.settings');
  const canMembers = contextCan(ctx, 'members.manage');

  if (!tenant) return <Centered>Organisation not found.</Centered>;
  if (!canSettings && !canMembers) {
    return (
      <Wrap>
        <PageHeader eyebrow="Admin" title={tenant.name} />
        <Card><p className="text-sm text-muted">You don&apos;t have admin access to this organisation.</p></Card>
      </Wrap>
    );
  }

  const members = canMembers ? await listMembers(ctx.tenantId) : [];
  const modules = (tenant.modules ?? {}) as Record<string, boolean>;
  const canBilling = contextCan(ctx, 'subscription.manage');
  const billing = canBilling ? await getTenantBilling(ctx.tenantId) : null;
  const stripeReady = !!process.env.STRIPE_SECRET_KEY;

  return (
    <Wrap>
      <PageHeader
        eyebrow="Admin"
        help="page.admin"
        title={tenant.name}
        subtitle={`${tenant.slug} · ${tenant.plan} plan`}
        actions={<Badge tone={tenant.status === 'active' ? 'profit' : 'loss'}>{tenant.status}</Badge>}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Button href="/admin/assistant" variant="outline" size="sm">Fleet Assistant</Button>
        <Button href="/admin/branding" variant="outline" size="sm">Branding</Button>
        <Button href="/admin/notifications" variant="outline" size="sm">Email & alerts</Button>
        <Button href="/admin/tracking-rules" variant="outline" size="sm">Tracking rules</Button>
      </div>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {canSettings && (
          <Card>
            <CardTitle>Organisation settings</CardTitle>
            <form action={updateSettingsAction} className="mt-3 space-y-3">
              <Field label="Business name">
                <input name="name" defaultValue={tenant.name} className={`${inputCls} w-full`} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Plan" hint="Change your plan in the Subscription section below.">
                  <div className={`${inputCls} w-full capitalize text-muted`}>{tenant.plan}</div>
                </Field>
                <Field label="Status">
                  <select name="status" defaultValue={tenant.status} className={`${inputCls} w-full`}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Modules">
                <div className="space-y-1.5">
                  {MODULES.map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 text-sm text-cream">
                      <input type="checkbox" name={`module_${key}`} defaultChecked={!!modules[key]} className="accent-[var(--color-gold)]" />
                      {label}
                    </label>
                  ))}
                </div>
              </Field>
              <Button type="submit" variant="primary" size="sm">Save settings</Button>
            </form>
          </Card>
        )}

        {canMembers && (
          <Card>
            <CardTitle>Add a member</CardTitle>
            <form action={addMemberAction} className="mt-3 space-y-3">
              <Field label="Email" hint="we'll create their login and email them a sign-in invite">
                <input name="email" type="email" required placeholder="name@company.com" className={`${inputCls} w-full`} />
              </Field>
              <Field label="Role">
                <select name="role" defaultValue="ops" className={`${inputCls} w-full`}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
              <Button type="submit" variant="outline" size="sm">Add member</Button>
            </form>
          </Card>
        )}
      </section>

      {canBilling && (
        <section className="mt-4">
          <Card>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Subscription</CardTitle>
              <Badge tone={billing?.subscription_status === 'active' ? 'profit' : 'neutral'}>
                {billing?.subscription_status ?? 'trial'}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-muted">
              Current plan: <span className="text-cream">{tenant.plan}</span>
              {billing?.current_period_end
                ? ` · renews ${new Date(billing.current_period_end).toLocaleDateString('en-GB')}`
                : ''}
            </p>
            {stripeReady ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {(['starter', 'growth', 'scale'] as const).map((p) => (
                  <form key={p} action={startCheckoutAction}>
                    <input type="hidden" name="plan" value={p} />
                    <Button type="submit" variant={tenant.plan === p ? 'primary' : 'outline'} size="sm">
                      {tenant.plan === p ? `On ${p}` : `Switch to ${p}`}
                    </Button>
                  </form>
                ))}
                {billing?.stripe_customer_id && (
                  <form action={openPortalAction}>
                    <Button type="submit" variant="ghost" size="sm">Manage billing</Button>
                  </form>
                )}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted">
                Connect Stripe (set <code>STRIPE_SECRET_KEY</code> + plan price ids) to enable subscriptions.
              </p>
            )}
          </Card>
        </section>
      )}

      {canMembers && (
        <section className="mt-4">
          <h2 className="mb-3 font-display text-xl text-cream">Members</h2>
          <Table caption="Members">
            <thead>
              <tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Status</Th><Th> </Th></tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id}>
                  <Td className="text-cream">{m.full_name ?? '—'}</Td>
                  <Td>{m.email ?? '—'}</Td>
                  <Td>
                    <form action={updateMemberAction} className="flex items-center gap-2">
                      <input type="hidden" name="user_id" value={m.user_id} />
                      {/* Repeated per member row — the name disambiguates them. */}
                      <select name="role" aria-label={`Role for ${m.full_name ?? m.email ?? 'member'}`} defaultValue={m.role} className={inputCls}>
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <select name="status" aria-label={`Status for ${m.full_name ?? m.email ?? 'member'}`} defaultValue={m.status} className={inputCls}>
                        <option value="active">active</option>
                        <option value="disabled">disabled</option>
                      </select>
                      <Button type="submit" variant="ghost" size="sm">Save</Button>
                    </form>
                  </Td>
                  <Td><Badge tone={m.status === 'active' ? 'profit' : 'neutral'}>{m.status}</Badge></Td>
                  <Td> </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</div>;
}
function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-[60vh] place-items-center px-4 text-center text-muted">{children}</div>;
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
