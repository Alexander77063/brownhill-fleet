/**
 * Installation photos: a private bucket, platform admins only, served by signed
 * URL. Path convention `<tenant>/<job>/<n>.<ext>` so a tenant's photos share a
 * prefix should a member view ever be added.
 */
import { storagePut, storageSignedUrl } from '@/lib/storage';

export const PHOTO_BUCKET = 'hardware-jobs';
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

export interface JobPhoto {
  bucket: string;
  path: string;
  label: string | null;
}

export async function putJobPhoto(tenantId: string, jobId: string, index: number, file: File, label: string | null = null): Promise<JobPhoto> {
  if (file.size > PHOTO_MAX_BYTES) throw new Error('Each photo must be under 8 MB.');
  if (!/^image\//.test(file.type)) throw new Error('Only images can be attached to a job.');
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${tenantId}/${jobId}/${index}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { ok, reason } = await storagePut(PHOTO_BUCKET, path, bytes, file.type);
  if (!ok) throw new Error(`Photo upload failed${reason ? `: ${reason}` : ''}.`);
  return { bucket: PHOTO_BUCKET, path, label };
}

export function jobPhotoUrl(photo: JobPhoto): Promise<string | null> {
  return storageSignedUrl(photo.bucket, photo.path, 300);
}
