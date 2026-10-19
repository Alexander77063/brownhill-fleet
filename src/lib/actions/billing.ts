'use server';

// src/lib/actions/billing.ts
// Ops-only billing actions. sendPaymentLink is the "send the driver a
// one-tap link" affordance for an overdue agreement: it generates a
// payment_link_tokens row, marks the agreement's outstanding total on
// the SMS, and walks the driver into /driver/payments pre-highlighting
// the agreement when they tap the link.
//
// v1 has no in-app payment flow; the link is the prompt. Ops marks the
// invoice paid by hand once the driver's bank transfer clears.

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { recordAudit } from '@/lib/audit';
import { localDb } from '@/lib/auth/local-store';
import { sendSms } from '@/lib/notify';
import { normalisePhone } from '@/lib/phone';
import {
  generatePaymentLinkToken,
  PAYMENT_LINK_TTL_HOURS,
} from '@/lib/billing/payment-link-token';

export async function sendPaymentLink(formData: FormData): Promise<void> {
  const ctx = await requirePermission('billing.write');

  const agreementId = String(formData.get('agreement_id') ?? '');
  const driverId = String(formData.get('driver_id') ?? '');
  if (!agreementId || !driverId) {
    throw new Error('Missing agreement or driver.');
  }

  const sql = await localDb();

  // Read the driver + agreement + outstanding total so the SMS tells the
  // driver what they're being asked to pay.
  const rows = (await sql`
    select d.full_name as driver_name, d.phone as driver_phone,
           a.tenant_id, coalesce(sum(i.gross_pence), 0)::bigint as outstanding_pence
      from agreements a
      join drivers   d on d.id = ${driverId}::uuid
      left join invoices i on i.agreement_id = a.id
                          and i.status in ('open','overdue')
     where a.id = ${agreementId}::uuid and a.tenant_id = ${ctx.tenantId}::uuid
   group by d.full_name, d.phone, a.tenant_id
  `) as Array<{ driver_name: string; driver_phone: string | null; tenant_id: string; outstanding_pence: string }>;
  const row = rows[0];
  if (!row) throw new Error('Agreement or driver not found.');

  const phone = normalisePhone(row.driver_phone ?? '');
  if (!phone) {
    throw new Error(`${row.driver_name} has no phone number on file.`);
  }

  const token = generatePaymentLinkToken();
  const expiresAt = new Date(Date.now() + PAYMENT_LINK_TTL_HOURS * 3600 * 1000);

  await sql`
    insert into payment_link_tokens
      (token, agreement_id, driver_id, tenant_id, expires_at)
    values
      (${token}, ${agreementId}::uuid, ${driverId}::uuid, ${ctx.tenantId}::uuid, ${expiresAt.toISOString()}::timestamptz)
  `;

  const base = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const url = `${base}/pay/${token}`;
  const amountPence = BigInt(row.outstanding_pence);
  const pounds = (Number(amountPence) / 100).toFixed(2);
  const body = `Hi ${row.driver_name.split(' ')[0]}, you have £${pounds} outstanding on your agreement. Open this link to review and pay: ${url}`;

  let smsStatus = '';
  try {
    const res = await sendSms(phone, body);
    smsStatus = res.sent ? 'sent' : (res.skipped ? 'skipped' : 'failed');
  } catch (e) {
    smsStatus = 'failed';
    console.error('[billing] sendPaymentLink SMS failed', e);
  }

  // Record the SMS status on the row so ops can audit whether the link
  // actually reached the driver.
  await sql`
    update payment_link_tokens
       set sms_status = ${smsStatus}
     where token = ${token}
  `;

  revalidatePath('/ops/billing');
  revalidatePath('/driver/payments');

  await recordAudit({
    action: 'payment_link.sent',
    entityType: 'agreement',
    entityId: agreementId,
    detail: { driverId, smsStatus, tokenLast4: token.slice(-4), outstandingPence: row.outstanding_pence },
  });
}