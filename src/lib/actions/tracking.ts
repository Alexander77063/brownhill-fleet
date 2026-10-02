'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { requireEntitlement } from '@/lib/entitlements';
import { type DeviceKind, provisionDevice, removeVehicleDevice } from '@/lib/gps';
import type { CommandStatus, ImmobiliseAction } from '@/lib/immobilise';
import { raiseRequestAsStaff } from '@/lib/requests';
import { createServiceClient } from '@/lib/supabase/server';

/** Register (or re-issue) a tracking device for a vehicle; returns the token ONCE.
 *  Gated by tenant.settings + the matching entitlement (gps.phone / gps.hardware). */
export async function provisionDeviceAction(vehicleId: string, kind: DeviceKind): Promise<{ token?: string; error?: string }> {
  try {
    const ctx = await requirePermission('tenant.settings');
    await requireEntitlement(kind === 'phone' ? 'gps.phone' : 'gps.hardware');
    const { token } = await provisionDevice(ctx.tenantId, vehicleId, kind);
    revalidatePath(`/ops/fleet/${vehicleId}`);
    return { token };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not create the device.' };
  }
}

export async function removeDeviceAction(vehicleId: string): Promise<{ error?: string }> {
  try {
    const ctx = await requirePermission('tenant.settings');
    await removeVehicleDevice(ctx.tenantId, vehicleId, 'removed by ops');
    revalidatePath(`/ops/fleet/${vehicleId}`);
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not remove the device.' };
  }
}

/**
 * Ask for an engine cut / release. Policy (NG-3): tenant ops never send the
 * command themselves — this raises an immobilise request that pages our
 * on-call team, who verify it and execute it from the platform console under
 * the speed gate. Gated by tenant.settings + gps.immobilise.
 */
export async function immobiliseAction(
  vehicleId: string,
  action: ImmobiliseAction,
): Promise<{ requested?: boolean; requestId?: string; status?: CommandStatus; delivered?: boolean; reason?: string; error?: string }> {
  try {
    const ctx = await requirePermission('tenant.settings');
    await requireEntitlement('gps.immobilise');
    const sb = createServiceClient();
    const { data: v } = await sb.from('vehicles').select('owner_id').eq('tenant_id', ctx.tenantId).eq('id', vehicleId).maybeSingle();
    if (!v) throw new Error('Vehicle not found.');
    const { id } = await raiseRequestAsStaff(ctx.tenantId, {
      ownerId: v.owner_id ?? null,
      vehicleId,
      kind: 'immobilise',
      note: action === 'release' ? 'Release the engine (requested by fleet ops).' : 'Cut the engine (requested by fleet ops).',
      raisedBy: ctx.userId,
    });
    return { requested: true, requestId: id, status: 'pending', delivered: false, reason: 'awaiting on-call' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not raise the request.' };
  } finally {
    revalidatePath(`/ops/fleet/${vehicleId}`);
  }
}
