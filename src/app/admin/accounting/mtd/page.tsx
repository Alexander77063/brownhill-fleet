// src/app/admin/accounting/mtd/page.tsx
// The platform operator's HMRC MTD connection settings + token-status display.

import { requirePermission } from '@/lib/auth/context';
import MtdConnection from '@/components/accounting/MtdConnection';

export default async function MtdSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  // Same owner-side gate as the rest of /admin/accounting/*.
  const ctx = await requirePermission('tenant.settings');
  const { status } = await searchParams;

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">HMRC MTD connection</h1>
      <MtdConnection
        tenantId={ctx.tenantId}
        returnTo="/admin/accounting/mtd"
        status={status ?? null}
      />
    </main>
  );
}
