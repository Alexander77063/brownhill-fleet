// src/app/admin/accounting/reports/vat-return/page.tsx
// UK VAT return page. Shows the box figures for the requested period, a preview,
// and a "Submit to HMRC" button.

import { requirePermission } from '@/lib/auth/context';
import VatReturnPanel from '@/components/accounting/VatReturnPanel';

export default async function VatReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; status?: string }>;
}) {
  // Same owner-side gate as the rest of /admin/accounting/*.
  const ctx = await requirePermission('tenant.settings');
  const sp = await searchParams;
  const [yearStr, monthStr] = (sp.period ?? '').split('-');
  const year  = yearStr  ? parseInt(yearStr, 10)  : new Date().getUTCFullYear();
  const month = monthStr ? parseInt(monthStr, 10) : new Date().getUTCMonth() + 1;

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">VAT return — {year}-{String(month).padStart(2, '0')}</h1>
      <VatReturnPanel
        tenantId={ctx.tenantId}
        year={year}
        month={month}
        connectHref="/admin/accounting/mtd"
        status={sp.status ?? null}
      />
    </main>
  );
}
