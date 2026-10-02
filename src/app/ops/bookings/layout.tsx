import { requireEntitlementOrRedirect } from '@/lib/entitlements';

// Dispatch is bookings of hire vehicles — the rental module. A tenant that did
// not buy it is sent home rather than shown a workflow it cannot use.
export default async function BookingsLayout({ children }: { children: React.ReactNode }) {
  await requireEntitlementOrRedirect('rental.core', '/ops');
  return children;
}
