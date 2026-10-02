/**
 * Vehicle compliance records (migration 0055).
 *
 * The list of documents a vehicle needs comes from the active region pack, not
 * from here and not from the database: Nigeria wants roadworthiness, a vehicle
 * licence and a hackney permit; the UK wants an MOT and a PHV licence. This
 * module stores what the operator recorded against those keys — and, for the few
 * documents that predate the packs, writes the dedicated column on `vehicles`
 * that the rest of the app already reads.
 */
import { createClient, createServiceClient } from '@/lib/supabase/server';
import type { ComplianceRecord } from '@/lib/compliance-plan';
import type { VehicleDateColumn } from '@/lib/region/types';

export interface VehicleComplianceRow extends ComplianceRecord {
  id: string;
  issued_on: string | null;
  note: string | null;
}

/**
 * Service-client variant of `getVehicleCompliance`, for the monthly owner report
 * cron (no session). Scoped by tenant as well as vehicle.
 */
export async function getVehicleComplianceFor(
  sb: ReturnType<typeof createServiceClient>,
  tenantId: string,
  vehicleId: string,
): Promise<VehicleComplianceRow[]> {
  const { data } = await sb
    .from('vehicle_compliance')
    .select('id, obligation_key, expires_on, issued_on, reference, note')
    .eq('tenant_id', tenantId)
    .eq('vehicle_id', vehicleId);
  return (data ?? []) as VehicleComplianceRow[];
}

/** Everything recorded for one vehicle, keyed by the region pack's obligation key. */
export async function getVehicleCompliance(vehicleId: string): Promise<VehicleComplianceRow[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('vehicle_compliance')
    .select('id, obligation_key, expires_on, issued_on, reference, note')
    .eq('vehicle_id', vehicleId);
  return (data ?? []) as VehicleComplianceRow[];
}

export interface SaveComplianceInput {
  vehicleId: string;
  obligationKey: string;
  expiresOn: string | null;
  issuedOn?: string | null;
  reference?: string | null;
  note?: string | null;
}

/**
 * Record or update one document.
 *
 * Upserts on (vehicle_id, obligation_key), so renewing a certificate updates the
 * date in place rather than accumulating rows the compliance sweep would then
 * have to disambiguate — and the operator never has to delete last year's entry
 * before entering this year's.
 */
export async function saveVehicleCompliance(
  tenantId: string,
  input: SaveComplianceInput,
  actor: string | null,
): Promise<void> {
  const sb = await createClient();
  const { error } = await sb.from('vehicle_compliance').upsert(
    {
      // Named explicitly, like every write in this codebase: a row must never be
      // attributed by whatever the database happened to default to.
      tenant_id: tenantId,
      vehicle_id: input.vehicleId,
      obligation_key: input.obligationKey,
      expires_on: input.expiresOn,
      issued_on: input.issuedOn ?? null,
      reference: input.reference ?? null,
      note: input.note ?? null,
      updated_by: actor,
    } as never,
    { onConflict: 'vehicle_id,obligation_key' },
  );

  if (error) throw new Error(`Could not save the document: ${error.message}`);
}

/** Remove a record — for a document entered against the wrong vehicle. */
export async function deleteVehicleCompliance(
  vehicleId: string,
  obligationKey: string,
): Promise<void> {
  const sb = await createClient();
  const { error } = await sb
    .from('vehicle_compliance')
    .delete()
    .eq('vehicle_id', vehicleId)
    .eq('obligation_key', obligationKey);
  if (error) throw new Error(`Could not remove the document: ${error.message}`);
}

/**
 * Write a date straight onto `vehicles` for the documents that live there.
 *
 * The column name is not free-form — it comes from the region pack's
 * `column` field, which is typed to the two columns that exist. That matters
 * because this interpolates into the update payload.
 */
export async function setVehicleDateColumn(
  vehicleId: string,
  column: VehicleDateColumn,
  value: string | null,
): Promise<void> {
  const sb = await createClient();
  const { error } = await sb
    .from('vehicles')
    .update({ [column]: value } as never)
    .eq('id', vehicleId);
  if (error) throw new Error(`Could not save the date: ${error.message}`);
}
