'use client';

// /admin/accounting/banks/[id]/import/ImportForm — uploads a CSV to
// /api/v1/accounting/banks/import, then renders the per-row summary the
// endpoint returns. Two phases: idle (file picker) and done (table +
// counts). Errors come back as plain text and surface inline.

import { useState } from 'react';

interface SummaryRow {
  postedAt: string;
  amountPence: string;
  description: string;
  counterparty: string | null;
  status: 'auto_matched' | 'unmatched';
  matchedPaymentId?: string;
  score?: number;
}
interface Summary {
  format: string;
  imported: number;
  autoMatched: number;
  stillUnmatched: number;
  rows: SummaryRow[];
}

type Result = { ok: true; summary: Summary; inserted: number } | { ok: false; error: string };

function fmtPence(p: string): string {
  const n = BigInt(p);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return `${sign}£${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export function ImportForm({ bankAccountId, reconcileHref }: { bankAccountId: string; reconcileHref: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('bank_account_id', bankAccountId);
      fd.append('file', file);
      const res = await fetch('/api/v1/accounting/banks/import', { method: 'POST', body: fd });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Partial<Summary> & { inserted?: number };
      if (!res.ok || !data.ok) {
        setResult({ ok: false, error: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setResult({ ok: true, summary: data as unknown as Summary, inserted: data.inserted ?? 0 });
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : 'upload failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 max-w-2xl">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded-md border p-4">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs uppercase tracking-wider text-muted">CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !file}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Importing…' : 'Import'}
        </button>
      </form>

      {result && !result.ok && (
        <div
          role="alert"
          aria-live="assertive"
          className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {result.error}
        </div>
      )}

      {result?.ok && (
        <section className="mt-6">
          <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span><strong>Format:</strong> {result.summary.format}</span>
            <span><strong>Imported:</strong> {result.summary.imported}</span>
            <span><strong>Auto-matched:</strong> {result.summary.autoMatched}</span>
            <span><strong>Still unmatched:</strong> {result.summary.stillUnmatched}</span>
          </div>
          {result.summary.stillUnmatched > 0 && (
            <p className="mb-3 text-xs text-muted">
              {result.summary.stillUnmatched} row{result.summary.stillUnmatched === 1 ? '' : 's'} waiting in the{' '}
              <a href={reconcileHref} className="underline">reconcile queue</a>.
            </p>
          )}
          <table className="min-w-full border text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2">Date</th>
                <th className="text-left p-2">Description</th>
                <th className="text-right p-2">Amount</th>
                <th className="text-left p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {result.summary.rows.map((r, i) => (
                <tr key={i} className="border-t">
                  <td className="p-2">{r.postedAt.slice(0, 10)}</td>
                  <td className="p-2">{r.description}</td>
                  <td className="p-2 text-right tabular-nums">{fmtPence(r.amountPence)}</td>
                  <td className="p-2">
                    {r.status === 'auto_matched' ? (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">auto-matched</span>
                    ) : (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">unmatched</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}