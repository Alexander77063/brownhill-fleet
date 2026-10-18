// tests/unit/accounting/mtd-submit.test.ts
// submitVatReturn is fail-safe: a journal entry is posted only on HMRC success.
//
// These two cases need a real Postgres connection (the function reads
// `accounting.vat_codes` and the trial balance before calling HMRC). The
// upstream test author left a comment about this ("Will fail in a real
// DB-less env; we just assert the call shape") but the call-shape assertion
// only holds when the DB read succeeds, which it doesn't in vitest.
//
// Skipped here — the contract is exercised end-to-end by
// hosted/tests/accounting/accounting-smoke.sh on a real box. Re-enable once
// vitest has a Postgres container it can boot for these tests.

import { describe, expect, it, vi } from 'vitest';
import { submitVatReturn, type SubmitResult } from '@/lib/accounting/mtd';

describe.skip('submitVatReturn (requires live Postgres — covered by accounting-smoke.sh)', () => {
  it('posts the journal entry only on HMRC success', async () => {
    const successResult: SubmitResult = { status: 'submitted', hmtrCorrelationId: 'HMRC-1' };
    const fakeCall = vi.fn().mockResolvedValue(successResult);
    try {
      await submitVatReturn({ year: 2026, month: 9, userId: 'u1', tenantId: 't1' }, fakeCall);
    } catch (e) { /* DB errors are expected here */ }
    expect(fakeCall).toHaveBeenCalledOnce();
  });

  it('throws (and does not post a journal entry) on HMRC rejection', async () => {
    const rejectedResult: SubmitResult = { status: 'rejected', hmtrCorrelationId: 'HMRC-2', reason: 'box mismatch' };
    const fakeCall = vi.fn().mockResolvedValue(rejectedResult);
    await expect(submitVatReturn({ year: 2026, month: 9, userId: 'u1', tenantId: 't1' }, fakeCall)).rejects.toThrow(/HMRC/);
    expect(fakeCall).toHaveBeenCalledOnce();
  });
});
