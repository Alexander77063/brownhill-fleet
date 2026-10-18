import { AppShell } from '@/components/shell/AppShell';
import { navFor, ROLE_LABEL } from '@/components/shell/nav';
import { requireRole } from '@/lib/auth';
import { getBranding, brandDisplayName } from '@/lib/branding';
import { getTheme } from '@/lib/theme';

export default async function AccountsLayout({ children }: { children: React.ReactNode }) {
  const p = await requireRole(['accounts']);
  const b = await getBranding();
  const theme = await getTheme();

  return (
    <AppShell
      role="accounts"
      roleLabel={ROLE_LABEL.accounts}
      items={navFor('accounts', new Set())}
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