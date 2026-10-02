/** Platform AI copilot — grounds Claude in the operator's real, current metrics.
 *
 *  The copilot is only as good as its context, so every question is answered
 *  against a freshly-computed snapshot (overview + subscriber table) rather than
 *  the model's imagination. Dormant until a key is set (see lib/ai.ts): callers
 *  catch AiNotConfiguredError and show the "add a key" state.
 */
import { aiComplete, type AiMessage } from "@/lib/ai";
import { getPlatformOverview, listSubscribers, type PlatformOverview, type SubscriberRow } from "@/lib/platform/analytics";

export const COPILOT_SYSTEM = `You are the operations copilot for Elite Fleet Management, a multi-tenant SaaS that sells fleet-management software to rental operators. You advise the PLATFORM operator (the vendor), not any single tenant.

You are given a JSON snapshot of the current platform state: subscriber counts, MRR/ARR (in GBP pence), tenants at churn risk with reasons, upcoming renewals, trials ending, and the plan mix. Ground every answer in that data — quote real tenant names and numbers. Money is integer pence; present it as GBP (e.g. 49900 → £499.00).

Be concise, specific, and action-oriented. When asked for improvements or ways to grow revenue, base suggestions on what the data actually shows (e.g. trials about to lapse, add-on attach gaps, tenants near plan limits, past-due accounts). Never invent tenants or metrics that aren't in the snapshot. If the data doesn't support an answer, say so.`;

const pence = (p: number) => `£${(p / 100).toFixed(2)}`;

/** Compact, model-friendly grounding string. Kept small on purpose. */
export function buildCopilotContext(overview: PlatformOverview, subscribers: SubscriberRow[]): string {
  const nonOperator = subscribers.filter((s) => !s.isOperator);
  const snapshot = {
    generatedFor: "platform operator",
    mrr: pence(overview.mrrPence),
    arr: pence(overview.arrPence),
    atRiskMrr: pence(overview.atRiskMrrPence),
    counts: overview.counts,
    planMix: overview.planMix.map((p) => ({ plan: p.planName, subscribers: p.count, mrr: pence(p.mrrPence) })),
    renewalsNext30: overview.renewalsNext30.map((r) => ({ tenant: r.name, inDays: r.daysToEnd })),
    trialsEndingSoon: overview.trialsEndingSoon.map((r) => ({ tenant: r.name, inDays: r.daysToEnd })),
    atRisk: overview.atRisk.map((r) => ({ tenant: r.name, band: r.band, score: r.score, reasons: r.reasons })),
    addonAttach: overview.addonAttach.map((a) => ({ addon: a.name, subscribers: a.count })),
    subscribers: nonOperator.map((s) => ({
      name: s.name,
      plan: s.planName,
      status: s.status,
      mrr: pence(s.mrrPence),
      health: s.health.band,
      vehicles: s.usage.vehicles,
      lastActivity: s.lastActivity,
    })),
  };
  return JSON.stringify(snapshot, null, 2);
}

/** Answer a question grounded in the live platform snapshot. */
export async function askCopilot(question: string, history: AiMessage[] = []): Promise<string> {
  const [overview, subscribers] = await Promise.all([getPlatformOverview(), listSubscribers()]);
  const context = buildCopilotContext(overview, subscribers);
  const messages: AiMessage[] = [
    ...history,
    { role: "user", content: `Current platform snapshot:\n\n${context}\n\n---\n\nQuestion: ${question}` },
  ];
  const { text } = await aiComplete({ system: COPILOT_SYSTEM, messages, maxTokens: 1200 });
  return text;
}
