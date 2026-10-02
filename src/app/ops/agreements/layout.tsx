import { requireEntitlementOrRedirect } from '@/lib/entitlements';

// Agreements are the rental module. A tenant that did not buy it — every
// Nigerian tier — is sent home rather than shown a hire workflow it cannot use.
export default async function AgreementsLayout({ children }: { children: React.ReactNode }) {
  await requireEntitlementOrRedirect('rental.core', '/ops');
  return children;
}
