// src/lib/backup/managed.ts — the project-side off-host adapter surface.
// Default target is Backblaze B2 (S3-compatible, ~$0.005/GB/month, no egress
// within NA/EU). Switch by replacing `backblazeB2` with another OffHostTarget.
import { b2Sync } from './b2';

export interface OffHostTarget {
  push(localPath: string, remotePrefix: string): Promise<void>;
}

export const backblazeB2: OffHostTarget = {
  push: async (localPath, remotePrefix) => {
    const bucket = process.env.BACKBLAZE_B2_BUCKET;
    if (!bucket) throw new Error('BACKBLAZE_B2_BUCKET not set');
    await b2Sync(localPath, `b2://${bucket}/${remotePrefix}/`);
  },
};
