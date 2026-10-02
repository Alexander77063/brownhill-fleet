import { type NextRequest, NextResponse } from 'next/server';
import { contextCan, getAuthContext } from '@/lib/auth/context';
import { importDrivers, importPcns, importVehicles } from '@/lib/import';

export const runtime = 'nodejs';

/** Bulk import vehicles/drivers from CSV. Dry-run by default; committing needs
 * fleet.write (vehicles) or drivers.write (drivers). */
export async function POST(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx?.tenantId) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  }

  const entity = body.entity === 'drivers' ? 'drivers' : body.entity === 'pcn' ? 'pcn' : 'vehicles';
  const perm = entity === 'vehicles' ? 'fleet.write' : entity === 'drivers' ? 'drivers.write' : 'billing.write';
  if (!contextCan(ctx, perm)) return NextResponse.json({ error: 'You cannot import this.' }, { status: 403 });

  const dryRun = body.dryRun !== false; // default true
  const csv = String(body.csv ?? '');
  if (!csv.trim()) return NextResponse.json({ error: 'Please paste some CSV data.' }, { status: 400 });

  try {
    const result =
      entity === 'vehicles'
        ? await importVehicles(ctx.tenantId, csv, dryRun, ctx.userId)
        : entity === 'drivers'
          ? await importDrivers(ctx.tenantId, csv, dryRun, ctx.userId)
          : await importPcns(ctx.tenantId, csv, dryRun, ctx.userId);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'import failed' }, { status: 400 });
  }
}
