import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader, Card, CardTitle, Button, Badge } from '@/components/ui';
import { contextCan, getAuthContext } from '@/lib/auth/context';
import { getMember } from '@/lib/tenancy';
import { groupPermissions } from '@/app/admin/permissions-catalog';
import { updateMemberAction } from '@/lib/actions/admin';
import { effectivePermissions, type Role } from '@/lib/iam';

export const dynamic = 'force-dynamic';

const ROLES = ['owner', 'tenant_admin', 'md', 'director_exec', 'director_nonexec', 'ops', 'accounts', 'driver', 'investor'];

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export default async function MemberEditPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  const ctx = await getAuthContext();
  if (!ctx || !ctx.tenantId || !contextCan(ctx, 'members.manage')) {
    return (
      <Wrap>
        <PageHeader eyebrow="Admin" title="Edit member" />
        <Card>
          <p className="text-sm text-muted">
            You don&apos;t have permission to edit members of this organisation.
          </p>
        </Card>
      </Wrap>
    );
  }

  const member = await getMember(ctx.tenantId, userId);
  if (!member) notFound();

  // Effective permissions = role defaults ∪ the extras stored on the membership.
  // We render the union so the admin sees what the user currently has and can
  // edit either side (role change resets the role defaults; the checkbox list
  // is the extras).
  const roleDefaults = effectivePermissions(member.role as Role, []);
  const extras = new Set(member.permissions ?? []);

  return (
    <Wrap>
      <PageHeader
        eyebrow="Admin · Members"
        title={member.full_name ?? member.email ?? 'Member'}
        subtitle={member.email ?? undefined}
        actions={
          <Button href="/admin" variant="ghost" size="sm">
            ← Back to members
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Role &amp; status</CardTitle>
          <form action={updateMemberAction} className="mt-3 space-y-3">
            <input type="hidden" name="user_id" value={member.user_id} />
            <Field label="Role">
              <select name="role" defaultValue={member.role} className={`${inputCls} w-full`}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select name="status" defaultValue={member.status} className={`${inputCls} w-full`}>
                <option value="active">active</option>
                <option value="disabled">disabled</option>
              </select>
            </Field>
            <Button type="submit" variant="primary" size="sm">
              Save role &amp; status
            </Button>
          </form>
        </Card>

        <Card>
          <CardTitle>Effective permissions</CardTitle>
          <p className="mt-2 text-sm text-muted">
            What <span className="text-cream">{member.full_name ?? member.email ?? 'this member'}</span> can do today —{' '}
            role defaults first, then any extras stored on this membership.
          </p>
          <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto rounded-md border border-hair-soft bg-[var(--surface-soft)] p-3 text-sm">
            {Array.from(roleDefaults).sort().map((p) => (
              <li key={`role-${p}`} className="flex items-center justify-between gap-2">
                <span className="text-cream">{p}</span>
                <Badge tone="neutral">from role</Badge>
              </li>
            ))}
            {(member.permissions ?? []).sort().map((p) => (
              <li key={`extra-${p}`} className="flex items-center justify-between gap-2">
                <span className="text-cream">{p}</span>
                <Badge tone="profit">extra</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="mt-4">
        <CardTitle>Extra permissions</CardTitle>
        <p className="mt-2 text-sm text-muted">
          The extras stored on this membership, on top of what their role already grants. Unticking a row removes
          that grant; ticking adds it. Role defaults are not affected.
        </p>
        <form action={updateMemberAction} className="mt-4 space-y-4">
          <input type="hidden" name="user_id" value={member.user_id} />
          {/* Sentinel — see admin.ts updateMemberAction. Tells the server the
              permissions were edited (even if the result is an empty array), so
              we can distinguish "unchanged" from "cleared". */}
          <input type="hidden" name="permissions_dirty" value="1" />

          {groupPermissions().map((g) => (
            <fieldset key={g.group} className="rounded-md border border-hair-soft p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-parchment">{g.group}</legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {g.items.map((p) => (
                  <label key={p.key} className="flex items-center gap-2 text-sm text-cream">
                    <input
                      type="checkbox"
                      name="permission"
                      value={p.key}
                      defaultChecked={extras.has(p.key) || roleDefaults.has(p.key)}
                      className="accent-[var(--color-gold)]"
                    />
                    <span>
                      {p.label}{' '}
                      <code className="ml-1 text-[11px] text-muted">{p.key}</code>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}

          <Button type="submit" variant="primary" size="sm">
            Save extra permissions
          </Button>
        </form>
      </Card>
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">{label}</span>
      {children}
    </label>
  );
}