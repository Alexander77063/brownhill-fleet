/**
 * Speed units — the one converter (spec §11 "Units").
 *
 * The schema stores what the device reports: `speed_mph` on `vehicle_positions`
 * and `vehicle_position_history`, because the first telematics providers were UK
 * ones. Owner settings (`vehicle_owners.speed_limit_kph`) and every piece of copy
 * addressed to a Nigerian owner are km/h. Convert here, in one place, in both
 * directions — never with an ad-hoc `* 1.609` at a call site.
 */

/** Miles per kilometre: the international mile is exactly 1.609344 km. */
export const MPH_PER_KPH = 0.621371;

/** Device speed (mph, as stored) → km/h (as shown to owners and compared to their limit). */
export function mphToKph(mph: number): number {
  return mph / MPH_PER_KPH;
}

/** km/h (owner-facing) → mph (as stored). */
export function kphToMph(kph: number): number {
  return kph * MPH_PER_KPH;
}
