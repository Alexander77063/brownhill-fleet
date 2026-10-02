/**
 * Charge evidence media — 0..N image/video (dashcam) attachments per charge, for
 * disputing a PCN/CC/toll. Files live in the private `receipts` bucket; a signed
 * URL is only ever minted from a row resolved against the caller's tenant (see
 * /api/receipts/media), never a client-supplied path.
 */
import { createServiceClient } from '@/lib/supabase/server';

export type ChargeMediaKind = 'image' | 'video';

export interface ChargeMedia {
  id: string;
  charge_id: string;
  kind: ChargeMediaKind;
  doc_path: string;
  created_at: string;
}

/** Attach an evidence file to a charge (validated to belong to this tenant). */
export async function attachChargeMedia(
  tenantId: string,
  chargeId: string,
  kind: ChargeMediaKind,
  docPath: string,
  actor: string | null,
): Promise<void> {
  const sb = createServiceClient();
  const { data: charge } = await sb.from('charges').select('id').eq('id', chargeId).eq('tenant_id', tenantId).maybeSingle();
  if (!charge) throw new Error('Unknown charge.');
  const { error } = await sb.from('charge_media').insert({
    tenant_id: tenantId,
    charge_id: chargeId,
    kind,
    doc_path: docPath,
    created_by: actor,
  } as never);
  if (error) throw new Error(`Could not attach evidence: ${error.message}`);
}

export async function listChargeMedia(tenantId: string, chargeId: string): Promise<ChargeMedia[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('charge_media')
    .select('id, charge_id, kind, doc_path, created_at')
    .eq('tenant_id', tenantId)
    .eq('charge_id', chargeId)
    .order('created_at');
  return (data ?? []) as ChargeMedia[];
}

/** Media grouped by charge, for the ops charges list. */
export async function listChargeMediaForCharges(
  tenantId: string,
  chargeIds: string[],
): Promise<Map<string, ChargeMedia[]>> {
  const map = new Map<string, ChargeMedia[]>();
  if (chargeIds.length === 0) return map;
  const sb = createServiceClient();
  const { data } = await sb
    .from('charge_media')
    .select('id, charge_id, kind, doc_path, created_at')
    .eq('tenant_id', tenantId)
    .in('charge_id', chargeIds)
    .order('created_at');
  for (const r of (data ?? []) as ChargeMedia[]) {
    const arr = map.get(r.charge_id) ?? [];
    arr.push(r);
    map.set(r.charge_id, arr);
  }
  return map;
}
