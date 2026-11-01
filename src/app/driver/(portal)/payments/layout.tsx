import { requireEntitlementOrRedirect } from '@/lib/entitlements';

// A driver's rent payments only exist under a hire agreement — the rental module.
export default async function DriverPaymentsLayout({ children }: { children: React.ReactNode }) {
  await requireEntitlementOrRedirect('rental.core', '/driver');
  return children;
}
