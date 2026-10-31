import { requireTenantContext, contextCan } from '@/lib/auth/context';
// src/app/accounts/accounting/mtd/page.tsx
// The tenant's HMRC MTD connection settings + token-status display.

import MtdConnection from '@/components/accounting/MtdConnection';

export default async function MtdSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await requireTenantContext();
  if (!contextCan(ctx, 'tenant.settings')) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="rounded-[var(--radius)] border border-hair-soft bg-[var(--surface-soft)] p-4">
          <p className="text-cream">
            You don&apos;t have the <code className="font-mono text-sm">tenant.settings</code> permission required to use this page. Ask the ops admin to grant it on your membership.
          </p>
        </div>
        <a href="/accounts" className="mt-3 inline-block text-sm text-gold-bright hover:underline">← Back to /accounts</a>
      </div>
    );
  }

  const { status } = await searchParams;

  return (
    <>
      <h1 className="text-2xl font-semibold mb-4">HMRC MTD connection</h1>
      <MtdConnection
        tenantId={ctx.tenantId}
        returnTo="/accounts/accounting/mtd"
        status={status ?? null}
      />
    </>
  );
}
