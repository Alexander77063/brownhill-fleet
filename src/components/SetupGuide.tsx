import type { ReactNode } from 'react';
import { Card, CardTitle } from '@/components/ui';

/**
 * A consistent "set it up in N steps" card for the config pages — the fetch-and-
 * paste guide next to each settings form, so a tenant knows exactly where to get
 * a value and where to paste it.
 */
export function SetupGuide({
  title,
  steps,
  note,
  className,
}: {
  title: string;
  steps: ReactNode[];
  note?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardTitle>{title}</CardTitle>
      <ol className="mt-2 list-decimal space-y-2 pl-4 text-sm text-muted">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {note && <p className="mt-3 text-xs text-muted">{note}</p>}
    </Card>
  );
}
