import { requireRole } from '@/lib/auth';
import { AppShell } from '@/components/shell/AppShell';
import { navFor, ROLE_LABEL } from '@/components/shell/nav';
import { navFeatures } from '@/lib/entitlements';
import { getTheme } from '@/lib/theme';

export default async function DriverLayout({ children }: { children: React.ReactNode }) {
  const p = await requireRole(['driver']);
  const theme = await getTheme();
  const features = await navFeatures();
  return (
    <AppShell
      role="driver"
      roleLabel={ROLE_LABEL.driver}
      items={navFor('driver', features)}
      name={p.fullName}
      email={p.email}
      initialTheme={theme}
    >
      {children}
    </AppShell>
  );
}
