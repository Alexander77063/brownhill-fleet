import { redirect } from 'next/navigation';
import { requireRole } from '@/lib/auth';
import { AppShell } from '@/components/shell/AppShell';
import { NAV, ROLE_LABEL } from '@/components/shell/nav';
import { getBranding, brandDisplayName } from '@/lib/branding';
import { getAuthContext, contextCan } from '@/lib/auth/context';
import { tenantAcceptedCurrentLegal } from '@/lib/legal-consent';
import { getTheme } from '@/lib/theme';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const p = await requireRole(['ops']);
  const b = await getBranding();
  const theme = await getTheme();

  const ctx = await getAuthContext();

  // Consent gate — a tenant must accept the current legal version. Skipped when the
  // user has no tenant yet (they can still reach /admin to create one).
  if (ctx?.tenantId && !(await tenantAcceptedCurrentLegal(ctx.tenantId))) redirect('/legal/accept');
  const items =
    ctx && contextCan(ctx, 'tenant.settings')
      ? [...NAV.ops, { href: '/admin', label: 'Admin', icon: 'shield' as const }]
      : NAV.ops;

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
