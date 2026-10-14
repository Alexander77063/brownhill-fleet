'use server';

// /lib/actions/comms-notice.ts
//
// Server action behind /ops/comms. Validates a kind+id, expands the
// recipient scope to a list of {kind,id}, and dispatches the per-recipient
// send. Returns a structured result so the form can show "sent 12/14, 2
// skipped" without a separate round-trip.

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import {
  listDriversForComms,
  listOwnersForComms,
  sendDriverMessage,
  sendOwnerMessage,
} from '@/lib/comms';

export interface SendNoticeResult {
  ok: boolean;
  /** how many recipients actually had a channel to send through. */
  sent?: number;
  /** total recipients the action considered. */
  targets?: number;
  /** who had no email and no phone on file, so the send was skipped. */
  skipped?: { id: string; label: string }[];
  /** set when ok=false; an error code the form can render. */
  error?: 'invalid_kind' | 'invalid_id' | 'permission' | 'unknown';
  message?: string;
}

type RecipKind = 'driver' | 'owner';
type ScopeKind = 'driver_single' | 'driver_all' | 'owner_single' | 'owner_all';

interface PlannedRecip {
  kind: RecipKind;
  id: string;
  label: string;
  hasEmail: boolean;
  hasPhone: boolean;
}

export async function sendNoticeAction(formData: FormData): Promise<SendNoticeResult> {
  const ctx = await requirePermission('drivers.write');

  const kind = String(formData.get('kind') ?? '') as ScopeKind;
  const subject = String(formData.get('subject') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();
  const singleId = String(formData.get('recipient_id') ?? '').trim();

  if (!subject || !body) {
    return { ok: false, error: 'invalid_kind', message: 'Subject and message are required.' };
  }

  const drivers = await listDriversForComms(ctx.tenantId);
  const owners  = await listOwnersForComms(ctx.tenantId);

  let planned: PlannedRecip[] = [];
  switch (kind) {
    case 'driver_single': {
      if (!singleId) return { ok: false, error: 'invalid_id', message: 'Pick a driver.' };
      const d = drivers.find((x) => x.id === singleId);
      if (!d) return { ok: false, error: 'invalid_id', message: 'Driver not found.' };
      planned = [{ kind: 'driver', id: d.id, label: d.full_name, hasEmail: d.has_email, hasPhone: d.has_phone }];
      break;
    }
    case 'driver_all': {
      planned = drivers.map((d) => ({
        kind: 'driver', id: d.id, label: d.full_name, hasEmail: d.has_email, hasPhone: d.has_phone,
      }));
      break;
    }
    case 'owner_single': {
      if (!singleId) return { ok: false, error: 'invalid_id', message: 'Pick an owner.' };
      const o = owners.find((x) => x.id === singleId);
      if (!o) return { ok: false, error: 'invalid_id', message: 'Owner not found.' };
      planned = [{ kind: 'owner', id: o.id, label: o.display_name, hasEmail: o.has_email, hasPhone: o.has_phone }];
      break;
    }
    case 'owner_all': {
      planned = owners.map((o) => ({
        kind: 'owner', id: o.id, label: o.display_name, hasEmail: o.has_email, hasPhone: o.has_phone,
      }));
      break;
    }
    default:
      return { ok: false, error: 'invalid_kind', message: 'Pick a recipient kind.' };
  }

  let sent = 0;
  const skipped: { id: string; label: string }[] = [];
  for (const r of planned) {
    if (!r.hasEmail && !r.hasPhone) {
      skipped.push({ id: r.id, label: r.label });
      continue;
    }
    try {
      if (r.kind === 'driver') {
        await sendDriverMessage(ctx.tenantId, r.id, subject, body, ctx.userId);
      } else {
        await sendOwnerMessage(ctx.tenantId, r.id, subject, body, ctx.userId);
      }
      sent++;
    } catch {
      // The single send failure is recorded in `notifications` by the
      // underlying comms helpers; for the operator's UI we count it as
      // skipped rather than failing the whole batch.
      skipped.push({ id: r.id, label: r.label });
    }
  }

  revalidatePath('/ops/comms');
  return { ok: true, sent, targets: planned.length, skipped };
}
