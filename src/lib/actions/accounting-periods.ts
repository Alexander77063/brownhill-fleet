'use server';

// /lib/actions/accounting-periods.ts
//
// Reopen a monthly accounting period. Wired to the /accounts/accounting/periods
// page (and to /admin/accounting/* when the admin tree is rebuilt).
//
// WHY CLOSING IS NOT HERE
// -----------------------
// Closing a period shuts a month and cannot be undone without a reopen
// window, so it needs a warning, a count of what is outstanding and an
// explicit acknowledgement of each warning. A server action that takes a
// FormData cannot do that — the browser posts the form straight to the
// action, so the operator never sees the counts and the server never gets
// to check whether they saw them.
//
// The close therefore lives in the API route
// (`POST /api/v1/accounting/periods/close`), which answers 428 with the
// preflight and refuses a close whose warnings have not all been
// acknowledged. The dialog that drives it is `ClosePeriodButton`.
//
// One path to the close. Two paths is two ways to skip the confirmation.
//
// Gated on billing.write: same permission as the journal-bridge mutations.

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { reopenPeriod } from '@/lib/accounting/periods';

function readYearMonth(formData: FormData): { year: number; month: number } | null {
  const year = Number(formData.get('year'));
  const month = Number(formData.get('month'));
  if (!Number.isInteger(year) || !Number.isInteger(month) || year < 1970 || month < 1 || month > 12) {
    return null;
  }
  return { year, month };
}

export async function reopenPeriodAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('billing.write');
  const ym = readYearMonth(formData);
  if (!ym) throw new Error('Invalid period (year / month).');
  await reopenPeriod(ctx.tenantId, ym.year, ym.month, ctx.userId);
  revalidatePath('/accounts/accounting/periods');
  try { revalidatePath('/admin/accounting/periods'); } catch {}
}
