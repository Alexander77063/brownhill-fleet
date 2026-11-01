// tests/unit/accounting/close-preflight.test.ts
//
// What a close would block, stated before the close rather than after it.
//
// WHY THIS FILE EXISTS
// --------------------
// The Close button closed a month with one click and no warning. The spec
// asks for "Close period (warns: locks all postings; shows affected counts;
// confirm modal)" — nothing warned, nothing counted, and nothing confirmed.
// An operator closing October with uncategorised bank lines and an unfiled
// VAT return found out afterwards, when a posting came back 409 and the
// month was already shut.
//
// The warnings are pure functions of the counts, so they are tested without
// a database. The counts themselves are read from the real database in
// tests/integration/accounting/close-preflight.test.ts; the refusal they
// feed is answered by the route in
// tests/unit/accounting/period-close-route.test.ts.

import { describe, expect, it } from 'vitest';
import {
  closeWarnings,
  type CloseWarning,
  type PreflightCounts,
} from '@/lib/accounting/close-preflight';

const PERIOD = '2026-10';

/** A clean month: nothing open, nothing owing. */
function cleanCounts(overrides: Partial<PreflightCounts> = {}): PreflightCounts {
  return {
    journalEntries: 12,
    openBankItems: 0,
    openBankItemsPence: 0,
    openInvoices: 0,
    openInvoicesPence: 0,
    netVatPence: 0,
    vatSubmission: 'none',
    ...overrides,
  };
}

/** The warning with this code, or undefined. */
function byCode(warnings: CloseWarning[], code: CloseWarning['code']): CloseWarning | undefined {
  return warnings.find((w) => w.code === code);
}

describe('the warnings a period close carries', () => {
  it('says nothing at all when the month is clean', () => {
    expect(closeWarnings(cleanCounts(), PERIOD)).toEqual([]);
  });

  it('counts the bank lines that would be stranded by the close', () => {
    const warnings = closeWarnings(
      cleanCounts({ openBankItems: 3, openBankItemsPence: 45_000 }),
      PERIOD,
    );

    const warning = byCode(warnings, 'open_bank_items');
    expect(warning).toBeDefined();
    expect(warning!.count).toBe(3);
    expect(warning!.amountPence).toBe(45_000);
    // It has to name the period: "these bank lines" means nothing without it.
    expect(warning!.message).toContain(PERIOD);
    expect(warning!.message).toContain('3');
    // And it has to say what they are, in the words the spec uses.
    expect(warning!.message).toContain('open bank transactions');
  });

  it('says a single bank line in the singular', () => {
    const warnings = closeWarnings(
      cleanCounts({ openBankItems: 1, openBankItemsPence: 1_200 }),
      PERIOD,
    );

    // "There is 1 open bank transaction" — the singular noun, and the
    // singular verb with it.
    expect(byCode(warnings, 'open_bank_items')!.message).toContain('1 open bank transaction');
    expect(byCode(warnings, 'open_bank_items')!.message).not.toContain('1 open bank transactions');
  });

  it('warns that a VAT return cannot be filed once the period is closed', () => {
    const warnings = closeWarnings(
      cleanCounts({ netVatPence: 20_000, vatSubmission: 'none' }),
      PERIOD,
    );

    const warning = byCode(warnings, 'vat_not_filed');
    expect(warning).toBeDefined();
    expect(warning!.count).toBe(1);
    expect(warning!.amountPence).toBe(20_000);
    expect(warning!.message).toContain(PERIOD);
    // The trap has to be stated, not implied: the return can never be filed
    // into a closed period, and after the reopen window it never can be at all.
    expect(warning!.message).toMatch(/cannot be filed|before closing/i);
  });

  it('says nothing about VAT when there is no VAT to report', () => {
    // No VAT due in the period means no return to file, so nothing is
    // stranded and the close is free to proceed.
    const warnings = closeWarnings(cleanCounts({ vatSubmission: 'none' }), PERIOD);
    expect(byCode(warnings, 'vat_not_filed')).toBeUndefined();
  });

  it('says nothing about VAT once the return has been accepted', () => {
    const warnings = closeWarnings(
      cleanCounts({ netVatPence: 20_000, vatSubmission: 'submitted' }),
      PERIOD,
    );
    expect(byCode(warnings, 'vat_not_filed')).toBeUndefined();
  });

  it('still warns when HMRC rejected the return — it was never accepted', () => {
    const warnings = closeWarnings(
      cleanCounts({ netVatPence: 20_000, vatSubmission: 'rejected' }),
      PERIOD,
    );
    expect(byCode(warnings, 'vat_not_filed')).toBeDefined();
  });

  it('still warns when a submission is only pending', () => {
    // 'pending_submission' is the row written BEFORE the HMRC call. If the
    // process died in between, the return may never have been sent — and the
    // period must not be closed on the strength of a row that proves nothing.
    const warnings = closeWarnings(
      cleanCounts({ netVatPence: 20_000, vatSubmission: 'pending_submission' }),
      PERIOD,
    );
    expect(byCode(warnings, 'vat_not_filed')).toBeDefined();
  });

  it('warns about the VAT return first — it is the one that cannot be undone', () => {
    const warnings = closeWarnings(
      cleanCounts({
        openBankItems: 2,
        openBankItemsPence: 1_000,
        netVatPence: 20_000,
        vatSubmission: 'none',
      }),
      PERIOD,
    );

    expect(warnings.map((w) => w.code)).toEqual(['vat_not_filed', 'open_bank_items']);
  });
});
