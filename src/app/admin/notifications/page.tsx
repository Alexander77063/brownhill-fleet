import { PageHeader, Card, CardTitle, Badge, Button } from '@/components/ui';
import { HelpHint } from '@/components/HelpHint';
import { SetupGuide } from '@/components/SetupGuide';
import type { HelpKey } from '@/lib/help-content';
import { contextCan, getAuthContext } from '@/lib/auth/context';
import { getTenantEmailStatus } from '@/lib/email/tenant-email';
import { getTenantSmsStatus } from '@/lib/sms/tenant-sms';
import { saveTenantEmailAction, clearTenantEmailAction } from '@/lib/actions/email';
import { saveTenantSmsAction, clearTenantSmsAction } from '@/lib/actions/sms';

export const dynamic = 'force-dynamic';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export default async function NotificationsSettingsPage() {
  const ctx = await getAuthContext();
  if (!ctx || !ctx.tenantId || !contextCan(ctx, 'tenant.settings')) {
    return (
      <Wrap>
        <PageHeader eyebrow="Settings" title="Email & notifications" />
        <Card><p className="text-sm text-muted">You don&apos;t have permission to manage notification settings.</p></Card>
      </Wrap>
    );
  }
  const status = await getTenantEmailStatus();
  const sms = await getTenantSmsStatus();

  return (
    <Wrap>
      <PageHeader
        eyebrow="Settings"
        title="Email & notifications"
        subtitle="Connect YOUR OWN email account so driver reminders and alerts arrive from your domain — not ours. Until you connect it, messages are logged but not sent."
      />

      {!status.encryptionAvailable && (
        <Card className="mb-4 border-[var(--color-warn)]">
          <div className="flex items-center gap-2">
            <Badge tone="warn">Unavailable</Badge>
            <CardTitle>Email encryption not enabled</CardTitle>
          </div>
          <p className="mt-2 text-sm text-muted">
            The server operator hasn&apos;t enabled key encryption yet (<code className="text-parchment">TENANT_AI_ENC_KEY</code> is not set),
            so your email key can&apos;t be saved on this deployment. Ask your platform operator to configure it.
          </p>
        </Card>
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card className="flex flex-col justify-between"><span className="eyebrow text-parchment">Key</span><div className="mt-3"><Badge tone={status.hasKey ? 'profit' : 'neutral'}>{status.hasKey ? 'Set' : 'Not set'}</Badge></div></Card>
        <Card className="flex flex-col justify-between"><span className="eyebrow text-parchment">Enabled</span><div className="mt-3"><Badge tone={status.enabled ? 'profit' : 'neutral'}>{status.enabled ? 'On' : 'Off'}</Badge></div></Card>
        <Card className="flex flex-col justify-between"><span className="eyebrow text-parchment">Sending</span><div className="mt-3"><Badge tone={status.ready ? 'profit' : 'neutral'}>{status.ready ? 'Live' : 'Not sending'}</Badge></div></Card>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle>Your email provider</CardTitle>
          <form action={saveTenantEmailAction} className="mt-3 space-y-3">
            <Field label="From name" help="email.enabled" hint="Shown as the sender name.">
              <input name="from_name" defaultValue={status.fromName ?? ''} placeholder="e.g. Brownhill Fleet" className={`${inputCls} w-full`} />
            </Field>
            <Field label="From address" help="email.from_address" hint="Must be on a domain you've verified in Resend.">
              <input name="from_address" type="email" defaultValue={status.fromAddress ?? ''} placeholder="alerts@yourfleet.co.uk" className={`${inputCls} w-full`} />
            </Field>
            <Field label="Reply-to (optional)">
              <input name="reply_to" type="email" defaultValue={status.replyTo ?? ''} placeholder="office@yourfleet.co.uk" className={`${inputCls} w-full`} />
            </Field>
            <Field label="Resend API key" help="email.resend_key" hint="Encrypted at rest; leave blank to keep your current key.">
              <input name="resend_api_key" type="password" autoComplete="off" placeholder={status.hasKey ? '•••••• (leave blank to keep)' : 're_…'} className={`${inputCls} w-full`} />
            </Field>
            <label className="flex items-center gap-2 text-sm text-cream">
              <input type="checkbox" name="email_enabled" value="1" defaultChecked={status.enabled} className="accent-[var(--color-gold)]" />
              Enable email sending
            </label>
            <Button type="submit" variant="primary" size="sm">Save</Button>
          </form>

          {status.hasKey && (
            <form action={clearTenantEmailAction} className="mt-4 border-t border-hair-soft pt-4">
              <Button type="submit" variant="outline" size="sm">Disconnect email</Button>
            </form>
          )}
        </Card>

        <SetupGuide
          title="Set it up in 3 steps"
          steps={[
            <>Create a free account at <span className="text-parchment">resend.com</span>.</>,
            <>Add &amp; <span className="text-parchment">verify your domain</span> (Domains → Add Domain → add the DNS records it gives you at your domain host).</>,
            <>Create an API key (API Keys → Create) and paste it here, with a from-address on your verified domain.</>,
          ]}
          note={
            <>
              This is <span className="text-cream">your own</span> account — your emails, your domain, your sending
              reputation. The platform never sends on your behalf. Until connected, reminders are logged in-app but not
              emailed.
            </>
          }
        />
      </section>

      <div className="mt-10 border-t border-hair pt-8">
        <PageHeader
          eyebrow="Settings"
          title="Text messages (SMS)"
          subtitle="Optional. Connect YOUR OWN Twilio account so driver texts send from your number. Drivers without an email get texted instead. Until connected, SMS is logged but not sent."
        />

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Card className="flex flex-col justify-between"><span className="eyebrow text-parchment">Auth token</span><div className="mt-3"><Badge tone={sms.hasToken ? 'profit' : 'neutral'}>{sms.hasToken ? 'Set' : 'Not set'}</Badge></div></Card>
          <Card className="flex flex-col justify-between"><span className="eyebrow text-parchment">Enabled</span><div className="mt-3"><Badge tone={sms.enabled ? 'profit' : 'neutral'}>{sms.enabled ? 'On' : 'Off'}</Badge></div></Card>
          <Card className="flex flex-col justify-between"><span className="eyebrow text-parchment">Sending</span><div className="mt-3"><Badge tone={sms.ready ? 'profit' : 'neutral'}>{sms.ready ? 'Live' : 'Not sending'}</Badge></div></Card>
        </section>

        <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardTitle>Your Twilio account</CardTitle>
            <form action={saveTenantSmsAction} className="mt-3 space-y-3">
              <Field label="Account SID" help="sms.account_sid" hint="Starts with AC…">
                <input name="account_sid" defaultValue={sms.accountSid ?? ''} placeholder="AC…" className={`${inputCls} w-full`} />
              </Field>
              <Field label="Auth token" help="sms.auth_token" hint="Encrypted at rest; leave blank to keep your current token.">
                <input name="auth_token" type="password" autoComplete="off" placeholder={sms.hasToken ? '•••••• (leave blank to keep)' : 'your Twilio auth token'} className={`${inputCls} w-full`} />
              </Field>
              <Field label="From number" help="sms.from_number" hint="An SMS-capable Twilio number in +E.164 format.">
                <input name="from_number" defaultValue={sms.fromNumber ?? ''} placeholder="+447700900000" className={`${inputCls} w-full`} />
              </Field>
              <label className="flex items-center gap-2 text-sm text-cream">
                <input type="checkbox" name="sms_enabled" value="1" defaultChecked={sms.enabled} className="accent-[var(--color-gold)]" />
                Enable SMS sending
              </label>
              <Button type="submit" variant="primary" size="sm">Save</Button>
            </form>

            {sms.hasToken && (
              <form action={clearTenantSmsAction} className="mt-4 border-t border-hair-soft pt-4">
                <Button type="submit" variant="outline" size="sm">Disconnect SMS</Button>
              </form>
            )}
          </Card>

          <SetupGuide
            title="Set it up in 3 steps"
            steps={[
              <>Create an account at <span className="text-parchment">twilio.com</span> and copy your Account SID &amp; Auth Token from the Console dashboard.</>,
              <>Buy an <span className="text-parchment">SMS-capable number</span> (Phone Numbers → Buy a number) in +E.164 format.</>,
              <>Paste all three here and tick <span className="text-parchment">Enable SMS sending</span>.</>,
            ]}
            note={
              <>
                This is <span className="text-cream">your own</span> Twilio account — your number, your billing. The
                platform never texts on your behalf. Until connected, SMS reminders are logged in-app but not sent.
              </>
            }
          />
        </section>
      </div>
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
