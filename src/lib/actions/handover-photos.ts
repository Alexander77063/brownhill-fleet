'use server';

// src/lib/actions/handover-photos.ts
// Public-action (no driver login needed): the /sign/<token>/handover page
// uploads photos against a valid signing token. The token is the auth
// boundary here, so we go through the service-role client and verify the
// session + its tenant before writing anything.

import { localDb } from '@/lib/auth/local-store';
import { createServiceClient } from '@/lib/supabase/server';
import { storagePut, HANDOVER_PHOTO_BUCKET } from '@/lib/storage';
import { isValidHandoverPhotoKind } from '@/lib/sign/handover-photo';

export interface HandoverUploadResult {
  ok: boolean;
  message: string;
  uploaded?: number;
}

interface SessionCheck {
  id: string;
  agreement_id: string | null;
  tenant_id: string;
  status: string;
}

export async function recordHandoverPhotos(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  if (!token) throw new Error('Missing signing token.');

  // Verify the token — same lookup the public sign page uses.
  const sql = await localDb();
  const sessions = (await sql`
    select id, agreement_id, tenant_id, status
      from signing_sessions
     where partner_token = ${token}
        or driver_token = ${token}
     limit 1
  `) as SessionCheck[];
  const session = sessions[0];
  if (!session) throw new Error('Invalid signing link.');
  if (!session.agreement_id) throw new Error('No agreement on this signing session.');
  if (session.status !== 'driver_sign' && session.status !== 'signed') {
    throw new Error('Photos can only be uploaded once both parties have signed.');
  }

  // Pull the agreement to learn vehicle_id and the linked driver.
  const ag = (await sql`
    select vehicle_id, driver_id
      from agreements
     where id = ${session.agreement_id}::uuid
  `) as Array<{ vehicle_id: string | null; driver_id: string | null }>;
  const agreementRow = ag[0];

  const sb = createServiceClient();
  let uploaded = 0;
  const files = formData.getAll('photo');
  for (const f of files) {
    if (!(f instanceof File) || f.size === 0) continue;
    const kind = String(formData.get(`kind_${f.name}`) ?? formData.get('kind') ?? 'other');
    if (!isValidHandoverPhotoKind(kind)) continue;

    const ext = f.name.match(/\.(jpe?g|png|webp|heic|heif)$/i)?.[0]?.toLowerCase() ?? '.jpg';
    const path = `tenants/${session.tenant_id}/handover/${session.agreement_id}/${kind}/${Date.now()}-${uploaded}${ext}`;

    const buf = new Uint8Array(await f.arrayBuffer());
    await storagePut(HANDOVER_PHOTO_BUCKET, path, buf, f.type || 'image/jpeg');

    const { error } = await sb.from('agreement_handover_photos' as never).insert({
      agreement_id: session.agreement_id,
      driver_id: agreementRow?.driver_id ?? null,
      vehicle_id: agreementRow?.vehicle_id ?? null,
      tenant_id: session.tenant_id,
      kind,
      storage_path: path,
    } as never);
    if (!error) uploaded++;
  }

  if (uploaded === 0) {
    throw new Error('No photos uploaded. Check the file types and try again.');
  }
}