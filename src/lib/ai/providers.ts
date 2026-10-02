/** Provider adapter for the per-tenant assistant — BYO key across a fixed
 *  allow-list of providers. Base URLs are HARDCODED per provider: a tenant never
 *  supplies an endpoint, so a tenant config string can never become the fetch
 *  target (no SSRF to cloud metadata / internal services). Hand-rolled fetch, no
 *  SDKs, matching the house style (Stripe/Resend/Termii).
 */

export type AiProvider = "anthropic" | "openai" | "google" | "minimax";

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProviderMeta {
  id: AiProvider;
  label: string;
  defaultModel: string;
  suggestedModels: string[];
  keyHint: string;
}

export const AI_PROVIDERS: ProviderMeta[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-sonnet-5",
    suggestedModels: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    keyHint: "Starts with sk-ant-…",
  },
  {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o",
    suggestedModels: ["gpt-4o", "gpt-4o-mini"],
    keyHint: "Starts with sk-…",
  },
  {
    id: "google",
    label: "Google (Gemini)",
    defaultModel: "gemini-1.5-pro",
    suggestedModels: ["gemini-1.5-pro", "gemini-1.5-flash"],
    keyHint: "An AI Studio API key",
  },
  {
    id: "minimax",
    label: "MiniMax",
    defaultModel: "MiniMax-M2",
    suggestedModels: ["MiniMax-M2", "MiniMax-M3"],
    keyHint: "A MiniMax platform API key",
  },
];

export function isAiProvider(v: string): v is AiProvider {
  return v === "anthropic" || v === "openai" || v === "google" || v === "minimax";
}

export function defaultModelFor(provider: AiProvider): string {
  return AI_PROVIDERS.find((p) => p.id === provider)?.defaultModel ?? "";
}

export interface CompleteInput {
  provider: AiProvider;
  apiKey: string;
  model: string;
  system: string;
  messages: AiMessage[];
  maxTokens?: number;
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function failIfNotOk(res: Response, provider: string): Promise<void> {
  if (res.ok) return;
  const detail = await res.text().catch(() => "");
  // Surface a clean, non-leaky message (never echo the key).
  throw new Error(`${provider} request failed (${res.status}): ${detail.slice(0, 240)}`);
}

/** Dispatch a completion to the tenant's chosen provider. */
export async function providerComplete(input: CompleteInput): Promise<{ text: string }> {
  const max = input.maxTokens ?? 1200;

  if (input.provider === "anthropic") {
    const res = await post(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" },
      { model: input.model, max_tokens: max, system: input.system, messages: input.messages },
    );
    await failIfNotOk(res, "Anthropic");
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    return { text: (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim() };
  }

  if (input.provider === "openai") {
    const res = await post(
      "https://api.openai.com/v1/chat/completions",
      { authorization: `Bearer ${input.apiKey}` },
      {
        model: input.model,
        max_tokens: max,
        messages: [{ role: "system", content: input.system }, ...input.messages],
      },
    );
    await failIfNotOk(res, "OpenAI");
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return { text: (json.choices?.[0]?.message?.content ?? "").trim() };
  }

  if (input.provider === "minimax") {
    // MiniMax speaks the OpenAI Chat Completions contract (Bearer + /chat/completions).
    const res = await post(
      "https://api.minimax.io/v1/chat/completions",
      { authorization: `Bearer ${input.apiKey}` },
      {
        model: input.model,
        max_tokens: max,
        messages: [{ role: "system", content: input.system }, ...input.messages],
      },
    );
    await failIfNotOk(res, "MiniMax");
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return { text: (json.choices?.[0]?.message?.content ?? "").trim() };
  }

  // google (Gemini) — system via system_instruction; roles are user/model.
  // Key goes in a header, never the URL (query strings leak via logs/proxies).
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
  const res = await post(
    url,
    { "x-goog-api-key": input.apiKey },
    {
      system_instruction: { parts: [{ text: input.system }] },
      contents: input.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: max },
    },
  );
  await failIfNotOk(res, "Google");
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return { text: parts.map((p) => p.text ?? "").join("").trim() };
}
