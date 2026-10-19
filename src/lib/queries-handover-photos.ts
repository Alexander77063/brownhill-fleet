// src/lib/queries-handover-photos.ts
// Read access for the agreement_handover_photos table, used by
// /ops/agreements/[id] to render the photo baseline ops compares
// future damage reports to.

import { localDb } from '@/lib/auth/local-store';

export interface HandoverPhotoRow {
  id: string;
  kind: string;
  storagePath: string;
  uploadedAt: string;
}

export async function listHandoverPhotos(agreementId: string): Promise<HandoverPhotoRow[]> {
  const sql = await localDb();
  const rows = (await sql`
    select id, kind, storage_path, uploaded_at
      from agreement_handover_photos
     where agreement_id = ${agreementId}::uuid
     order by uploaded_at asc
  `) as Array<{ id: string; kind: string; storage_path: string; uploaded_at: string }>;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    storagePath: r.storage_path,
    uploadedAt: r.uploaded_at,
  }));
}