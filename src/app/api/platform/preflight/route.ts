import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/auth/context';
import { storagePreflight } from '@/lib/storage-preflight';
import { schemaPreflight } from '@/lib/schema-preflight';

/**
 * Storage preflight. Platform admins only — it reports which backend is configured and how it
 * is failing, which is operational detail, not something to expose publicly.
 *
 * Returns 503 when any bucket fails, so an uptime check can watch this URL directly and catch a
 * storage outage before a user does. That is the whole point: last time, the first thing anyone
 * knew about it was somebody trying to upload a PCO licence.
 */
export const runtime = 'nodejs';
// Never cached: a cached "everything is fine" is worse than no check at all.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Both halves of "can this deployment actually work": can it store bytes, and does the
  // database have the tables this code was built against. Run together so one call answers the
  // question, and concurrently because an operator staring at a spinner runs it less often.
  const [storage, schema] = await Promise.all([storagePreflight(), schemaPreflight()]);
  const ok = storage.ok && schema.ok;
  return NextResponse.json({ ok, storage, schema }, { status: ok ? 200 : 503 });
}
