import { PageHeader, Card, CardTitle, Stat, Badge, Button } from '@/components/ui';
import { HelpHint } from '@/components/HelpHint';
import { SetupGuide } from '@/components/SetupGuide';
import type { HelpKey } from '@/lib/help-content';
import { contextCan, getAuthContext } from '@/lib/auth/context';
import { getTenantAiStatus } from '@/lib/ops/assistant';
import { AI_PROVIDERS } from '@/lib/ai/providers';
import { saveTenantAiConfigAction, clearTenantAiKeyAction } from '@/lib/actions/assistant';

export const dynamic = 'force-dynamic';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export default async function AssistantSettingsPage() {
  const ctx = await getAuthContext();

  if (!ctx || !contextCan(ctx, 'tenant.settings')) {
    return (
      <Wrap>
        <Card>
          <CardTitle>Access denied</CardTitle>
          <p className="mt-2 text-sm text-muted">
            You don&apos;t have permission to manage AI assistant settings for this organisation.
          </p>
        </Card>
      </Wrap>
    );
  }

  const status = await getTenantAiStatus();
  const activeProvider = AI_PROVIDERS.find((p) => p.id === status.provider);

  return (
    <Wrap>
      <PageHeader
        eyebrow="Settings"
        title="Fleet Assistant"
        subtitle="AI is included with your plan and works out of the box. Advanced: connect your own provider key to use your own account and model."
      />

      {status.usingPlatform && (
        <Card className="mb-4">
          <div className="flex items-center gap-2">
            <Badge tone="profit">Included</Badge>
            <CardTitle>AI is included with your plan</CardTitle>
          </div>
          <p className="mt-2 text-sm text-muted">
            Your Fleet Assistant answers from your own fleet data — no setup needed.
            {status.platformLimit != null &&
              ` This month: ${status.platformUsed.toLocaleString()} of ${status.platformLimit.toLocaleString()} tokens used.`}
          </p>
          {status.platformLimit != null && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-strong)]">
              <div
                className="h-full bg-[var(--color-gold)]"
                style={{
                  width: `${Math.min(100, Math.round((status.platformUsed / Math.max(1, status.platformLimit)) * 100))}%`,
                }}
              />
            </div>
          )}
        </Card>
      )}

      {!status.encryptionAvailable && (
        <Card className="mb-4 border-[var(--color-warn)]">
          <div className="flex items-center gap-2">
            <Badge tone="warn">Unavailable</Badge>
            <CardTitle>AI encryption not enabled</CardTitle>
          </div>
          <p className="mt-2 text-sm text-muted">
            The server operator hasn&apos;t enabled AI key encryption yet (<code className="text-parchment">TENANT_AI_ENC_KEY</code> is
            not set), so provider keys can&apos;t be saved on this deployment. Ask your platform operator to configure it.
          </p>
        </Card>
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Provider" value={activeProvider?.label ?? status.provider} />
        <Stat label="Model" value={<span className="text-lg">{status.model}</span>} />
        <Card className="flex flex-col justify-between">
          <span className="eyebrow text-parchment">Enabled</span>
          <div className="mt-3">
            <Badge tone={status.enabled ? 'profit' : 'neutral'}>{status.enabled ? 'On' : 'Off'}</Badge>
          </div>
        </Card>
        <Card className="flex flex-col justify-between">
          <span className="eyebrow text-parchment">Key</span>
          <div className="mt-3">
            <Badge tone={status.hasKey ? 'profit' : 'neutral'}>{status.hasKey ? 'Set' : 'Not set'}</Badge>
          </div>
        </Card>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle>Advanced — use your own AI key</CardTitle>
          <p className="mt-1 text-xs text-muted">
            Optional. Connect your own provider account to run on a specific model and be billed directly by your provider
            instead of using your plan&apos;s included allowance.
          </p>
          <form action={saveTenantAiConfigAction} className="mt-3 space-y-3">
            <Field label="Provider">
              <select name="provider" defaultValue={status.provider} className={`${inputCls} w-full`}>
                {AI_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Model"
              help="assistant.model"
              hint={`Suggested: ${AI_PROVIDERS.map((p) => `${p.label} — ${p.suggestedModels.join(', ')}`).join('  ·  ')}`}
            >
              <input
                name="model"
                defaultValue={status.model}
                placeholder={activeProvider?.suggestedModels.join(', ') ?? activeProvider?.defaultModel}
                className={`${inputCls} w-full`}
              />
            </Field>

            <Field
              label="API key"
              help="assistant.api_key"
              hint="Encrypted at rest and never shown again. Leave blank to keep your current key — but if you change provider you must enter that provider's key (the old one is cleared)."
            >
              <input
                name="api_key"
                type="password"
                autoComplete="off"
                placeholder={status.hasKey ? '•••••• (leave blank to keep current)' : 'Paste your API key'}
                className={`${inputCls} w-full`}
              />
            </Field>

            <label className="flex items-center gap-2 text-sm text-cream">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={status.enabled}
                className="accent-[var(--color-gold)]"
              />
              Enable the assistant
            </label>

            <Button type="submit" variant="primary" size="sm">
              Save
            </Button>
          </form>

          {status.hasKey && (
            <form action={clearTenantAiKeyAction} className="mt-4 border-t border-hair-soft pt-4">
              <Button type="submit" variant="outline" size="sm">
                Remove key &amp; disable
              </Button>
            </form>
          )}
        </Card>

        <SetupGuide
          title="Use your own key in 3 steps"
          steps={[
            <>Pick your <span className="text-parchment">provider</span> above (Anthropic, OpenAI or Google).</>,
            <>Create an API key in that provider&apos;s console and copy it.</>,
            <>Paste it into <span className="text-parchment">API key</span>, tick <span className="text-parchment">Enable the assistant</span>, and Save.</>,
          ]}
          note={
            <>
              Optional — AI is included with your plan by default. Your own key runs on your account and model, billed to
              your provider. {activeProvider?.keyHint}
            </>
          }
        />
      </section>
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
