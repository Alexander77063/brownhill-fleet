import { requireEntitlementOrRedirect } from '@/lib/entitlements';

// Rent-to-own equity only exists under a hire agreement — the rental module.
export default async function EquityLayout({ children }: { children: React.ReactNode }) {
  await requireEntitlementOrRedirect('rental.core', '/driver');
  return children;
}
