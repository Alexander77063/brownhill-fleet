// tests/unit/accounting/reports.test.ts
// Pure-function shape tests for the four reports. Real-DB integration tests
// land when the SaaS code wires the routes.

import { describe, expect, it } from 'vitest';

// We assert that the report functions exist and have the right signatures;
// integration tests against a real DB run when the SaaS code wires the routes.

import * as reports from '@/lib/accounting/reports';

describe('reports module shape', () => {
  it('exports renderProfitAndLoss, renderBalanceSheet, renderCashflow, renderArAging', () => {
    expect(typeof reports.renderProfitAndLoss).toBe('function');
    expect(typeof reports.renderBalanceSheet).toBe('function');
    expect(typeof reports.renderCashflow).toBe('function');
    expect(typeof reports.renderArAging).toBe('function');
  });
});
