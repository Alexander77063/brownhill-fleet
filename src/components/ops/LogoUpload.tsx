'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui';
import { uploadLogoAction, removeLogoAction } from '@/lib/actions/branding';

/** Upload (or replace/remove) the tenant logo — a real file picker, not just a URL
 *  paste. On success the stored logo is served from a stable public URL. */
export function LogoUpload({ hasLogo }: { hasLogo: boolean }) {
  const [state, action, pending] = useActionState(
    async (_prev: { error?: string }, formData: FormData) => uploadLogoAction(formData),
    {},
  );

  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          name="logo"
          aria-label="Choose a logo image to upload"
          accept="image/png,image/jpeg,image/webp,image/gif"
          required
          className="max-w-full text-xs text-muted file:mr-2 file:rounded-md file:border file:border-hair file:bg-[var(--surface)] file:px-2.5 file:py-1.5 file:text-xs file:text-cream hover:file:text-gold-bright"
        />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? 'Uploading…' : hasLogo ? 'Replace logo' : 'Upload logo'}
        </Button>
      </form>
      {hasLogo && (
        <form action={removeLogoAction}>
          <Button type="submit" size="sm" variant="ghost">
            Remove logo
          </Button>
        </form>
      )}
      <div role="alert" aria-live="assertive">
        {state.error && <p className="text-xs text-[var(--color-loss)]">{state.error}</p>}
      </div>
      <p className="text-[11px] text-muted">PNG, JPG, WEBP or GIF · under 2 MB. Or paste a URL below.</p>
    </div>
  );
}
