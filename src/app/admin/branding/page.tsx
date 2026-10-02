import { PageHeader, Card, CardTitle, Button } from '@/components/ui';
import { HelpHint } from '@/components/HelpHint';
import type { HelpKey } from '@/lib/help-content';
import { contextCan, getAuthContext } from '@/lib/auth/context';
import { getBranding, brandDisplayName } from '@/lib/branding';
import { saveBrandingAction } from '@/lib/actions/branding';
import { CompanyLookup } from '@/components/ops/CompanyLookup';
import { PostcodeLookup } from '@/components/ops/PostcodeLookup';
import { LogoUpload } from '@/components/ops/LogoUpload';
import { SetupGuide } from '@/components/SetupGuide';

export const dynamic = 'force-dynamic';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export default async function BrandingPage() {
  const ctx = await getAuthContext();
  if (!ctx || !contextCan(ctx, 'tenant.settings')) {
    return (
      <Wrap>
        <PageHeader eyebrow="Settings" title="Branding & customization" />
        <Card>
          <p className="text-sm text-muted">You don&apos;t have permission to manage branding for this organisation.</p>
        </Card>
      </Wrap>
    );
  }

  const b = await getBranding();

  return (
    <Wrap>
      <PageHeader
        eyebrow="Settings"
        title="Branding & customization"
        subtitle="Make the portal, emails, and documents your own."
      />

      <Card className="mb-4 flex flex-wrap items-center gap-4">
        {b.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={b.logo_url} alt="logo" style={{ maxHeight: 40 }} />
        ) : (
          <div className="grid h-10 w-10 place-items-center rounded-md border border-hair-soft text-xs text-muted">—</div>
        )}
        <div className="mr-auto">
          <p className="text-[11px] uppercase tracking-wider text-parchment">Preview</p>
          <p className="text-lg text-cream">{brandDisplayName(b)}</p>
        </div>
        <LogoUpload hasLogo={!!b.logo_url} />
      </Card>

      <form action={saveBrandingAction} className="space-y-4">
        <Card>
          <CardTitle>Identity</CardTitle>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Logo URL" hint="paste an image URL" className="sm:col-span-2">
              <input name="logo_url" defaultValue={b.logo_url ?? ''} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Primary colour" hint="e.g. #b8972a">
              <input name="colour_primary" defaultValue={b.colour_primary ?? ''} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Accent colour" hint="e.g. #e8c96a">
              <input name="colour_accent" defaultValue={b.colour_accent ?? ''} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Trading name">
              <input name="trading_name" defaultValue={b.trading_name ?? ''} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Legal name" help="branding.legal_name">
              <input name="legal_name" defaultValue={b.legal_name ?? ''} className={`${inputCls} w-full`} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardTitle>Contact / letterhead</CardTitle>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <PostcodeLookup />
            <Field label="Address" className="sm:col-span-2">
              <textarea name="address" defaultValue={b.address ?? ''} rows={3} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Phone">
              <input name="phone" defaultValue={b.phone ?? ''} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Email">
              <input name="email" defaultValue={b.email ?? ''} className={`${inputCls} w-full`} />
            </Field>
            <Field label="VAT number" help="branding.vat_number">
              <input name="vat_number" defaultValue={b.vat_number ?? ''} className={`${inputCls} w-full`} />
            </Field>
            <CompanyLookup defaultValue={b.company_number} />
            <Field label="Contract footer" hint="shown on agreements & documents" className="sm:col-span-2">
              <textarea name="contract_footer" defaultValue={b.contract_footer ?? ''} rows={3} className={`${inputCls} w-full`} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardTitle>Email</CardTitle>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="From name">
              <input name="email_from_name" defaultValue={b.email_from_name ?? ''} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Reply-to">
              <input name="email_reply_to" defaultValue={b.email_reply_to ?? ''} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Email header" hint="prepended to outgoing emails" className="sm:col-span-2">
              <textarea name="email_header" defaultValue={b.email_header ?? ''} rows={3} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Email footer" hint="appended to outgoing emails" className="sm:col-span-2">
              <textarea name="email_footer" defaultValue={b.email_footer ?? ''} rows={3} className={`${inputCls} w-full`} />
            </Field>
          </div>
        </Card>

        <Button type="submit" variant="primary">Save branding</Button>
      </form>

      <SetupGuide
        className="mt-4"
        title="Make it yours — a few tips"
        steps={[
          <>Enter your company number and use the <span className="text-parchment">lookup</span> to auto-fill your legal name &amp; address.</>,
          <>Add your <span className="text-parchment">VAT number</span> so generated contracts and invoices are compliant.</>,
          <>Paste a <span className="text-parchment">logo URL</span> and set a from-name — these appear across the portal, emails and documents.</>,
        ]}
        note="Your branding shows to your drivers and on everything you send — it never reveals the platform underneath."
      />
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</div>;
}
function Field({
  label,
  hint,
  help,
  className,
  children,
}: {
  label: string;
  hint?: string;
  help?: HelpKey;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block${className ? ` ${className}` : ''}`}>
      <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-parchment">
        {label}
        {help && <HelpHint id={help} label={label} />}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}
