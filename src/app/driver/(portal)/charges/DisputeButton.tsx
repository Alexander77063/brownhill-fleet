'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { disputeCharge } from '@/lib/actions/driver';

export function DisputeButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function onClick() {
    startTransition(async () => {
      const res = await disputeCharge(id);
      setMsg(res.message);
      if (res.ok) setDone(true);
    });
  }

  if (done) return <span className="text-xs text-[var(--color-warn)]">Dispute raised</span>;

  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
        {pending ? 'Raising…' : 'Dispute'}
      </Button>
      {msg && <span className="text-xs text-[var(--color-loss)]">{msg}</span>}
    </div>
  );
}
