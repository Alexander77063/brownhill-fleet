// src/app/admin/accounting/invoices/page.tsx
// Operator-facing invoice register.
//
// The table itself is shared with the accountant console
// (/accounts/accounting/invoices) — see src/components/accounting/InvoiceRegister.tsx.
// This page supplies the data and the permission gate.
//
// WHY THIS PAGE EXISTS
// --------------------
// The product had no invoice list. An invoice was visible only in the
// reconciliation queue's match picker — which shows the invoices a bank line
// can still be matched to — and in the reports, which are summaries. So
// "which invoices have we issued, which are still owed, and what is this one
// for?" had no answer anywhere in the product.
//
// It is also where an invoice gets voided: a correction the operator cannot
// see is a correction nobody performs.

import { requirePermission, contextCan } from '@/lib/auth/context';
import {
  countInvoicesByStatus,
  listInvoices,
  type InvoiceStatus,
} from '@/lib/accounting/invoice-register';
import { InvoiceRegister } from '@/components/accounting/InvoiceRegister';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/admin/accounting/invoices';

/** The statuses the filter accepts. Anything else is treated as 'all'. */
function parseStatus(raw: string | undefined): InvoiceStatus | 'all' {
  const allowed: InvoiceStatus[] = ['open', 'paid', 'part_paid', 'void', 'overdue'];
  return raw && (allowed as string[]).includes(raw) ? (raw as InvoiceStatus) : 'all';
}

export default async function AdminInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  // Same owner-side gate as the rest of /admin/accounting/*.
  const ctx = await requirePermission('tenant.settings');

  const sp = await searchParams;
  const status = parseStatus(sp.status);

  // Tenant-scoped. The accounting schema is not exposed by PostgREST and
  // this connection is the superuser one, so RLS does not filter these
  // queries — the tenant has to be named here.
  const [rows, counts] = await Promise.all([
    listInvoices(ctx.tenantId, { status }),
    countInvoicesByStatus(ctx.tenantId),
  ]);

  // The void is a ledger mutation, so it takes the same permission the route
  // enforces. The button is drawn from the same fact the server checks, so a
  // member who cannot void sees the list and not the control.
  const canVoid = contextCan(ctx, 'billing.write');

  return (
    <main className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Invoices</h1>
      <p className="mb-4 text-sm text-gray-600">
        Every invoice raised, with what has been received against it. A void posts a reversal
        into the invoice&apos;s own month — not this one.
      </p>
      <InvoiceRegister
        rows={rows}
        canVoid={canVoid}
        counts={counts}
        activeStatus={status}
        basePath={BASE_PATH}
      />
    </main>
  );
}
