/**
 * Tell the payer an invoice exists: SMS with the pay link (Termii DND route in
 * Nigeria), and an email with the lines and the bank details when there is an
 * address. Used when an invoice is issued from the console and on "resend".
 */
import { logNotification } from '@/lib/comms';
import { deploymentBrand } from '@/lib/deployment/brand';
import { sendEmail } from '@/lib/notify';
import { platformSms } from '@/lib/sms/platform-sms';
import { createServiceClient } from '@/lib/supabase/server';
import { asciiMoney } from './dunning';
import { recordEvent, type InvoiceRow } from './invoices';

type Sb = ReturnType<typeof createServiceClient>;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function invoiceSms(inv: Pick<InvoiceRow, 'number' | 'gross_minor' | 'currency' | 'due_on'>, payUrl: string, brand: string): string {
  const amount = asciiMoney(Number(inv.gross_minor), inv.currency);
  const candidates = [
    `${brand}: invoice ${inv.number} for ${amount}, due ${inv.due_on}. Pay or see bank details:`,
    `Invoice ${inv.number} for ${amount}, due ${inv.due_on}. Pay:`,
    `Invoice ${inv.number} due ${inv.due_on}. Pay:`,
  ];
  const fit = candidates.map((c) => `${c} ${payUrl}`.trim()).find((t) => t.length <= 160 && /^[\x20-\x7e]+$/.test(t));
  return fit ?? `${candidates[2].slice(0, 157 - payUrl.length - 1)}... ${payUrl}`.trim();
}

export function invoiceEmailHtml(inv: InvoiceRow, payUrl: string | null): { subject: string; html: string } {
  const d = inv.data;
  const fmt = (minor: number) => asciiMoney(minor, d.currency);
  const rows = d.lines.map((l) => `<tr><td>${esc(l.description)}</td><td align="right">${l.quantity}</td><td align="right">${fmt(l.unitMinor)}</td><td align="right">${fmt(l.netMinor)}</td></tr>`).join('');
  const bank = d.bank.accountNumber
    ? `<p><strong>Bank transfer:</strong> ${esc(d.bank.bankName)} · ${esc(d.bank.accountName)} · ${esc(d.bank.accountNumber)}<br/>Use <strong>${esc(d.number)}</strong> as the payment reference.</p>`
    : '';
  const html = `
    <p>Invoice <strong>${esc(d.number)}</strong> from ${esc(d.issuer.legalName || d.brand)} — due ${esc(d.dueOn)}.</p>
    <table cellpadding="6" style="border-collapse:collapse">
      <thead><tr><th align="left">Item</th><th align="right">Qty</th><th align="right">Unit</th><th align="right">Net</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="3" align="right">Net</td><td align="right">${fmt(d.totals.netMinor)}</td></tr>
        <tr><td colspan="3" align="right">VAT ${(d.vatRate * 100).toFixed(1)}%</td><td align="right">${fmt(d.totals.vatMinor)}</td></tr>
        <tr><td colspan="3" align="right"><strong>Total</strong></td><td align="right"><strong>${fmt(d.totals.grossMinor)}</strong></td></tr>
      </tfoot>
    </table>
    ${payUrl ? `<p><a href="${esc(payUrl)}">Pay online or view this invoice</a></p>` : ''}
    ${bank}
    <p style="color:#777;font-size:12px">${d.issuer.tin ? `TIN ${esc(d.issuer.tin)}` : ''}${d.issuer.vatNumber ? ` · VAT ${esc(d.issuer.vatNumber)}` : ''}</p>`;
  return { subject: `Invoice ${d.number} — ${fmt(d.totals.grossMinor)} due ${d.dueOn}`, html };
}

export async function notifyInvoiceIssued(
  inv: InvoiceRow,
  opts: { appUrl?: string | null; sb?: Sb; reason?: 'issued' | 'resent' } = {},
): Promise<{ sms: boolean; email: boolean }> {
  const sb = opts.sb ?? createServiceClient();
  const base = (opts.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  const payUrl = base ? `${base}/pay/${inv.pay_token}` : null;
  const brand = deploymentBrand().productName;
  const [{ data: sub }, { data: owner }] = await Promise.all([
    sb.from('tenant_subscription').select('billing_phone, billing_email').eq('tenant_id', inv.tenant_id).maybeSingle(),
    sb.from('vehicle_owners').select('phone, email').eq('tenant_id', inv.tenant_id).order('created_at').limit(1).maybeSingle(),
  ]);
  const phone = sub?.billing_phone || owner?.phone || null;
  const email = sub?.billing_email || owner?.email || (inv.customer.email ?? null);
  const stamp = Date.now();
  let sms = false;
  let mail = false;
  if (phone && payUrl) {
    const text = invoiceSms(inv, payUrl, brand);
    const r = await platformSms(phone, text, { channel: 'dnd' });
    sms = r.sent;
    await logNotification(sb, { tenantId: inv.tenant_id, driverId: null, channel: 'sms', recipient: phone, subject: `Invoice ${inv.number}`, body: text, entityType: 'subscription_invoice', entityId: inv.id, dedupeKey: `sub:${inv.id}:${opts.reason ?? 'issued'}:sms:${stamp}`, status: r.sent ? 'sent' : r.skipped ? 'skipped' : 'failed', error: r.error ?? null });
  }
  if (email) {
    const { subject, html } = invoiceEmailHtml(inv, payUrl);
    const r = await sendEmail(email, subject, html);
    mail = r.sent;
    await logNotification(sb, { tenantId: inv.tenant_id, driverId: null, channel: 'email', recipient: email, subject, body: html, entityType: 'subscription_invoice', entityId: inv.id, dedupeKey: `sub:${inv.id}:${opts.reason ?? 'issued'}:email:${stamp}`, status: r.sent ? 'sent' : r.skipped ? 'skipped' : 'failed', error: r.error ?? null });
  }
  await recordEvent(sb, inv.tenant_id, inv.id, opts.reason === 'resent' ? 'resent' : 'sent', 'system', { sms, email: mail, phone: Boolean(phone), address: Boolean(email) });
  return { sms, email: mail };
}
