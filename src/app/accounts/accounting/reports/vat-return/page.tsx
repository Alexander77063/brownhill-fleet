import { requireTenantContext, contextCan } from '@/lib/auth/context';
// src/app/accounts/accounting/reports/vat-return/page.tsx
// UK VAT return page. Shows the box figures for the requested period, a preview,
// and a "Submit to HMRC" button.

import VatReturnPanel from '@/components/accounting/VatReturnPanel';

export default async function VatReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; status?: string }>;
}) {
  const ctx = await requireTenantContext();
  if (!contextCan(ctx, 'reports.operational')) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="rounded-[var(--radius)] border border-hair-soft bg-[var(--surface-soft)] p-4">
          <p className="text-cream">
            You don&apos;t have the <code className="font-mono text-sm">reports.operational</code> permission required to use this page. Ask the ops admin to grant it on your membership.
          </p>
        </div>
        <a href="/accounts" className="mt-3 inline-block text-sm text-gold-bright hover:underline">← Back to /accounts</a>
      </div>
    );
  }

  const sp = await searchParams;
  const [yearStr, monthStr] = (sp.period ?? '').split('-');
  const year  = yearStr  ? parseInt(yearStr, 10)  : new Date().getUTCFullYear();
  const month = monthStr ? parseInt(monthStr, 10) : new Date().getUTCMonth() + 1;

  return (
    <>
      <h1 className="text-2xl font-semibold mb-4">VAT return — {year}-{String(month).padStart(2, '0')}</h1>
      <VatReturnPanel
        tenantId={ctx.tenantId}
        year={year}
        month={month}
        connectHref="/accounts/accounting/mtd"
        status={sp.status ?? null}
      />
    </>
  );
}
