'use client';

import { Button } from '@/components/ui';
import { Icon } from '@/components/icons';

export function PrintButton() {
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
      <Icon name="doc" className="h-4 w-4" /> Print / PDF
    </Button>
  );
}
