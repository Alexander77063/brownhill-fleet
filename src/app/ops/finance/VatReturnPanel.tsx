'use client';

import { useState } from 'react';
import { Card, CardTitle, Button, Table, Th, Td } from '@/components/ui';

interface QuarterReturn {
  start: string;
  label: string;
  boxes: { n: number; label: string; value: string }[];
}

export function VatReturnPanel({ quarters }: { quarters: QuarterReturn[] }) {
  const [sel, setSel] = useState(quarters[0]?.start ?? '');
  const current = quarters.find((q) => q.start === sel) ?? quarters[0];

  if (!current) {
    return (
      <Card>
        <CardTitle>HMRC VAT return (9-box)</CardTitle>
        <p className="mt-2 text-sm text-muted">No periods available yet.</p>
      </Card>
    );
  }

  const inputCls =
    'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>HMRC VAT return (9-box)</CardTitle>
        {/* flex-wrap: at 320px the quarter picker plus both download buttons overflowed
            the page, which fails WCAG 1.4.10 Reflow. Found by the runtime 320px pass. */}
        <div className="flex flex-wrap items-center gap-2">
          <select value={sel} onChange={(e) => setSel(e.target.value)} aria-label="VAT quarter" className={inputCls}>
            {quarters.map((q) => (
              <option key={q.start} value={q.start}>{q.label}</option>
            ))}
          </select>
          <Button href={`/api/ops/vat-return?quarter=${current.start}&format=csv`} variant="outline" size="sm">
            Download CSV
          </Button>
          <Button href={`/api/ops/vat-return?quarter=${current.start}&format=html`} target="_blank" variant="ghost" size="sm">
            Print / PDF
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted">
        Accrual basis (invoice date). Boxes 1–5 in pounds and pence; boxes 6–9 in whole pounds. Review with your accountant before filing.
      </p>
      <div className="mt-3">
        <Table caption="HMRC VAT return boxes">
          <thead>
            <tr><Th>Box</Th><Th>Description</Th><Th className="text-right">Amount (£)</Th></tr>
          </thead>
          <tbody>
            {current.boxes.map((b) => (
              <tr key={b.n}>
                <Td className="whitespace-nowrap font-semibold text-parchment">Box {b.n}</Td>
                <Td className="text-cream">{b.label}</Td>
                <Td className="text-right tnum">{b.value}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}
