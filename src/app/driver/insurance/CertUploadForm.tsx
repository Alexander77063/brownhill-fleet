'use client';

import { useActionState } from 'react';
import { Button, CardTitle } from '@/components/ui';
import { Icon } from '@/components/icons';
import { uploadCertificate, type ActionResult } from '@/lib/actions/driver';

const initial: ActionResult | null = null;

export function CertUploadForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionResult | null, fd: FormData) => uploadCertificate(fd),
    initial,
  );

  const field = 'mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-[rgba(0,0,0,0.25)] px-3 py-2.5 text-sm text-cream placeholder:text-muted focus:border-[var(--color-gold)]';
  const label = 'eyebrow text-parchment';

  return (
    <form action={formAction} className="space-y-4">
      <CardTitle>Upload a certificate</CardTitle>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="insurer">Insurer</label>
          <input id="insurer" name="insurer" required className={field} placeholder="e.g. Aviva" />
        </div>
        <div>
          <label className={label} htmlFor="policy_no">Policy number</label>
          <input id="policy_no" name="policy_no" required className={field} placeholder="POL-000000" />
        </div>
        <div>
          <label className={label} htmlFor="cover_from">Cover from</label>
          <input id="cover_from" name="cover_from" type="date" required className={field} />
        </div>
        <div>
          <label className={label} htmlFor="cover_to">Cover to</label>
          <input id="cover_to" name="cover_to" type="date" required className={field} />
        </div>
      </div>

      <div>
        <label className={label} htmlFor="file">Certificate document (PDF or image)</label>
        <input id="file" name="file" type="file" accept="application/pdf,image/*" className={`${field} file:mr-3 file:rounded file:border-0 file:bg-[rgba(184,151,42,0.15)] file:px-3 file:py-1 file:text-gold-bright`} />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          <Icon name="upload" className="h-4 w-4" /> {pending ? 'Submitting…' : 'Submit for verification'}
        </Button>
        {state && (
          <p className={`text-sm ${state.ok ? 'text-[var(--color-profit)]' : 'text-[var(--color-loss)]'}`}>
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
