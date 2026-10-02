import { type NextRequest, NextResponse } from 'next/server';
import { submitDriverSignature } from '@/lib/signing';

export const runtime = 'nodejs';

/** Driver submits their signature, sealing the agreement. Public: the token is
 * the authorisation. The signer's IP is captured server-side for the audit. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  }

  const driverName = String(body.driverName ?? '').trim();
  const signatureDataUrl = String(body.signature ?? '');
  if (!driverName) return NextResponse.json({ error: 'Please type your full name.' }, { status: 400 });
  if (!signatureDataUrl) return NextResponse.json({ error: 'Please add your signature.' }, { status: 400 });

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  try {
    // Only the signature image crosses the wire; the signed document is built
    // server-side from the trusted session record (no client-supplied HTML).
    await submitDriverSignature(token, { driverName, signatureDataUrl, ip });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'could not submit' }, { status: 400 });
  }
}
