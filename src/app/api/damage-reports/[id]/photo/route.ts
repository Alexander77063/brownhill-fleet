/**
 * Serve the photo attached to a driver damage report.
 *
 * WHY THIS ROUTE EXISTS
 * ---------------------
 * The incident queue linked "View photo" at `/api/receipts/media/<path>`.
 * That route resolves `charge_media.id` — a media ROW's id — and the queue was
 * handing it a `driver_damage_reports.photo_path`, which is a path into the
 * storage bucket. Every click was a 404: the route looked for a media row
 * whose id happened to be a storage path, found none, and said "Not found".
 *
 * So the photo exists, the operator can see it in the driver's own report,
 * and the queue cannot show it to them.
 *
 * THE RULE
 * -------
 * The path is resolved from the report row, scoped to the caller's tenant,
 * and only then signed. No client-supplied path is ever signed — the same
 * guard as `/api/receipts` and `/api/receipts/media/[id]`. A caller who
 * guesses a report id learns only about reports in their own tenant.
 */
import { NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/context';
import { createServiceClient } from '@/lib/supabase/server';
import { signReceiptUrl } from '@/lib/receipts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAuthContext();
  if (!ctx?.tenantId) return new NextResponse('Unauthorised', { status: 401 });

  const sb = createServiceClient();
  // `driver_damage_reports` is not in the generated types yet — it was added
  // by migration 0073 and `src/lib/supabase/database.types.ts` has not been
  // regenerated since. Every other reader of this table casts it the same
  // way (`src/lib/queries-driver-damage.ts`, `src/lib/actions/ops-incidents.ts`),
  // so this file is not the odd one out.
  const { data } = await sb
    .from('driver_damage_reports' as never)
    .select('photo_path')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  const photoPath = (data as { photo_path: string | null } | null)?.photo_path;
  if (!photoPath) return new NextResponse('Not found', { status: 404 });

  const url = await signReceiptUrl(photoPath);
  if (!url) return new NextResponse('Not found', { status: 404 });
  return NextResponse.redirect(url);
}
