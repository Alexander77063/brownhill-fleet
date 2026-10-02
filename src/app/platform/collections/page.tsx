import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth/context";
import { PageHeader, Card, CardTitle, Badge, Button, Table, Th, Td, EmptyState, Stat } from "@/components/ui";
import { recordTransferAction, resendInvoiceAction, voidInvoiceAction } from "@/lib/actions/collection";
import { regionOf } from "@/lib/catalogue/region";
import { todayISO, UNPAID_STATUSES, type InvoiceStatus } from "@/lib/collection/invoices";
import { formatMoney } from "@/lib/money";
import { pageAll } from "@/lib/page-all";
import { deploymentProfile } from "@/lib/deployment/profile";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-hair bg-[var(--surface)] px-2 py-1 text-xs text-cream focus:border-gold-bright focus:outline-none";

const TONE: Record<string, "profit" | "info" | "loss" | "neutral" | "warn"> = {
  issued: "info",
  part_paid: "warn",
  paid: "profit",
  overdue: "loss",
  void: "neutral",
  draft: "neutral",
};

interface Row {
  id: string;
  tenant_id: string;
  number: string;
  kind: string;
  status: InvoiceStatus;
  issued_on: string;
  due_on: string;
  currency: string;
  gross_minor: number;
  paid_minor: number;
  wht_minor: number;
  tenants: { name: string } | null;
}

/** Every subscription invoice across tenants: what is out, what is late, what came in. */
export default async function CollectionsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requirePlatformAdmin();
  const { status } = await searchParams;
  const sb = createServiceClient();
  const region = deploymentProfile().region;
  const fmt = (minor: number) => formatMoney(minor, { region });
  const today = todayISO();
  const rows = await pageAll<Row>((from, to) => {
    let q = sb.from("subscription_invoices").select("id, tenant_id, number, kind, status, issued_on, due_on, currency, gross_minor, paid_minor, wht_minor, tenants(name)").order("issued_on", { ascending: false }).order("created_at", { ascending: false }).range(from, to);
    if (status === "unpaid") q = q.in("status", UNPAID_STATUSES);
    else if (status) q = q.eq("status", status);
    return q as unknown as PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
  });

  const unpaid = rows.filter((r) => UNPAID_STATUSES.includes(r.status));
  const outstanding = unpaid.reduce((s, r) => s + Number(r.gross_minor) - Number(r.paid_minor) - Number(r.wht_minor), 0);
  const overdue = unpaid.filter((r) => r.due_on < today);
  const month = today.slice(0, 7);
  const paidThisMonth = rows.filter((r) => r.status === "paid" && r.issued_on.startsWith(month)).reduce((s, r) => s + Number(r.paid_minor), 0);
  const wht = rows.reduce((s, r) => s + Number(r.wht_minor), 0);

  const filters: { key: string; label: string }[] = [
    { key: "", label: "All" },
    { key: "unpaid", label: "Unpaid" },
    { key: "overdue", label: "Overdue" },
    { key: "paid", label: "Paid" },
    { key: "void", label: "Void" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Platform" title="Collections" subtitle="Subscription invoices we have issued, across every tenant. Record transfers here; gateway payments arrive on their own." />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Outstanding" value={<span className="tnum">{fmt(outstanding)}</span>} tone="gold" />
        <Stat label="Overdue invoices" value={<span className="tnum">{overdue.length}</span>} />
        <Stat label="Paid this month" value={<span className="tnum">{fmt(paidThisMonth)}</span>} />
        <Stat label="WHT credited" value={<span className="tnum">{fmt(wht)}</span>} />
      </div>

      <nav aria-label="Filter invoices" className="flex flex-wrap gap-2 text-sm">
        {filters.map((f) => (
          <Link
            key={f.key}
            href={f.key ? `/platform/collections?status=${f.key}` : "/platform/collections"}
            className={`rounded-full border px-3 py-1 ${(status ?? "") === f.key ? "border-gold-bright text-cream" : "border-hair text-muted hover:text-cream"}`}
            aria-current={(status ?? "") === f.key ? "page" : undefined}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      <Card>
        <CardTitle>Invoices</CardTitle>
        {rows.length === 0 ? (
          <EmptyState title="No invoices" hint="Issue a tenant's first invoice from its subscriber page." />
        ) : (
          <Table caption="Subscription invoices">
            <thead>
              <tr>
                <Th>Number</Th>
                <Th>Tenant</Th>
                <Th>Kind</Th>
                <Th>Issued</Th>
                <Th>Due</Th>
                <Th>Gross</Th>
                <Th>Outstanding</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const due = Number(r.gross_minor) - Number(r.paid_minor) - Number(r.wht_minor);
                const open = UNPAID_STATUSES.includes(r.status);
                const late = open && r.due_on < today;
                return (
                  <tr key={r.id}>
                    <Td>
                      <Link href={`/platform/collections/${r.id}`} className="tnum underline-offset-2 hover:underline">
                        {r.number}
                      </Link>
                    </Td>
                    <Td>
                      <Link href={`/platform/subscribers/${r.tenant_id}`} className="hover:underline">
                        {r.tenants?.name ?? r.tenant_id.slice(0, 8)}
                      </Link>
                    </Td>
                    <Td>{r.kind.replace("_", " ")}</Td>
                    <Td>{r.issued_on}</Td>
                    <Td className={late ? "text-[var(--color-loss)]" : undefined}>{r.due_on}</Td>
                    <Td className="tnum">{formatMoney(Number(r.gross_minor), { region: regionOf({ region: r.currency === "GBP" ? "uk" : "ng" }) })}</Td>
                    <Td className="tnum">{open ? fmt(Math.max(0, due)) : "—"}</Td>
                    <Td>
                      <Badge tone={TONE[late ? "overdue" : r.status] ?? "neutral"}>{late ? "overdue" : r.status.replace("_", " ")}</Badge>
                    </Td>
                    <Td>
                      {open && (
                        <details>
                          <summary className="cursor-pointer text-xs text-gold-bright">Record transfer</summary>
                          <form action={recordTransferAction} className="mt-2 grid grid-cols-2 gap-1.5">
                            <input type="hidden" name="tenant_id" value={r.tenant_id} />
                            <input type="hidden" name="invoice_id" value={r.id} />
                            <input name="amount" type="number" step="0.01" min="0" required placeholder="Amount received" aria-label="Amount received (major units)" className={inputCls} />
                            <input name="wht" type="number" step="0.01" min="0" placeholder="WHT deducted" aria-label="Withholding tax deducted (major units)" className={inputCls} />
                            <input name="received_on" type="date" defaultValue={today} aria-label="Received on" className={inputCls} />
                            <input name="reference" required placeholder="Bank reference" aria-label="Bank reference" className={inputCls} />
                            <Button type="submit" size="sm" className="col-span-2">Record</Button>
                          </form>
                          <form action={voidInvoiceAction} className="mt-2 flex gap-1.5">
                            <input type="hidden" name="tenant_id" value={r.tenant_id} />
                            <input type="hidden" name="invoice_id" value={r.id} />
                            <input name="reason" required placeholder="Void reason" aria-label="Void reason" className={inputCls} />
                            <Button type="submit" variant="outline" size="sm">Void</Button>
                          </form>
                          <form action={resendInvoiceAction} className="mt-2">
                            <input type="hidden" name="tenant_id" value={r.tenant_id} />
                            <input type="hidden" name="invoice_id" value={r.id} />
                            <Button type="submit" variant="ghost" size="sm">Resend</Button>
                          </form>
                        </details>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
