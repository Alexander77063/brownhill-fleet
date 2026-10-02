"use client";

import { useState } from "react";
import { Card, CardTitle, Button } from "@/components/ui";

const inputCls =
  "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

type Message = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "Which tenants are about to churn?",
  "How do I grow MRR?",
  "Draft a renewal reminder",
];

export default function CopilotClient({ configured }: { configured: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(question: string) {
    const q = question.trim();
    if (!q || loading) return;

    const history = messages.slice(-10);
    const next: Message[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/platform/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });
      const json = await res.json().catch(() => ({}) as Record<string, unknown>);

      if (res.ok) {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: String(json.answer ?? "") },
        ]);
      } else if (res.status === 503) {
        setError(String(json.error ?? "Copilot is dormant."));
      } else {
        setError(String(json.error ?? "Copilot failed"));
      }
    } catch {
      setError("Copilot failed — could not reach the server.");
    } finally {
      setLoading(false);
    }
  }

  function onFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit(input);
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-2">
        <CardTitle>Chat</CardTitle>
        {!configured && (
          <span className="text-xs text-[var(--color-warn)]">
            Offline — add a key to enable
          </span>
        )}
      </div>

      {/* Message list */}
      <div className="max-h-[28rem] min-h-[8rem] space-y-3 overflow-y-auto rounded-md border border-hair-soft bg-[var(--surface-soft)] p-4">
        {messages.length === 0 ? (
          <p className="text-sm text-muted">
            Ask about churn, renewals, expansion, or revenue. Answers are
            grounded in your live platform data.
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={
                m.role === "user" ? "flex justify-end" : "flex justify-start"
              }
            >
              <div
                className={
                  m.role === "user"
                    ? "max-w-[85%] whitespace-pre-wrap rounded-md border border-hair-soft px-3 py-2 text-sm text-muted"
                    : "max-w-[85%] whitespace-pre-wrap rounded-md border border-hair px-3 py-2 text-sm text-cream"
                }
              >
                {m.content}
              </div>
            </div>
          ))
        )}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-md border border-hair px-3 py-2 text-sm text-muted">
              Thinking…
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-[var(--color-loss)]">{error}</p>}

      {/* Suggested-question chips */}
      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <Button
            key={s}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setInput(s)}
          >
            {s}
          </Button>
        ))}
      </div>

      {/* Composer */}
      <form onSubmit={onFormSubmit} className="flex flex-col gap-2">
        <textarea
          aria-label="Ask the platform copilot"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!configured || loading}
          rows={3}
          placeholder={
            configured
              ? "Ask the copilot…"
              : "Chat is offline until an ANTHROPIC_API_KEY is added."
          }
          className={`${inputCls} w-full resize-y disabled:opacity-50`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit(input);
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">
            {configured ? "⌘/Ctrl + Enter to send" : "Chat offline"}
          </span>
          <Button type="submit" disabled={!configured || loading}>
            {loading ? "Asking…" : "Ask"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
