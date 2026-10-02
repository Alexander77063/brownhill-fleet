import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/context";
import { PageHeader, Card, CardTitle, Badge, Button, Table, Th, Td, EmptyState } from "@/components/ui";
import { InvoiceView } from "@/components/collection/InvoiceView";
import { recordTransferAction, resendInvoiceAction, voidInvoiceAction } from "@/lib/actions/collection";
import { deriveJobsAction } from "@/lib/actions/hardware";
import { deploymentProfile } from "@/lib/deployment/profile";
import { paymentsForInvoice, todayISO, UNPAID_STATUSES, type InvoiceRow } from "@/lib/collection/invoices";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

export default async function CollectionInvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePlatformAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const sb = createServiceClient();
  const { data } = await sb.from("subscription_invoices").select("*, tenants(name)").eq("id", id).maybeSingle();
  if (!data) notFound();
  const inv = data as unknown as InvoiceRow & { tenants: { name: string } | null };
  const [payments, { data: events }] = await Promise.all([
    paymentsForInvoice(inv.tenant_id, inv.id, sb),
    sb.from("subscription_events").select("kind, actor, detail, created_at").eq("invoice_id", inv.id).order("created_at", { ascending: false }),
  ]);
  const open = UNPAID_STATUSES.includes(inv.status);
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const hardwareBuild = deploymentProfile().ownerPortal;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={inv.tenants?.name ?? inv.tenant_id}
        title={inv.number}
        actions={
          <div className="flex gap-2">
            <Button href={`/platform/subscribers/${inv.tenant_id}`} variant="ghost" size="sm">Subscriber</Button>
            <Button href="/platform/collections" variant="ghost" size="sm">← Collections</Button>
          </div>
        }
      />

      {sp.msg && (
        <p role="status" className="rounded-md border border-hair px-3 py-2 text-sm text-parchment">
          {sp.msg}
        </p>
      )}
      {sp.error && (
        <p role="alert" className="rounded-md border border-[var(--color-loss)] px-3 py-2 text-sm text-[var(--color-loss)]">
          {sp.error}
        </p>
      )}

      <InvoiceView snapshot={inv.data} status={inv.status} paidMinor={Number(inv.paid_minor)} whtMinor={Number(inv.wht_minor)} />

      {inv.status === "paid" && hardwareBuild && (
        <form action={deriveJobsAction} className="flex flex-wrap items-center gap-3 text-sm text-muted">
          <input type="hidden" name="invoice_id" value={inv.id} />
          <input type="hidden" name="return_to" value={`/platform/collections/${inv.id}`} />
          <span>Paid lines that carry a job kind became hardware jobs on payment. If the timeline shows a failure, run it again — it only fills gaps.</span>
          <Button type="submit" variant="outline" size="sm">Derive hardware jobs</Button>
          <Link href="/platform/hardware" className="text-gold-bright hover:underline">Open jobs</Link>
        </form>
      )}

      {base && (
        <p className="text-sm text-muted">
          Pay link:{" "}
          <Link href={`/pay/${inv.pay_token}`} className="tnum text-gold-bright hover:underline">
            {base}/pay/{inv.pay_token.slice(0, 8)}…
          </Link>
        </p>
      )}

      {open && (
        <Card>
          <CardTitle>Record a bank transfer</CardTitle>
          <form action={recordTransferAction} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input type="hidden" name="tenant_id" value={inv.tenant_id} />
            <input type="hidden" name="invoice_id" value={inv.id} />
            <label className="block text-xs text-parchment">
              Amount received ({inv.currency})
              <input name="amount" type="number" step="0.01" min="0" required className={`${inputCls} mt-1 w-full`} />
            </label>
            <label className="block text-xs text-parchment">
              Withholding tax deducted ({inv.currency})
              <input name="wht" type="number" step="0.01" min="0" defaultValue="0" className={`${inputCls} mt-1 w-full`} />
            </label>
            <label className="block text-xs text-parchment">
              Received on
              <input name="received_on" type="date" defaultValue={todayISO()} className={`${inputCls} mt-1 w-full`} />
            </label>
            <label className="block text-xs text-parchment sm:col-span-2">
              Bank reference / narration
              <input name="reference" required className={`${inputCls} mt-1 w-full`} />
            </label>
            <label className="block text-xs text-parchment">
              Note
              <input name="note" className={`${inputCls} mt-1 w-full`} />
            </label>
            <div className="sm:col-span-3 flex gap-2">
              <Button type="submit" size="sm">Record payment</Button>
            </div>
          </form>
          <div className="mt-4 flex flex-wrap gap-4">
            <form action={resendInvoiceAction}>
              <input type="hidden" name="tenant_id" value={inv.tenant_id} />
              <input type="hidden" name="invoice_id" value={inv.id} />
              <Button type="submit" variant="outline" size="sm">Resend by SMS / email</Button>
            </form>
            <form action={voidInvoiceAction} className="flex gap-2">
              <input type="hidden" name="tenant_id" value={inv.tenant_id} />
              <input type="hidden" name="invoice_id" value={inv.id} />
              <input name="reason" required placeholder="Reason" aria-label="Void reason" className={inputCls} />
              <Button type="submit" variant="ghost" size="sm">Void invoice</Button>
            </form>
          </div>
        </Card>
      )}

      <Card>
        <CardTitle>Payments</CardTitle>
        {payments.length === 0 ? (
          <EmptyState title="No payments yet" />
        ) : (
          <Table caption="Payments against this invoice">
            <thead>
              <tr>
                <Th>Source</Th>
                <Th>Reference</Th>
                <Th>Amount</Th>
                <Th>Status</Th>
                <Th>Received</Th>
                <Th>Note</Th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <Td>{p.source.replace("_", " ")}</Td>
                  <Td className="tnum">{p.reference}</Td>
                  <Td className="tnum">{(Number(p.amount_minor) / 100).toLocaleString("en-US")} {p.currency}</Td>
                  <Td><Badge tone={p.status === "confirmed" ? "profit" : p.status === "failed" ? "loss" : "info"}>{p.status}</Badge></Td>
                  <Td>{p.received_on ?? p.created_at.slice(0, 10)}</Td>
                  <Td>{p.note ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardTitle>Timeline</CardTitle>
        {!events?.length ? (
          <EmptyState title="No events" />
        ) : (
          <ul className="space-y-1.5 text-sm text-parchment">
            {events.map((e, i) => (
              <li key={i} className="flex gap-3">
                <span className="tnum text-muted">{new Date(e.created_at).toISOString().replace("T", " ").slice(0, 16)}</span>
                <span className="text-cream">{e.kind.replace(/_/g, " ")}</span>
                <span className="text-muted">{e.actor === "system" || e.actor === "gateway" || e.actor === "webhook" ? e.actor : "admin"}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
