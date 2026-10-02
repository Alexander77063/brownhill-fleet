import { type NextRequest, NextResponse } from 'next/server';
import { approveAsPartner } from '@/lib/signing';

export const runtime = 'nodejs';

function poundsToPence(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[£,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

/** Partner confirms the deal figures and hands off to the driver. Public: the
 * token is the authorisation. Returns the driver's sign link to forward. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  }

  const partnerName = String(body.partnerName ?? '').trim();
  if (!partnerName) return NextResponse.json({ error: 'Please enter your name.' }, { status: 400 });

  try {
    const { driverToken } = await approveAsPartner(token, {
      partnerName,
      weeklyGrossPence: poundsToPence(body.weeklyRent),
      depositPence: poundsToPence(body.deposit),
      vehicleValuePence: poundsToPence(body.vehicleValue),
      perMilePence: poundsToPence(body.perMile),
      startMileage: typeof body.startMileage === 'string' ? body.startMileage : undefined,
    });
    const driverUrl = `${new URL(req.url).origin}/sign/${driverToken}`;
    return NextResponse.json({ ok: true, driverUrl });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'could not approve' }, { status: 400 });
  }
}
