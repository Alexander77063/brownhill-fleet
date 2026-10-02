'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { regionProvider } from '@/lib/region';
import { isVehicleDateColumn, storageHome } from '@/lib/region/types';
import {
  deleteVehicleCompliance,
  saveVehicleCompliance,
  setVehicleDateColumn,
} from '@/lib/vehicle-compliance';

/**
 * Record or update one compliance document for a vehicle.
 *
 * Where the date is written depends on the region pack, not on the form: most
 * documents become a `vehicle_compliance` row, while MOT and vehicle tax have
 * long-standing columns on `vehicles` that the agreement PDF and the CSV
 * importer already read. Routing here rather than in the page means the screen
 * shows one list of documents and the operator never has to know which is which.
 */
export async function saveVehicleComplianceAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('compliance.write');

  const vehicleId = String(formData.get('vehicle_id') ?? '');
  const obligationKey = String(formData.get('obligation_key') ?? '');
  if (!vehicleId || !obligationKey) throw new Error('Missing vehicle or document type.');

  // The key is checked against the active region pack rather than trusted from
  // the form. A posted key this region does not use would be stored happily and
  // then silently ignored by the compliance sweep — the operator would believe a
  // document was tracked when nothing was watching it, which is worse than an error.
  const spec = regionProvider().vehicleCompliance.find((s) => s.key === obligationKey);
  if (!spec) throw new Error(`"${obligationKey}" is not a document this region requires.`);

  const expiresOn = String(formData.get('expires_on') ?? '').trim() || null;
  const reference = String(formData.get('reference') ?? '').trim() || null;

  const home = storageHome(spec);
  if (home.kind === 'elsewhere') {
    throw new Error(`${spec.label} is recorded on ${home.label}, not against the vehicle.`);
  }

  if (home.kind === 'column') {
    // `ObligationSpec` is shared with the driver list, so its column could name
    // a `drivers` column. Refuse rather than issue an update against `vehicles`
    // for a column that does not exist there.
    if (!isVehicleDateColumn(home.column)) {
      throw new Error(`${spec.label} is not stored on the vehicle record.`);
    }
    await setVehicleDateColumn(vehicleId, home.column, expiresOn);
  } else if (!expiresOn && !reference) {
    // Clearing every field means "I entered this by mistake", so the record goes
    // rather than lingering as an empty row that reads as tracked-but-unknown.
    await deleteVehicleCompliance(vehicleId, obligationKey);
  } else {
    await saveVehicleCompliance(
      ctx.tenantId,
      { vehicleId, obligationKey, expiresOn, reference },
      ctx.userId,
    );
  }

  revalidatePath(`/ops/fleet/${vehicleId}`);
  revalidatePath('/ops/compliance');
}
