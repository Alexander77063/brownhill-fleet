import { Button } from '@/components/ui';
import { getTenantAiStatus } from '@/lib/ops/assistant';
import AssistantClient from '@/app/ops/assistant/assistant-client';

/**
 * The Fleet Assistant, ready to use out of the box. With hybrid AI it runs on the
 * platform key for any plan that includes AI — no tenant setup required — so the
 * intro reflects HOW it's powered rather than nagging the operator to add a key.
 * A tenant can still bring their own provider key in Settings to be billed direct.
 * Shared by the dedicated Assistant page and the /ops dashboard card.
 */
export async function AssistantPanel() {
  const status = await getTenantAiStatus();

  return (
    <div className="flex flex-col gap-3">
      {status.ready ? (
        <p className="text-xs text-muted">
          {status.usingPlatform
            ? 'Included with your plan — grounded only in your own fleet data. Add your own provider key in Settings to bill it directly.'
            : `Powered by your ${status.provider} key — grounded only in your own fleet data.`}
        </p>
      ) : (
        <NotReadyNote
          reason={notReadyReason(status)}
        />
      )}
      <AssistantClient ready={status.ready} />
    </div>
  );
}

type Reason = 'server' | 'plan' | 'budget' | 'setup';

function notReadyReason(status: {
  encryptionAvailable: boolean;
  platformAvailable: boolean;
  entitled: boolean;
  withinBudget: boolean;
}): Reason {
  if (!status.platformAvailable && !status.encryptionAvailable) return 'server';
  if (!status.entitled) return 'plan';
  if (status.entitled && !status.withinBudget) return 'budget';
  return 'setup';
}

function NotReadyNote({ reason }: { reason: Reason }) {
  const copy: Record<Reason, { text: string; cta?: { href: string; label: string } }> = {
    server: { text: "AI isn't enabled on this server yet — ask your platform operator." },
    plan: {
      text: 'AI isn’t included in your current plan.',
      cta: { href: '/admin', label: 'Upgrade your plan' },
    },
    budget: {
      text: "You've reached this month's AI usage. Add your own provider key to keep going, or upgrade your plan.",
      cta: { href: '/admin/assistant', label: 'Add your own key' },
    },
    setup: {
      text: 'The assistant is switched off. Turn it on, or add your own provider key, in Settings.',
      cta: { href: '/admin/assistant', label: 'Assistant settings' },
    },
  };
  const c = copy[reason];
  return (
    <div className="rounded-[var(--radius)] border border-hair bg-[var(--surface)] px-3 py-2.5">
      <p className="text-sm text-muted">{c.text}</p>
      {c.cta && (
        <div className="mt-2">
          <Button href={c.cta.href} size="sm" variant="outline">
            {c.cta.label}
          </Button>
        </div>
      )}
    </div>
  );
}
