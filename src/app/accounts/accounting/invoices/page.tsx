// src/app/accounts/accounting/invoices/page.tsx
// Accountant-facing invoice register.
//
// The table itself is shared with the operator console
// (/admin/accounting/invoices) — see src/components/accounting/InvoiceRegister.tsx.
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

import { requireTenantContext, contextCan } from '@/lib/auth/context';
import {
  countInvoicesByStatus,
  listInvoices,
  type InvoiceStatus,
} from '@/lib/accounting/invoice-register';
import { InvoiceRegister } from '@/components/accounting/InvoiceRegister';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/accounts/accounting/invoices';

/** The statuses the filter accepts. Anything else is treated as 'all'. */
function parseStatus(raw: string | undefined): InvoiceStatus | 'all' {
  const allowed: InvoiceStatus[] = ['open', 'paid', 'part_paid', 'void', 'overdue'];
  return raw && (allowed as string[]).includes(raw) ? (raw as InvoiceStatus) : 'all';
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await requireTenantContext();
  if (!contextCan(ctx, 'billing.read')) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="rounded-[var(--radius)] border border-hair-soft bg-[var(--surface-soft)] p-4">
          <p className="text-cream">
            You don&apos;t have the <code className="font-mono text-sm">billing.read</code>{' '}
            permission required to view invoices. Ask the ops admin to grant it on your membership.
          </p>
        </div>
        <a href="/accounts" className="mt-3 inline-block text-sm text-gold-bright hover:underline">
          ← Back to /accounts
        </a>
      </div>
    );
  }

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
  // read-only accountant sees the list and not the control.
  const canVoid = contextCan(ctx, 'billing.write');

  return (
    <>
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
    </>
  );
}
