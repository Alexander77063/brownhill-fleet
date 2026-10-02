/** Minimal, house-style platform AI client — a hand-rolled fetch, no SDK (mirrors
 *  Stripe / Resend / Termii). Dormant until a key is set: `aiConfigured()` is false
 *  and `aiComplete` throws `AiNotConfiguredError`, which callers surface gracefully.
 *
 *  Provider is env-selectable via `AI_PROVIDER` (default 'anthropic'):
 *   - anthropic          → Anthropic Messages API  (/v1/messages, x-api-key)
 *   - minimax / openai   → OpenAI-compatible Chat Completions (/chat/completions, Bearer)
 *  Each provider has a hardcoded default base URL + model; override with `AI_BASE_URL`
 *  and `AI_MODEL`. The key comes from `AI_API_KEY` (generic) — for anthropic the legacy
 *  `ANTHROPIC_API_KEY` still works. Switching provider is env-only, no code change.
 *
 *  To run the platform AI on MiniMax:
 *    AI_PROVIDER=minimax  AI_API_KEY=<minimax key>  AI_MODEL=MiniMax-M2
 */

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI is not configured. Set AI_API_KEY (and AI_PROVIDER) to enable the copilot.");
    this.name = "AiNotConfiguredError";
  }
}

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export type AiPlatformProvider = "anthropic" | "minimax" | "openai";

const PROVIDER_DEFAULTS: Record<AiPlatformProvider, { base: string; model: string }> = {
  anthropic: { base: "https://api.anthropic.com", model: "claude-sonnet-5" },
  minimax: { base: "https://api.minimax.io/v1", model: "MiniMax-M2" },
  openai: { base: "https://api.openai.com/v1", model: "gpt-4o" },
};

const ANTHROPIC_VERSION = "2023-06-01";

function provider(): AiPlatformProvider {
  const p = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
  return p === "minimax" || p === "openai" ? p : "anthropic";
}

/** The platform AI key for the active provider. Anthropic accepts the legacy
 *  ANTHROPIC_API_KEY; the OpenAI-compatible providers deliberately do NOT, so an
 *  Anthropic key can never be sent to MiniMax/OpenAI by accident. */
function apiKeyFor(p: AiPlatformProvider): string | undefined {
  if (p === "anthropic") {
    return process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.AI_GATEWAY_API_KEY || undefined;
  }
  return process.env.AI_API_KEY || process.env.AI_GATEWAY_API_KEY || undefined;
}

/** True when a key is present for the active provider — the copilot chat is live. */
export function aiConfigured(): boolean {
  return !!apiKeyFor(provider());
}

export interface AiUsage {
  input: number;
  output: number;
}

/** Single-shot completion. Throws AiNotConfiguredError when dormant. Returns the
 *  text plus token usage (for per-tenant platform-AI metering). */
export async function aiComplete(input: {
  system: string;
  messages: AiMessage[];
  maxTokens?: number;
  /** Only honoured for the Anthropic provider (chat vs report model). The OpenAI-
   *  compatible providers use AI_MODEL / the provider default. */
  model?: string;
}): Promise<{ text: string; usage: AiUsage }> {
  const p = provider();
  const key = apiKeyFor(p);
  if (!key) throw new AiNotConfiguredError();

  const base = (process.env.AI_BASE_URL || PROVIDER_DEFAULTS[p].base).replace(/\/$/, "");
  const maxTokens = input.maxTokens ?? 1024;

  if (p === "anthropic") {
    const model = input.model || process.env.AI_MODEL || PROVIDER_DEFAULTS.anthropic.model;
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({ model, max_tokens: maxTokens, system: input.system, messages: input.messages }),
    });
    if (!res.ok) throw new Error(`AI request failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
    return { text, usage: { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 } };
  }

  // OpenAI-compatible (MiniMax / OpenAI). System is folded in as the first message.
  const model = process.env.AI_MODEL || PROVIDER_DEFAULTS[p].model;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: input.system }, ...input.messages],
    }),
  });
  if (!res.ok) throw new Error(`AI request failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = (json.choices?.[0]?.message?.content ?? "").trim();
  return { text, usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 } };
}
