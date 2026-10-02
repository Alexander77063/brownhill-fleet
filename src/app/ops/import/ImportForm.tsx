'use client';

import { useState } from 'react';
import { Card, CardTitle, Button, Badge } from '@/components/ui';

type Entity = 'vehicles' | 'drivers' | 'pcn';

const TEMPLATES: Record<Entity, string> = {
  vehicles: 'registration,make,model,model_year,colour,fuel,list_value,vin,mot_due,ved_renewal,status',
  drivers: 'full_name,email,phone,pco_licence_no,pco_licence_expiry,dvla_licence_no,status',
  pcn: 'reference,registration,authority,amount,incident_on',
};

interface Result {
  entity: string;
  dryRun: boolean;
  total: number;
  valid: number;
  inserted: number;
  errors: { row: number; message: string }[];
  skipped?: number;
}

export function ImportForm() {
  const [entity, setEntity] = useState<Entity>('vehicles');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError('');
    if (dryRun) setResult(null);
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entity, csv, dryRun }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? 'Import failed.');
      setResult(null);
      return;
    }
    setResult(data);
  }

  const inputCls =
    'w-full rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Card>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Paste CSV</CardTitle>
            <select value={entity} onChange={(e) => { setEntity(e.target.value as Entity); setResult(null); }} aria-label="What are you importing?" className={`${inputCls} w-auto`}>
              <option value="vehicles">Vehicles</option>
              <option value="drivers">Drivers</option>
              <option value="pcn">PCNs</option>
            </select>
          </div>
          <p className="mt-2 text-xs text-muted">
            First row must be the header. In Excel: <span className="text-parchment">File → Save As → CSV</span>, then paste here.
            {entity === 'pcn' && ' PCNs are matched to a vehicle by registration and assigned to its current driver; re-importing skips PCNs already logged.'}
          </p>
          {/* The template line is wider than the panel and scrolls sideways, so it needs
              to be reachable by keyboard or its content is unreadable without a mouse
              (WCAG 2.1.1). Same fix as the Table wrapper; this one is a bespoke scroller
              and so never inherited it. Found by the runtime axe pass once the consent
              gate stopped masking this route. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <div tabIndex={0} aria-label={`CSV column template for ${entity}`} className="mt-2 overflow-x-auto rounded-md border border-hair bg-[rgba(0,0,0,0.2)] p-2">
            <code className="whitespace-nowrap text-[11px] text-gold-bright">{TEMPLATES[entity]}</code>
          </div>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={10}
            aria-label="Paste CSV rows, including the header row"
            placeholder={`${TEMPLATES[entity]}\n…your rows…`}
            className={`${inputCls} mt-2 font-mono text-xs`}
          />
          <div className="mt-3 flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => run(true)} disabled={busy || !csv.trim()}>
              {busy ? 'Checking…' : 'Preview'}
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={() => run(false)} disabled={busy || !csv.trim() || (result != null && result.valid === 0)}>
              Import {result ? `${result.valid} valid` : ''}
            </Button>
          </div>
          {error && <p className="mt-2 text-sm text-[var(--color-loss)]">{error}</p>}
        </Card>
      </div>

      <Card>
        <CardTitle>Result</CardTitle>
        {!result ? (
          <p className="mt-3 text-sm text-muted">Preview to validate your data before importing.</p>
        ) : (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge tone="neutral">{result.total} rows</Badge>
              <Badge tone="profit">{result.valid} valid</Badge>
              {result.errors.length > 0 && <Badge tone="loss">{result.errors.length} errors</Badge>}
              {(result.skipped ?? 0) > 0 && <Badge tone="warn">{result.skipped} already imported</Badge>}
              {result.inserted > 0 && <Badge tone="profit">{result.inserted} imported</Badge>}
            </div>
            {result.dryRun && result.errors.length === 0 && result.valid > 0 && (
              <p className="text-sm text-[var(--color-profit)]">All rows valid — ready to import.</p>
            )}
            {result.inserted > 0 && <p className="text-sm text-[var(--color-profit)]">Imported {result.inserted} {result.entity}.</p>}
            {result.errors.length > 0 && (
              <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
                {result.errors.map((e, i) => (
                  <li key={i} className="text-[var(--color-loss)]">Row {e.row}: {e.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
