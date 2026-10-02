/**
 * Money is represented as integer minor units everywhere to avoid
 * floating-point error. These helpers are the only place rounding happens.
 *
 * The parameter names below still say "pence" because that is what every
 * existing caller passes and renaming 370-odd call sites in one commit would be
 * a large diff with no test able to tell it apart from a mistake. The
 * representation was always correct — 100 kobo to the naira, 100 pence to the
 * pound — so only the vocabulary is parochial, and `formatMoney` is the
 * region-aware replacement for `formatGBP`.
 */

import type { RegionId } from '@/lib/deployment/profile';
import { regionProvider } from '@/lib/region';

/**
 * @deprecated Use `vatRate()`, which respects the deployment's region. Retained
 * because existing callers pass it explicitly and the UK value is still 20%.
 */
export const VAT_RATE = 0.2;

/** Split a VAT-inclusive gross amount into net + VAT at the given rate. */
export function vatFromGross(grossPence: number, rate = VAT_RATE): { netPence: number; vatPence: number } {
  // VAT fraction of a 20%-inclusive price is 1/6.
  const vatPence = Math.round((grossPence * rate) / (1 + rate));
  return { netPence: grossPence - vatPence, vatPence };
}

/** Build a VAT-inclusive gross from a net amount. */
export function grossFromNet(netPence: number, rate = VAT_RATE): { grossPence: number; vatPence: number } {
  const vatPence = Math.round(netPence * rate);
  return { grossPence: netPence + vatPence, vatPence };
}

/**
 * Format an integer minor-unit amount in a region's currency.
 *
 * Supersedes `formatGBP`. The parameter is `minor`, not `pence`, because the
 * same integer is kobo in Nigeria.
 */
export function formatMoney(
  minor: number,
  opts: { showMinor?: boolean; region?: RegionId } = {},
): string {
  return regionProvider(opts.region).currency.format(minor, { showMinor: opts.showMinor });
}

/** A region's standard-rate VAT, defaulting to the active deployment's region. */
export function vatRate(region?: RegionId): number {
  return regionProvider(region).tax.vatRate;
}

/**
 * @deprecated Use `formatMoney`.
 *
 * Retained so the existing call sites keep working while they are migrated. It
 * is pinned to `region: 'uk'` rather than the active region on purpose: a
 * function named `formatGBP` must always produce pounds, so a half-migrated
 * Nigerian build renders obviously-wrong currency rather than silently
 * mislabelling naira as sterling.
 */
export function formatGBP(pence: number, opts: { showPence?: boolean } = {}): string {
  return formatMoney(pence, { showMinor: opts.showPence, region: 'uk' });
}

/** Major units -> minor units (for fixtures/config). */
export const pounds = (p: number): number => Math.round(p * 100);
