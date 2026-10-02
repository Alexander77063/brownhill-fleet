/**
 * Driver behaviour scoring, derived from the position-history breadcrumb (0042).
 *
 * From consecutive on-job pings we detect harsh acceleration / harsh braking
 * (speed change per second) and over-threshold speed, then roll them into a
 * per-driver score and a fleet league table — the "driver safety league tables"
 * a telematics suite provides, without any extra hardware.
 *
 * Honest limitation: speeding is flagged against a single absolute mph threshold,
 * NOT the actual road limit (no per-road speed-limit data source exists yet), so
 * it best identifies genuinely fast driving rather than every local infraction.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { haversineMeters } from '@/lib/gps';

// Tunable thresholds (tenant-configurable later).
const HARSH_ACCEL_MPH_S = 7; // mph gained per second
const HARSH_BRAKE_MPH_S = 8; // mph shed per second
const OVERSPEED_MPH = 80;
const MAX_SEGMENT_GAP_S = 120; // larger gaps aren't a continuous drive

export interface TrackPointLite {
  lat: number;
  lng: number;
  speed_mph: number | null;
  recorded_at: string;
}

export interface TrackAnalysis {
  harshAccel: number;
  harshBrake: number;
  overspeed: number;
  distance_m: number;
}

/** Detect harsh-event counts + distance over one vehicle's ordered ping sequence. */
export function analyseTrack(points: TrackPointLite[]): TrackAnalysis {
  let harshAccel = 0;
  let harshBrake = 0;
  let overspeed = 0;
  let distance = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.speed_mph != null && p.speed_mph > OVERSPEED_MPH) overspeed++;
    if (i > 0) {
      const a = points[i - 1];
      distance += haversineMeters(a.lat, a.lng, p.lat, p.lng);
      const dt = (Date.parse(p.recorded_at) - Date.parse(a.recorded_at)) / 1000;
      if (dt > 0 && dt <= MAX_SEGMENT_GAP_S && a.speed_mph != null && p.speed_mph != null) {
        const accel = (p.speed_mph - a.speed_mph) / dt;
        if (accel >= HARSH_ACCEL_MPH_S) harshAccel++;
        else if (accel <= -HARSH_BRAKE_MPH_S) harshBrake++;
      }
    }
  }
  return { harshAccel, harshBrake, overspeed, distance_m: Math.round(distance) };
}

/** 0–100 score: starts at 100, penalised per harsh/overspeed event. */
export function scoreFromAnalysis(a: TrackAnalysis): number {
  return Math.max(0, 100 - (a.harshAccel * 2 + a.harshBrake * 3 + a.overspeed * 1));
}

export interface DriverScore {
  driver_id: string;
  driver_name: string | null;
  score: number;
  harsh_accel: number;
  harsh_brake: number;
  overspeed: number;
  distance_km: number;
  points: number;
}

function combine(a: TrackAnalysis, b: TrackAnalysis): TrackAnalysis {
  return {
    harshAccel: a.harshAccel + b.harshAccel,
    harshBrake: a.harshBrake + b.harshBrake,
    overspeed: a.overspeed + b.overspeed,
    distance_m: a.distance_m + b.distance_m,
  };
}

/**
 * Score every driver with on-job telematics since `sinceIso`, ranked best-first.
 * Events are computed per vehicle-sequence (harsh events need consecutive pings
 * from the same vehicle) and summed per driver.
 */
export async function fleetDriverLeaderboard(tenantId: string, sinceIso: string): Promise<DriverScore[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('vehicle_position_history')
    .select('driver_id, vehicle_id, lat, lng, speed_mph, recorded_at')
    .eq('tenant_id', tenantId)
    .not('driver_id', 'is', null)
    .gte('recorded_at', sinceIso)
    .order('recorded_at', { ascending: true })
    .limit(20000);

  const rows = (data ?? []) as {
    driver_id: string;
    vehicle_id: string;
    lat: number;
    lng: number;
    speed_mph: number | null;
    recorded_at: string;
  }[];

  // driver_id → vehicle_id → ordered points, plus a raw ping count per driver.
  const byDriver = new Map<string, { vehicles: Map<string, TrackPointLite[]>; count: number }>();
  for (const r of rows) {
    let d = byDriver.get(r.driver_id);
    if (!d) {
      d = { vehicles: new Map(), count: 0 };
      byDriver.set(r.driver_id, d);
    }
    d.count++;
    const seq = d.vehicles.get(r.vehicle_id) ?? [];
    seq.push({ lat: r.lat, lng: r.lng, speed_mph: r.speed_mph, recorded_at: r.recorded_at });
    d.vehicles.set(r.vehicle_id, seq);
  }
  if (byDriver.size === 0) return [];

  const { data: drivers } = await sb
    .from('drivers')
    .select('id, full_name')
    .in('id', [...byDriver.keys()]);
  const names = new Map((drivers ?? []).map((d) => [d.id, d.full_name]));

  const scores: DriverScore[] = [];
  for (const [driverId, d] of byDriver) {
    let total: TrackAnalysis = { harshAccel: 0, harshBrake: 0, overspeed: 0, distance_m: 0 };
    for (const seq of d.vehicles.values()) total = combine(total, analyseTrack(seq));
    scores.push({
      driver_id: driverId,
      driver_name: names.get(driverId) ?? null,
      score: scoreFromAnalysis(total),
      harsh_accel: total.harshAccel,
      harsh_brake: total.harshBrake,
      overspeed: total.overspeed,
      distance_km: Math.round(total.distance_m / 100) / 10,
      points: d.count,
    });
  }
  return scores.sort((a, b) => b.score - a.score || b.distance_km - a.distance_km);
}
