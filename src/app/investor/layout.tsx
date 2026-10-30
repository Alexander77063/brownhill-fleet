import { requireRole } from '@/lib/auth';
import { AppShell } from '@/components/shell/AppShell';
import { navFor, ROLE_LABEL } from '@/components/shell/nav';
import { navFeatures } from '@/lib/entitlements';
import { getTheme } from '@/lib/theme';

export default async function InvestorLayout({ children }: { children: React.ReactNode }) {
  const p = await requireRole(['investor']);
  const theme = await getTheme();
  const features = await navFeatures();

  return (
    <AppShell
      role="investor"
      roleLabel={ROLE_LABEL.investor}
      items={navFor('investor', features)}
      name={p.fullName}
      email={p.email}
      initialTheme={theme}
    >
      {children}
    </AppShell>
  );
}
