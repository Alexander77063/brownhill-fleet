import { PageHeader, Card, CardTitle, Badge, Button } from '@/components/ui';
import { HelpHint } from '@/components/HelpHint';
import { SetupGuide } from '@/components/SetupGuide';
import type { HelpKey } from '@/lib/help-content';
import { contextCan, getAuthContext } from '@/lib/auth/context';
import { getTenantPaymentStatus } from '@/lib/payments/tenant-credentials';
import {
  saveStripeKeyAction,
  saveGoCardlessKeyAction,
  clearStripeAction,
  clearGoCardlessAction,
} from '@/lib/actions/payments';

export const dynamic = 'force-dynamic';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export default async function PaymentsSettingsPage() {
  const ctx = await getAuthContext();

  if (!ctx || !ctx.tenantId || !contextCan(ctx, 'tenant.settings')) {
    return (
      <Wrap>
        <PageHeader eyebrow="Settings" title="Payments" />
        <Card>
          <CardTitle>Access denied</CardTitle>
          <p className="mt-2 text-sm text-muted">
            You don&apos;t have permission to manage payment settings for this organisation.
          </p>
        </Card>
      </Wrap>
    );
  }

  const status = await getTenantPaymentStatus();
  const stripeWebhookHint = `/api/webhooks/stripe/${ctx.tenantId}`;
  const gocardlessWebhookHint = `/api/webhooks/gocardless/${ctx.tenantId}`;

  return (
    <Wrap>
      <PageHeader
        eyebrow="Settings"
        title="Payments"
        subtitle="Connect YOUR OWN Stripe / GoCardless — rent and charges are collected into your account, not the platform's."
      />

      {!status.encryptionAvailable && (
        <Card className="mb-4 border-[var(--color-warn)]">
          <div className="flex items-center gap-2">
            <Badge tone="warn">Unavailable</Badge>
            <CardTitle>Payment encryption not enabled</CardTitle>
          </div>
          <p className="mt-2 text-sm text-muted">
            The server operator hasn&apos;t enabled key encryption yet (
            <code className="text-parchment">TENANT_AI_ENC_KEY</code> is not set), so payment credentials can&apos;t be
            saved on this deployment. Ask your platform operator to configure it.
          </p>
        </Card>
      )}

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ── Stripe ─────────────────────────────────────────────────── */}
        <Card>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Stripe</CardTitle>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={status.stripeConfigured ? 'profit' : 'neutral'}>
                {status.stripeConfigured ? 'Configured' : 'Not set'}
              </Badge>
              <Badge tone={status.stripeWebhookSet ? 'profit' : 'neutral'}>
                {status.stripeWebhookSet ? 'Webhook set' : 'No webhook'}
              </Badge>
              <Badge tone={status.stripeEnabled ? 'profit' : 'neutral'}>
                {status.stripeEnabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
          </div>

          <form action={saveStripeKeyAction} className="mt-3 space-y-3">
            <Field
              label="Secret key"
              help="payments.stripe_key"
              hint="Your own Stripe secret key (sk_live_… / sk_test_…). Encrypted at rest; leave blank to keep the current key."
            >
              <input
                name="stripe_secret"
                type="password"
                autoComplete="off"
                placeholder={status.stripeConfigured ? '•••••• (leave blank to keep)' : 'sk_live_…'}
                className={`${inputCls} w-full`}
              />
            </Field>

            <Field
              label="Webhook signing secret"
              help="payments.webhook_secret"
              hint="From your Stripe webhook endpoint (whsec_…). Leave blank to keep the current one."
            >
              <input
                name="stripe_webhook"
                type="password"
                autoComplete="off"
                placeholder={status.stripeWebhookSet ? '•••••• (leave blank to keep)' : 'whsec_…'}
                className={`${inputCls} w-full`}
              />
            </Field>

            <label className="flex items-center gap-2 text-sm text-cream">
              <input
                type="checkbox"
                name="stripe_enabled"
                defaultChecked={status.stripeEnabled}
                className="accent-[var(--color-gold)]"
              />
              Enable Stripe collection
            </label>

            <Button type="submit" variant="primary" size="sm">
              Save
            </Button>
          </form>

          <div className="mt-4 rounded-md border border-hair-soft bg-[var(--surface-soft)] p-3">
            <p className="text-[11px] uppercase tracking-wider text-parchment">Your webhook URL</p>
            <p className="mt-1 break-all text-xs text-muted">
              Paste this into your Stripe dashboard: <code className="text-cream">{stripeWebhookHint}</code>
            </p>
          </div>

          {status.stripeConfigured && (
            <form action={clearStripeAction} className="mt-4 border-t border-hair-soft pt-4">
              <Button type="submit" variant="outline" size="sm">
                Disconnect Stripe
              </Button>
            </form>
          )}
        </Card>

        {/* ── GoCardless ─────────────────────────────────────────────── */}
        <Card>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>GoCardless</CardTitle>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={status.gocardlessConfigured ? 'profit' : 'neutral'}>
                {status.gocardlessConfigured ? 'Configured' : 'Not set'}
              </Badge>
              <Badge tone={status.gocardlessWebhookSet ? 'profit' : 'neutral'}>
                {status.gocardlessWebhookSet ? 'Webhook set' : 'No webhook'}
              </Badge>
              <Badge tone={status.gocardlessEnabled ? 'profit' : 'neutral'}>
                {status.gocardlessEnabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
          </div>

          <form action={saveGoCardlessKeyAction} className="mt-3 space-y-3">
            <Field
              label="Access token"
              help="payments.gocardless_token"
              hint="Your own GoCardless access token. Encrypted at rest; leave blank to keep the current token."
            >
              <input
                name="gocardless_token"
                type="password"
                autoComplete="off"
                placeholder={status.gocardlessConfigured ? '•••••• (leave blank to keep)' : 'live_… / sandbox_…'}
                className={`${inputCls} w-full`}
              />
            </Field>

            <Field
              label="Webhook secret"
              hint="From your GoCardless webhook endpoint. Leave blank to keep the current one."
            >
              <input
                name="gocardless_webhook"
                type="password"
                autoComplete="off"
                placeholder={status.gocardlessWebhookSet ? '•••••• (leave blank to keep)' : 'webhook secret'}
                className={`${inputCls} w-full`}
              />
            </Field>

            <Field label="Environment">
              <select
                name="gocardless_environment"
                defaultValue={status.gocardlessEnvironment}
                className={`${inputCls} w-full`}
              >
                <option value="sandbox">sandbox</option>
                <option value="live">live</option>
              </select>
            </Field>

            <label className="flex items-center gap-2 text-sm text-cream">
              <input
                type="checkbox"
                name="gocardless_enabled"
                defaultChecked={status.gocardlessEnabled}
                className="accent-[var(--color-gold)]"
              />
              Enable GoCardless collection
            </label>

            <Button type="submit" variant="primary" size="sm">
              Save
            </Button>
          </form>

          <div className="mt-4 rounded-md border border-hair-soft bg-[var(--surface-soft)] p-3">
            <p className="text-[11px] uppercase tracking-wider text-parchment">Your webhook URL</p>
            <p className="mt-1 break-all text-xs text-muted">
              Paste this into your GoCardless dashboard: <code className="text-cream">{gocardlessWebhookHint}</code>
            </p>
          </div>

          {status.gocardlessConfigured && (
            <form action={clearGoCardlessAction} className="mt-4 border-t border-hair-soft pt-4">
              <Button type="submit" variant="outline" size="sm">
                Disconnect GoCardless
              </Button>
            </form>
          )}
        </Card>
      </section>

      <SetupGuide
        className="mt-4"
        title="Connect your payments"
        steps={[
          <>
            <span className="text-parchment">Stripe:</span> Developers → API keys → copy your Secret key → paste it above.
            Then Developers → Webhooks → add the webhook URL shown above → paste its signing secret.
          </>,
          <>
            <span className="text-parchment">GoCardless:</span> Developers → Create access token → paste it above, and add
            the webhook URL shown above in their dashboard.
          </>,
          <>
            Tick <span className="text-parchment">Enable</span> and Save — a test payment confirms it&apos;s live.
          </>,
        ]}
        note="Rent & charges collect into your own account — the platform never touches your customers' money. If a provider isn't configured here, collection through it is refused rather than using anyone else's account."
      />
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</div>;
}

function Field({ label, hint, help, children }: { label: string; hint?: string; help?: HelpKey; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-parchment">
        {label}
        {help && <HelpHint id={help} label={label} />}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}
