import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext, contextCan } from '@/lib/auth/context';
import { tenantAcceptedCurrentLegal } from '@/lib/legal-consent';
import { LEGAL_DOCS, LEGAL_UPDATED, OPERATOR } from '@/lib/legal';
import { deploymentBrand } from '@/lib/deployment/brand';
import { acceptLegalAction } from '@/lib/actions/legal';
import { Card, Button } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** Consent gate. A tenant must accept the current Terms/Privacy/AUP before using the
 *  operator app. Owners/admins accept on behalf of the organisation; other users are
 *  told to ask their admin. Already-accepted tenants are sent on to the app. */
export default async function AcceptLegalPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.tenantId) redirect('/admin'); // no tenant yet → create one first
  if (await tenantAcceptedCurrentLegal(ctx.tenantId)) redirect('/ops');

  const canAccept = contextCan(ctx, 'tenant.settings');
  const { error } = await searchParams;

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-2xl px-5 py-12 sm:px-8">
      <p className="eyebrow">{deploymentBrand().productName}</p>
      <h1 className="mt-2 font-display text-3xl text-cream">Review &amp; accept our terms</h1>
      <p className="mt-3 text-sm text-muted">
        Before you continue, please review and accept the documents below (updated {LEGAL_UPDATED}). They govern your
        use of the platform operated by {OPERATOR.entity}.
      </p>

      <Card className="mt-6">
        <ul className="space-y-2">
          {LEGAL_DOCS.map((d) => (
            <li key={d.slug} className="flex items-center gap-2 text-sm">
              <span className="text-gold-bright">→</span>
              <Link href={`/${d.slug}`} target="_blank" className="text-cream hover:text-gold-bright hover:underline">
                {d.title}
              </Link>
              <span className="text-xs text-muted">(opens in a new tab)</span>
            </li>
          ))}
        </ul>

        {canAccept ? (
          <form action={acceptLegalAction} className="mt-5 border-t border-hair-soft pt-4">
            <label className="flex items-start gap-2.5 text-sm text-parchment">
              <input type="checkbox" name="agree" required className="mt-0.5 accent-[var(--color-gold)]" />
              <span>
                I have read and agree, on behalf of my organisation, to all of the documents listed above (the Terms of
                Service, Privacy Policy, Acceptable Use Policy and Data Processing Addendum).
              </span>
            </label>
            {error && <p className="mt-2 text-sm text-[var(--color-loss)]">Please tick the box to continue.</p>}
            <div className="mt-4">
              <Button type="submit" variant="primary" size="sm">
                Accept &amp; continue
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-5 border-t border-hair-soft pt-4 text-sm text-muted">
            An owner or admin of your organisation must review and accept the updated terms before your team can
            continue. Please ask them to sign in.
            <form action="/auth/signout" method="post" className="mt-3">
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        )}
      </Card>
    </main>
  );
}
