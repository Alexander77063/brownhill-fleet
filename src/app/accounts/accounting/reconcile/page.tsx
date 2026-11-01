import { requireTenantContext, contextCan } from '@/lib/auth/context';
// src/app/accounts/accounting/reconcile/page.tsx
// Accountant-facing reconciliation queue. Lists unmatched bank transactions
// sorted by date. Per-row actions: match to an invoice / mark as a VAT
// payment / mark as a bank fee / ignore. The form posts to
// /api/v1/accounting/reconcile.
//
// The queue table itself is shared with the operator console
// (/admin/accounting/reconcile) — see src/components/accounting/ReconcileQueue.tsx.
// This page supplies the data and the permission gate.

import { loadUnmatched, loadOpenInvoices } from '@/lib/accounting/reconcile-queue';
import { ReconcileQueue } from '@/components/accounting/ReconcileQueue';

const RETURN_TO = '/accounts/accounting/reconcile';

export default async function ReconcilePage() {
  const ctx = await requireTenantContext();
  if (!contextCan(ctx, 'billing.write')) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="rounded-[var(--radius)] border border-hair-soft bg-[var(--surface-soft)] p-4">
          <p className="text-cream">
            You don&apos;t have the <code className="font-mono text-sm">billing.write</code> permission required to use this page. Ask the ops admin to grant it on your membership.
          </p>
        </div>
        <a href="/accounts" className="mt-3 inline-block text-sm text-gold-bright hover:underline">← Back to /accounts</a>
      </div>
    );
  }

  // Tenant-scoped on both sides. The accounting schema is not exposed by
  // PostgREST and this connection is the superuser one, so RLS does not
  // filter these queries — the tenant has to be named here.
  const rows = await loadUnmatched(ctx.tenantId);
  const invoices = await loadOpenInvoices(ctx.tenantId);

  return (
    <>
      <h1 className="text-2xl font-semibold mb-4">Bank reconciliation queue</h1>
      <p className="text-sm text-gray-600 mb-4">
        {rows.length} unmatched bank transaction{rows.length === 1 ? '' : 's'}. For each, choose how to categorise it.
      </p>
      <ReconcileQueue rows={rows} invoices={invoices} returnTo={RETURN_TO} />
    </>
  );
}
