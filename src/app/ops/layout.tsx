import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireRole } from '@/lib/auth';
import { AppShell } from '@/components/shell/AppShell';
import { navFor, ROLE_LABEL } from '@/components/shell/nav';
import { getBranding, brandDisplayName } from '@/lib/branding';
import { getAuthContext, contextCan } from '@/lib/auth/context';
import { navFeatures, requireServiceableSubscription } from '@/lib/entitlements';
import { tenantAcceptedCurrentLegal } from '@/lib/legal-consent';
import { getTheme } from '@/lib/theme';

export default async function OpsLayout({ children }: { children: React.ReactNode }) {
  const p = await requireRole(['ops']);
  const b = await getBranding();
  const theme = await getTheme();

  // Additively surface the tenant-admin area for owners/admins — the /ops landing
  // itself is unchanged; this just makes /admin discoverable in the sidebar.
  const ctx = await getAuthContext();

  // Consent gate: block the operator app until the tenant accepts the current legal
  // version (the /legal/accept page is outside this layout, so no redirect loop).
  if (ctx?.tenantId && !(await tenantAcceptedCurrentLegal(ctx.tenantId))) redirect('/legal/accept');
  // Pay-first markets (NG-2): an unpaid or suspended tenant reaches only billing,
  // fleet (to build the first invoice), import and admin. No-op on the UK SaaS.
  await requireServiceableSubscription((await headers()).get('x-pathname'), '/ops');
  // Only the surfaces this tenant is entitled to — a Nigerian tier has no
  // Agreements or Dispatch. The segment layouts enforce the same keys.
  const base = navFor('ops', await navFeatures());
  const items =
    ctx && contextCan(ctx, 'tenant.settings')
      ? [...base, { href: '/admin', label: 'Admin', icon: 'shield' as const }]
      : base;

  return (
    <AppShell
      role="ops"
      roleLabel={ROLE_LABEL.ops}
      items={items}
      name={p.fullName}
      email={p.email}
      brandName={brandDisplayName(b)}
      logoUrl={b.logo_url}
      initialTheme={theme}
    >
      {children}
    </AppShell>
  );
}
