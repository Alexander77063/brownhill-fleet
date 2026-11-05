/**
 * Send a one-time sign-in code by SMS, for the local-auth builds.
 *
 * Never says whether the number is known: an unknown number gets the same
 * response as a known one, and the code goes nowhere useful. Throttled per
 * phone and per address in the store.
 */
import { NextResponse } from 'next/server';
import { deploymentProfile } from '@/lib/deployment/profile';
import { deploymentBrand } from '@/lib/deployment/brand';
import { issueLoginCode } from '@/lib/auth/otp-store';
import { clientIpFrom } from '@/lib/auth/client-ip';
import { normalisePhone } from '@/lib/phone';
import { platformSms } from '@/lib/sms/platform-sms';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (deploymentProfile().supabaseAuth) return new NextResponse('Not found', { status: 404 });

  let raw = '';
  try {
    raw = String(((await request.json()) as { phone?: unknown }).phone ?? '');
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const phone = normalisePhone(raw);
  if (!phone) return NextResponse.json({ error: 'Enter a valid mobile number.' }, { status: 400 });

  // The address the code is COUNTED against has to be one the caller cannot
  // choose, or the per-address limit is a counter with a reset button: nginx
  // APPENDS the address it saw to whatever the caller sent, so the first
  // element of the list is the caller's own claim. `clientIpFrom` takes the
  // address nginx saw.
  const ip = clientIpFrom(request.headers);
  const issued = await issueLoginCode(phone, ip);
  if ('throttled' in issued) {
    return NextResponse.json(
      { error: 'Too many codes requested. Try again in a few minutes.' },
      { status: 429 },
    );
  }

  await platformSms(
    phone,
    `Your ${deploymentBrand().productName} code is ${issued.code}. It expires in 5 minutes.`,
  );
  return NextResponse.json({ ok: true });
}
