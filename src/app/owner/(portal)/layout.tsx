/**
 * The vehicle-owner portal's shell and its session guard.
 *
 * This file lives in the `(portal)` route group for the same reason the driver
 * portal's does: the sign-in page.
 *
 * `/owner/login` used to sit directly under a layout that called
 * `requireRole(['owner'])`, so a signed-out visitor was redirected to `/login`
 * before the form could render. A sign-in page cannot live inside the tree
 * that guards the pages behind it. `(portal)` does not appear in the URL, so
 * `/owner`, `/owner/billing` and the rest are unchanged.
 *
 * `tests/unit/signin-reachability.test.ts` holds this arrangement in place.
 */
import { headers } from 'next/headers';
import { requireRole } from '@/lib/auth';
import { AppShell } from '@/components/shell/AppShell';
import { navFor, ROLE_LABEL } from '@/components/shell/nav';
import { navFeatures, requireServiceableSubscription, subscriptionStatus } from '@/lib/entitlements';
import { payFirst } from '@/lib/region';
import { SubscriptionBanner } from '@/components/collection/SubscriptionBanner';
import { getTheme } from '@/lib/theme';

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const p = await requireRole(['owner']);
  // Pay-first: until the first invoice is paid (or after suspension) only the
  // billing, help, settings and add-vehicle pages open (NG-2 §6.2).
  await requireServiceableSubscription((await headers()).get('x-pathname'), '/owner');
  const theme = await getTheme();
  const features = await navFeatures();
  const sub = payFirst() ? await subscriptionStatus().catch(() => null) : null;
  return (
    <AppShell
      role="owner"
      roleLabel={ROLE_LABEL.owner}
      items={navFor('owner', features)}
      name={p.fullName}
      email={p.email}
      initialTheme={theme}
    >
      {sub && <SubscriptionBanner status={sub.status} anniversaryOn={sub.anniversaryOn} />}
      {children}
    </AppShell>
  );
}
