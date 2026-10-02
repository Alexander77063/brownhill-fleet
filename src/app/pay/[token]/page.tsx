import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { InvoiceView } from '@/components/collection/InvoiceView';
import { Button } from '@/components/ui';
import { invoiceByToken, UNPAID_STATUSES } from '@/lib/collection/invoices';
import { deploymentBrand } from '@/lib/deployment/brand';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Invoice', robots: { index: false, follow: false } };

/**
 * The public pay page: the link in every invoice SMS and email. The token is
 * 256 random bits; it authorises exactly this invoice and shows what a paper
 * invoice would. No login — a fleet's finance clerk has no account.
 */
export default async function PayPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ paid?: string; pending?: string; nogateway?: string; error?: string }> }) {
  const [{ token }, q] = await Promise.all([params, searchParams]);
  const inv = await invoiceByToken(token);
  if (!inv) notFound();
  const open = UNPAID_STATUSES.includes(inv.status);
  const brand = deploymentBrand().productName;

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-8">
      <p className="eyebrow mb-4">{brand}</p>
      {q.paid && (
        <p role="status" className="mb-4 rounded-md border border-[var(--color-profit)] px-3 py-2 text-sm text-parchment">
          Payment received — thank you. {inv.kind === 'initial' || inv.kind === 'renewal' ? 'Protection is active.' : ''}
        </p>
      )}
      {q.pending && (
        <p role="status" className="mb-4 rounded-md border border-amber-500/60 px-3 py-2 text-sm text-parchment">
          We have not confirmed that payment yet. If you completed it, it will show here within the hour; otherwise pay again below.
        </p>
      )}
      {q.nogateway && (
        <p role="status" className="mb-4 rounded-md border border-hair px-3 py-2 text-sm text-parchment">
          Online payment is not available on this instance yet. Please pay by bank transfer using the details on the invoice.
        </p>
      )}
      {q.error && (
        <p role="alert" className="mb-4 rounded-md border border-[var(--color-loss)] px-3 py-2 text-sm text-[var(--color-loss)]">
          {q.error}
        </p>
      )}

      <InvoiceView snapshot={inv.data} status={inv.status} paidMinor={Number(inv.paid_minor)} whtMinor={Number(inv.wht_minor)} />

      {open && (
        <form method="post" action={`/pay/${token}/start`} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block text-xs text-parchment">
            Email for the receipt
            <input name="email" type="email" required defaultValue={inv.customer.email ?? ''} className="mt-1 block w-64 rounded-md border border-hair bg-[var(--surface)] px-3 py-2 text-sm text-cream" />
          </label>
          <Button type="submit">Pay now</Button>
          <span className="text-xs text-muted">Card, bank transfer or USSD on the payment page.</span>
        </form>
      )}
    </main>
  );
}
