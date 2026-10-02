'use client';

import { useState } from 'react';
import { Card, CardTitle, Button } from '@/components/ui';

const REPORT_TYPES = [
  { key: 'board', label: 'Board pack', description: 'Operational + financial summary for a board meeting.' },
  { key: 'investor', label: 'Investor update', description: 'PII-free performance + returns summary for investors.' },
  { key: 'vat', label: 'VAT summary', description: 'A written explanation of the quarterly VAT position.' },
  { key: 'performance', label: 'Fleet performance', description: 'Utilisation, revenue and risk across the fleet.' },
];

export function ReportGenerator({ ready }: { ready: boolean }) {
  const [report, setReport] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate(key: string) {
    if (!ready || loadingKey) return;
    setLoadingKey(key);
    setError(null);

    try {
      const res = await fetch('/api/ops/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: key }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.ok) {
        setReport(json.report);
      } else if (res.status === 503) {
        setError(json.error);
      } else {
        setError(json.error || 'Report failed');
      }
    } catch {
      setError('Report failed');
    } finally {
      setLoadingKey(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {!ready && (
        <p className="text-sm text-muted">
          Set up your AI assistant (Settings → Fleet Assistant) to generate written reports.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2">
        {REPORT_TYPES.map((r) => (
          <Card key={r.key} className="flex flex-col justify-between gap-4">
            <div>
              <CardTitle>{r.label}</CardTitle>
              <p className="mt-2 text-sm text-muted">{r.description}</p>
            </div>
            <div>
              <Button
                onClick={() => generate(r.key)}
                disabled={!ready || loadingKey !== null}
              >
                {loadingKey === r.key ? 'Generating…' : 'Generate'}
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {error && <p className="text-sm text-[var(--color-loss)]">{error}</p>}

      {report && (
        <Card className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Report</CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => window.print()}>
                Print / Save as PDF
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setReport(null)}>
                Clear
              </Button>
            </div>
          </div>
          <div className="whitespace-pre-wrap text-sm text-parchment leading-relaxed">
            {report}
          </div>
        </Card>
      )}
    </div>
  );
}
