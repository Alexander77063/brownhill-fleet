import { getBranding, checkBrandingComplete } from '@/lib/branding';
import { Icon } from '@/components/icons';

/**
 * Server component: a persistent nudge shown while the tenant's company identity
 * is incomplete. Contract generation is blocked until these fields are set (see
 * the contracts route), so this explains why and links straight to Branding.
 * Renders nothing once branding is complete.
 */
export async function BrandingNotice() {
  const branding = await getBranding();
  const { complete, missing } = checkBrandingComplete(branding);
  if (complete) return null;

  return (
    <div
      className="mb-4 flex items-start gap-3 rounded-[var(--radius)] border-l-4 border border-[var(--color-loss)] px-4 py-3"
      style={{ background: 'rgba(214, 88, 79, 0.12)' }}
      role="alert"
    >
      <span className="mt-0.5 text-[var(--color-loss)]">
        <Icon name="alert" />
      </span>
      <div className="min-w-0 text-sm">
        <p className="font-semibold text-[var(--color-loss)]">
          Finish your company details to generate agreements
        </p>
        <p className="mt-1 text-parchment">
          Contracts are issued under your company. Add <strong className="text-cream">{missing.join(', ')}</strong> in
          Settings → Branding — until then agreement generation is blocked, so none of the
          platform&apos;s details appear on your contracts.
        </p>
        <a href="/admin/branding" className="mt-2 inline-block font-semibold text-gold-bright hover:underline">
          Go to Branding →
        </a>
      </div>
    </div>
  );
}
