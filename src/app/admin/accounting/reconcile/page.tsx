// src/app/admin/accounting/reconcile/page.tsx
// Operator-facing reconciliation queue. Lists unmatched bank transactions
// sorted by date. Per-row actions: match to an invoice / mark as a VAT
// payment / mark as a bank fee / ignore. The form posts to
// /api/v1/accounting/reconcile.
//
// The queue table itself is shared with the accountant console
// (/accounts/accounting/reconcile) — see src/components/accounting/ReconcileQueue.tsx.
// This page supplies the data and the permission gate.

import { requirePermission } from '@/lib/auth/context';
import { loadUnmatched, loadOpenInvoices } from '@/lib/accounting/reconcile-queue';
import { ReconcileQueue } from '@/components/accounting/ReconcileQueue';

const RETURN_TO = '/admin/accounting/reconcile';

export default async function ReconcilePage() {
  // Same owner-side gate as the rest of /admin/accounting/*.
  const ctx = await requirePermission('tenant.settings');

  // Tenant-scoped on both sides. The accounting schema is not exposed by
  // PostgREST and this connection is the superuser one, so RLS does not
  // filter these queries — the tenant has to be named here.
  const rows = await loadUnmatched(ctx.tenantId);
  const invoices = await loadOpenInvoices(ctx.tenantId);

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Bank reconciliation queue</h1>
      <p className="text-sm text-gray-600 mb-4">
        {rows.length} unmatched bank transaction{rows.length === 1 ? '' : 's'}. For each, choose how to categorise it.
      </p>
      <ReconcileQueue rows={rows} invoices={invoices} returnTo={RETURN_TO} />
    </main>
  );
}
