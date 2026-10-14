'use server';

// /lib/actions/run-overdue-check.ts
//
// Server action bound to /ops/billing's "Run overdue check now" button.
// Gated on `comms.write` (same permission as the existing comms page) so
// ops who can already message drivers can also run the overdue scan.

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { runRentOverdueCheck } from '@/lib/automation/rent-overdue';

export interface RunOverdueCheckResult {
  ok: boolean;
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
  error?: string;
}

export async function runOverdueCheckAction(): Promise<RunOverdueCheckResult> {
  const ctx = await requirePermission('drivers.write');
  try {
    const summary = await runRentOverdueCheck(ctx.tenantId, ctx.userId);
    revalidatePath('/ops/billing');
    return {
      ok: true,
      scanned: summary.scanned,
      sent: summary.sent,
      skipped: summary.skipped,
      failed: summary.failed,
    };
  } catch (e) {
    return {
      ok: false,
      scanned: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      error: e instanceof Error ? e.message : 'Could not run overdue check.',
    };
  }
}
