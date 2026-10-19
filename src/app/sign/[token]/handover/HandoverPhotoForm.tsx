'use client';

import { useActionState } from 'react';
import { recordHandoverPhotos } from '@/lib/actions/handover-photos';
import {
  HANDOVER_PHOTO_LABELS,
  type HandoverPhotoKind,
  MIN_HANDOVER_PHOTOS,
} from '@/lib/sign/handover-photo';

const initial: { error: string | null } | null = null;

export function HandoverPhotoForm({
  token,
  presentKinds,
  kinds,
}: {
  token: string;
  presentKinds: string[];
  kinds: ReadonlyArray<HandoverPhotoKind>;
}) {
  const [state, formAction, pending] = useActionState(
    async (_prev: { error: string | null } | null, fd: FormData) => {
      try {
        await recordHandoverPhotos(fd);
        return { error: null };
      } catch (e) {
        return { error: e instanceof Error ? e.message : 'Upload failed' };
      }
    },
    initial,
  );

  const inputCls =
    'block w-full rounded-md border border-hair bg-[var(--surface)] px-3 py-2 text-sm text-cream file:mr-3 file:rounded file:border-0 file:bg-[rgba(184,151,42,0.15)] file:px-3 file:py-1 file:text-gold-bright';

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="token" value={token} />

      {kinds.map((kind) => {
        const recorded = presentKinds.includes(kind);
        return (
          <div
            key={kind}
            className="rounded-md border border-hair-soft bg-[var(--surface-soft)] p-3"
          >
            <label className="block">
              <span className="eyebrow text-parchment flex items-center gap-2">
                {HANDOVER_PHOTO_LABELS[kind]}
                {recorded && (
                  <span className="text-[10px] rounded-full bg-emerald-500/20 px-2 py-0.5 text-emerald-300">
                    recorded
                  </span>
                )}
              </span>
              <input
                type="file"
                name="photo"
                accept="image/*"
                capture="environment"
                className={inputCls}
              />
              <input type="hidden" name={`kind_${/*file.name is not knowable at SSR*/''}`} value={kind} />
              <input type="hidden" name="kind" value={kind} />
            </label>
          </div>
        );
      })}

      {pending && (
        <p className="text-sm text-muted">Uploading…</p>
      )}
      {state?.error && (
        <p className="text-sm text-[var(--color-loss)]" role="alert">{state.error}</p>
      )}
      {state?.error === null && (
        <p className="text-sm text-[var(--color-profit)]" role="status">Photos recorded — you can add more if you like.</p>
      )}
      <p className="text-xs text-muted">
        Aim for at least {MIN_HANDOVER_PHOTOS} photos (one per side). You can upload more than one per side.
      </p>
      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-md bg-gradient-to-b from-gold-bright to-gold text-on-gold px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {pending ? 'Uploading…' : 'Save photos'}
      </button>
    </form>
  );
}