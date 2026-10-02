/**
 * Device-offline detection (spec §7.2 `device_offline`). Not a per-ping rule —
 * a silent tracker sends no ping to evaluate — so `/api/cron/device-health`
 * sweeps every owned vehicle with an active device and asks this pure function
 * which have gone quiet. The cron does the query and the writes; this decides.
 */
import { offlineKey } from './dedupe';

/** Past this much silence an offline alert is critical, whatever the owner's threshold. */
export const OFFLINE_CRITICAL_AFTER_H = 48;

const ONE_HOUR_MS = 3_600_000;

/** One owned vehicle as the sweep sees it. */
export interface OfflineRow {
  vehicleId: string;
  ownerId: string;
  /** `vehicle_owners.offline_after_h` — hours of silence before the owner is told. */
  offlineAfterH: number;
  /** Latest `vehicle_positions.recorded_at`, or null when the vehicle has never reported. */
  lastSeenAt: string | null;
  /** `telematics_devices.is_active` — a deliberately disabled device is not "offline". */
  deviceActive: boolean;
}

export interface OfflineCandidate {
  vehicleId: string;
  ownerId: string;
  severity: 'warning' | 'critical';
  /** Hours since the last position, to one decimal — for "silent for 13 h". */
  silentHours: number;
  /** The last position's instant — for "last seen at 03:12". */
  lastSeenAt: string;
  dedupeKey: string;
}

/**
 * Which of `rows` have been silent longer than their owner allows, as of `now`.
 * Inactive devices and never-seen vehicles are skipped (nothing to go silent
 * from); unreadable or future-dated timestamps and non-finite thresholds are
 * skipped rather than thrown on. Keys to the UTC day of the sweep, so a vehicle
 * that stays dark is mentioned once a day, not once an hour.
 */
export function offlineCandidates(rows: OfflineRow[], now: Date): OfflineCandidate[] {
  const day = now.toISOString().slice(0, 10);
  const out: OfflineCandidate[] = [];

  for (const row of rows) {
    if (!row.deviceActive || row.lastSeenAt === null) continue;
    if (!Number.isFinite(row.offlineAfterH)) continue;

    const seen = new Date(row.lastSeenAt).getTime();
    if (Number.isNaN(seen)) continue;

    const silentHours = (now.getTime() - seen) / ONE_HOUR_MS;
    if (silentHours <= row.offlineAfterH) continue;

    out.push({
      vehicleId: row.vehicleId,
      ownerId: row.ownerId,
      severity: silentHours > OFFLINE_CRITICAL_AFTER_H ? 'critical' : 'warning',
      silentHours: Math.round(silentHours * 10) / 10,
      lastSeenAt: row.lastSeenAt,
      dedupeKey: offlineKey(row.vehicleId, day),
    });
  }

  return out;
}
