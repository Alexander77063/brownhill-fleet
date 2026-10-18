'use server';

// /lib/actions/accounting-periods.ts
//
// Close / reopen a monthly accounting period. Wired to the
// /accounts/accounting/periods page (and to /admin/accounting/* when the
// admin tree is rebuilt). The underlying close-lock is the
// assertPeriodOpenForPosting guard the journal-bridge invokes before every
// insert — these actions are the operator-facing handle on that invariant.
//
// Gated on billing.write: same permission as the journal-bridge mutations.

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { closePeriod, reopenPeriod, ensurePeriod } from '@/lib/accounting/periods';

function readYearMonth(formData: FormData): { year: number; month: number } | null {
  const year = Number(formData.get('year'));
  const month = Number(formData.get('month'));
  if (!Number.isInteger(year) || !Number.isInteger(month) || year < 1970 || month < 1 || month > 12) {
    return null;
  }
  return { year, month };
}

export async function closePeriodAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('billing.write');
  const ym = readYearMonth(formData);
  if (!ym) throw new Error('Invalid period (year / month).');
  // Ensure the period row exists before we try to close it — the journal
  // bridge is lazy about creating rows.
  await ensurePeriod(ym.year, ym.month);
  await closePeriod(ym.year, ym.month, ctx.userId);
  revalidatePath('/accounts/accounting/periods');
  // /admin/accounting/periods is not built yet — revalidate when it lands.
  // Wrap in try so this code is forward-compatible.
  try { revalidatePath('/admin/accounting/periods'); } catch {}
}

export async function reopenPeriodAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('billing.write');
  const ym = readYearMonth(formData);
  if (!ym) throw new Error('Invalid period (year / month).');
  await reopenPeriod(ym.year, ym.month, ctx.userId);
  revalidatePath('/accounts/accounting/periods');
  try { revalidatePath('/admin/accounting/periods'); } catch {}
}