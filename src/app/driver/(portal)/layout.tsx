/**
 * The driver portal's shell and its session guard.
 *
 * This file lives in the `(portal)` route group rather than directly at
 * `src/app/driver/` for one reason: the sign-in page.
 *
 * `/driver/login` is where a driver signs in. It used to sit at
 * `src/app/driver/login/page.tsx`, directly under a layout that called
 * `requireRole(['driver'])` — so a signed-out driver was redirected to
 * `/login` before the sign-in form could render, and the URL the operations
 * app hands out (`inviteDriverAction` returns `${base}/driver/login`) was a
 * dead end. A sign-in page cannot live inside the tree that guards the pages
 * behind it.
 *
 * The route group is the fix. `(portal)` does not appear in the URL, so
 * `/driver`, `/driver/charges` and the rest are unchanged, but the group lets
 * the guarded pages and the public sign-in page be siblings rather than
 * parent and child.
 *
 * `tests/unit/signin-reachability.test.ts` holds this arrangement in place:
 * a page whose route ends in `/login` may not have a session-gated layout
 * above it.
 */
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
