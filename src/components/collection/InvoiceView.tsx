import { regionOf } from "@/lib/catalogue/region";
import type { InvoiceSnapshot } from "@/lib/collection/invoices";
import { formatMoney } from "@/lib/money";

/**
 * A subscription invoice, rendered ONLY from its frozen snapshot — the same
 * page for the console, the owner portal, the ops billing page and the public
 * pay link, and printable to PDF. Nothing here reads a live price.
 */
export function InvoiceView({
  snapshot: d,
  status,
  paidMinor,
  whtMinor,
}: {
  snapshot: InvoiceSnapshot;
  status: string;
  paidMinor: number;
  whtMinor: number;
}) {
  const region = regionOf({ region: d.region });
  const fmt = (minor: number) => formatMoney(minor, { region });
  const outstanding = Math.max(0, d.totals.grossMinor - paidMinor - whtMinor);
  const label = status === "paid" ? "PAID" : status === "void" ? "VOID" : status === "overdue" ? "OVERDUE" : status === "part_paid" ? "PART PAID" : "DUE";

  return (
    <article className="rounded-lg border border-hair bg-[var(--surface)] p-6 text-sm text-cream print:border-0 print:bg-white print:text-black">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-hair pb-4">
        <div>
          <p className="font-display text-xl">{d.issuer.legalName || d.brand}</p>
          {d.issuer.address && <p className="whitespace-pre-line text-muted">{d.issuer.address}</p>}
          <p className="text-muted">
            {d.issuer.tin && <>TIN {d.issuer.tin}</>}
            {d.issuer.vatNumber && <> · VAT {d.issuer.vatNumber}</>}
          </p>
        </div>
        <div className="text-right">
          <p className="eyebrow">Invoice</p>
          <p className="font-display text-lg tnum">{d.number}</p>
          <p className="mt-1 inline-block rounded border border-hair px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wider">{label}</p>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 py-4 sm:grid-cols-3">
        <div>
          <p className="eyebrow">Billed to</p>
          <p>{d.customer.name}</p>
          {d.customer.address && <p className="whitespace-pre-line text-muted">{d.customer.address}</p>}
          {d.customer.tin && <p className="text-muted">TIN {d.customer.tin}</p>}
          {d.customer.email && <p className="text-muted">{d.customer.email}</p>}
          {d.customer.phone && <p className="text-muted">{d.customer.phone}</p>}
        </div>
        <div>
          <p className="eyebrow">Dates</p>
          <p>Issued {d.issuedOn}</p>
          <p>Due {d.dueOn}</p>
          {d.period && (
            <p className="text-muted">
              Covers {d.period.start} to {d.period.end}
            </p>
          )}
        </div>
        <div>
          <p className="eyebrow">Kind</p>
          <p className="capitalize">{d.kind.replace("_", " ")}</p>
          {d.note && <p className="text-muted">{d.note}</p>}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <caption className="sr-only">Invoice lines</caption>
          <thead>
            <tr className="border-b border-hair text-[0.6875rem] uppercase tracking-wider text-muted">
              <th scope="col" className="py-2 pr-3">Item</th>
              <th scope="col" className="py-2 pr-3 text-right">Qty</th>
              <th scope="col" className="py-2 pr-3 text-right">Unit</th>
              <th scope="col" className="py-2 pr-3 text-right">Net</th>
              <th scope="col" className="py-2 pr-3 text-right">VAT</th>
              <th scope="col" className="py-2 text-right">Gross</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l, i) => (
              <tr key={i} className="border-b border-hair-soft">
                <td className="py-2 pr-3">{l.description}</td>
                <td className="py-2 pr-3 text-right tnum">{l.quantity}</td>
                <td className="py-2 pr-3 text-right tnum">{fmt(l.unitMinor)}</td>
                <td className="py-2 pr-3 text-right tnum">{fmt(l.netMinor)}</td>
                <td className="py-2 pr-3 text-right tnum">{fmt(l.vatMinor)}</td>
                <td className="py-2 text-right tnum">{fmt(l.grossMinor)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} className="pt-3 text-right text-muted">Net</td>
              <td className="pt-3 text-right tnum">{fmt(d.totals.netMinor)}</td>
            </tr>
            <tr>
              <td colSpan={5} className="text-right text-muted">VAT {(d.vatRate * 100).toFixed(1)}%</td>
              <td className="text-right tnum">{fmt(d.totals.vatMinor)}</td>
            </tr>
            <tr className="font-semibold">
              <td colSpan={5} className="text-right">Total</td>
              <td className="text-right tnum">{fmt(d.totals.grossMinor)}</td>
            </tr>
            {(paidMinor > 0 || whtMinor > 0) && (
              <>
                {paidMinor > 0 && (
                  <tr>
                    <td colSpan={5} className="text-right text-muted">Paid</td>
                    <td className="text-right tnum">{fmt(paidMinor)}</td>
                  </tr>
                )}
                {whtMinor > 0 && (
                  <tr>
                    <td colSpan={5} className="text-right text-muted">Withholding tax credited</td>
                    <td className="text-right tnum">{fmt(whtMinor)}</td>
                  </tr>
                )}
                <tr className="font-semibold">
                  <td colSpan={5} className="text-right">Outstanding</td>
                  <td className="text-right tnum">{fmt(outstanding)}</td>
                </tr>
              </>
            )}
          </tfoot>
        </table>
      </div>

      {d.bank.accountNumber && status !== "paid" && status !== "void" && (
        <section className="mt-4 rounded-md border border-hair p-3">
          <p className="eyebrow">Pay by bank transfer</p>
          <p>
            {d.bank.bankName} · {d.bank.accountName} · <span className="tnum">{d.bank.accountNumber}</span>
          </p>
          <p className="text-muted">
            Use <span className="tnum">{d.number}</span> as the payment reference.
          </p>
        </section>
      )}

      <footer className="mt-4 text-[11px] text-muted">
        Prices are VAT-exclusive; VAT is charged at {(d.vatRate * 100).toFixed(1)}%. Protection starts when payment is confirmed.
      </footer>
    </article>
  );
}
