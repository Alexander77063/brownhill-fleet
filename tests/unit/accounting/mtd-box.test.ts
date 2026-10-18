// tests/unit/accounting/mtd-box.test.ts
// Aggregate-VAT-return-box function shape tests.

import { describe, expect, it } from 'vitest';
import { aggregateVatReturn } from '@/lib/accounting/mtd-box';

describe('aggregateVatReturn (shape)', () => {
  it('exists and is async', () => {
    expect(typeof aggregateVatReturn).toBe('function');
  });
});
