'use client';

import { useState } from 'react';
import { Card, Button } from '@/components/ui';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

type Message = { role: 'user' | 'assistant'; content: string };

const SUGGESTIONS = [
  'Which vehicles are underperforming?',
  'What compliance is due this month?',
  'How can I raise occupancy?',
];

export default function AssistantClient({ ready }: { ready: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    const question = input.trim();
    if (!question || loading || !ready) return;

    const history = messages.slice(-10);
    const next: Message[] = [...messages, { role: 'user', content: question }];
    setMessages(next);
    setInput('');
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/ops/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, history }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.ok) {
        setMessages((m) => [...m, { role: 'assistant', content: json.answer }]);
      } else if (res.status === 503) {
        setError(json.error);
      } else {
        setError(json.error || 'Assistant failed');
      }
    } catch {
      setError('Assistant failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      {!ready && (
        <p className="text-xs text-muted">
          The assistant is offline until it&apos;s set up in Settings.
        </p>
      )}

      <div className="flex max-h-[52vh] min-h-[8rem] flex-col gap-3 overflow-y-auto">
        {messages.length === 0 ? (
          <p className="text-sm text-muted">
            Ask about your fleet — occupancy, compliance, economics and more.
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <div
                className={
                  m.role === 'user'
                    ? 'max-w-[85%] whitespace-pre-wrap rounded-lg border border-hair-soft bg-[var(--surface)] px-3 py-2 text-sm text-muted'
                    : 'max-w-[85%] whitespace-pre-wrap rounded-lg border border-hair-soft px-3 py-2 text-sm text-cream'
                }
              >
                {m.content}
              </div>
            </div>
          ))
        )}
        {loading && <p className="text-sm text-muted">Thinking…</p>}
      </div>

      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <Button
            key={s}
            variant="ghost"
            size="sm"
            disabled={!ready}
            onClick={() => setInput(s)}
          >
            {s}
          </Button>
        ))}
      </div>

      <div role="alert" aria-live="assertive">
        {error && <p className="text-sm text-[var(--color-loss)]">{error}</p>}
      </div>

      <div className="flex items-end gap-2">
        <textarea
          aria-label="Ask the Fleet Assistant"
          className={`${inputCls} min-h-[2.75rem] flex-1 resize-y`}
          rows={2}
          placeholder={ready ? 'Ask the Fleet Assistant…' : 'Set up the assistant in Settings to begin.'}
          value={input}
          disabled={!ready || loading}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
        />
        <Button onClick={ask} disabled={!ready || loading || !input.trim()}>
          Ask
        </Button>
      </div>
    </Card>
  );
}
