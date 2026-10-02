import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader, Button } from '@/components/ui';
import { InvoiceView } from '@/components/collection/InvoiceView';
import { invoiceByNumber, UNPAID_STATUSES } from '@/lib/collection/invoices';
import { ownerBilling } from '@/lib/collection/owner-billing';

export const dynamic = 'force-dynamic';

/** One invoice or receipt, rendered from its frozen snapshot. Print to PDF from the browser. */
export default async function OwnerInvoicePage({ params }: { params: Promise<{ number: string }> }) {
  const [{ number }, b] = await Promise.all([params, ownerBilling()]);
  const inv = await invoiceByNumber(b.tenantId, decodeURIComponent(number));
  if (!inv) notFound();
  const open = UNPAID_STATUSES.includes(inv.status);
  return (
    <>
      <PageHeader
        eyebrow="Invoice"
        title={inv.number}
        actions={
          <Button href="/owner/billing" variant="ghost" size="sm">
            ← Billing
          </Button>
        }
      />
      <InvoiceView snapshot={inv.data} status={inv.status} paidMinor={Number(inv.paid_minor)} whtMinor={Number(inv.wht_minor)} />
      {open && (
        <form method="post" action="/owner/billing/pay" className="mt-4 flex flex-wrap items-center gap-3">
          <input type="hidden" name="invoice_id" value={inv.id} />
          {!b.owner.email && <input name="email" type="email" required placeholder="Email for your receipt" aria-label="Email for your receipt" className="rounded-md border border-hair bg-[var(--surface)] px-3 py-2 text-sm text-cream" />}
          <Button type="submit">Pay now</Button>
          <span className="text-xs text-muted">or transfer to the account above, quoting {inv.number}.</span>
        </form>
      )}
      <p className="mt-4 text-xs text-muted">
        Need this as a file? Use your browser&apos;s Print and choose &ldquo;Save as PDF&rdquo;. Questions:{' '}
        <Link href="/owner/help" className="text-gold-bright hover:underline">
          ask for help
        </Link>
        .
      </p>
    </>
  );
}
