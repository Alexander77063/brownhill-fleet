/**
 * Console-managed collection settings: defaults from ./settings-defaults.ts,
 * overlaid by `platform_settings` rows. A malformed row is ignored rather than
 * trusted — a typo in the console must not turn the grace period into NaN.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { SETTINGS_DEFAULTS, type Settings, type SettingsKey } from './settings-defaults';

type Sb = ReturnType<typeof createServiceClient>;

const GATEWAYS = new Set(['paystack', 'flutterwave']);

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isIntArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(isNonNegInt);
}

function isStringRecord(v: unknown, keys: string[]): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return keys.every((k) => typeof o[k] === 'string');
}

/** Validate one stored value against its default's shape. Undefined = reject. */
function coerce<K extends SettingsKey>(key: K, value: unknown): Settings[K] | undefined {
  const d = SETTINGS_DEFAULTS[key];
  if (key === 'collection.preferred_gateway') {
    return (value === null || (typeof value === 'string' && GATEWAYS.has(value)) ? value : undefined) as Settings[K] | undefined;
  }
  if (typeof d === 'number') return (isNonNegInt(value) ? value : undefined) as Settings[K] | undefined;
  if (Array.isArray(d)) {
    // A list of labels (the installer checklist) or a list of day offsets.
    if (typeof d[0] === 'string') {
      const ok = Array.isArray(value) && value.length > 0 && value.every((s) => typeof s === 'string' && s.trim().length > 0);
      return (ok ? (value as string[]).map((s) => s.trim()) : undefined) as Settings[K] | undefined;
    }
    return (isIntArray(value) ? [...value].sort((a, b) => b - a) : undefined) as Settings[K] | undefined;
  }
  if (d && typeof d === 'object') {
    const keys = Object.keys(d);
    return (isStringRecord(value, keys) ? Object.fromEntries(keys.map((k) => [k, value[k]])) : undefined) as Settings[K] | undefined;
  }
  return undefined;
}

/** Pure: defaults ← valid rows. Exported for tests and for the settings page preview. */
export function mergeSettings(rows: { key: string; value: unknown }[]): Settings {
  const out = structuredClone(SETTINGS_DEFAULTS) as Settings;
  for (const row of rows) {
    if (!(row.key in SETTINGS_DEFAULTS)) continue;
    const key = row.key as SettingsKey;
    const v = coerce(key, row.value);
    if (v !== undefined) (out as unknown as Record<string, unknown>)[key] = v;
  }
  return out;
}

export async function platformSettings(sb: Sb = createServiceClient()): Promise<Settings> {
  const { data, error } = await sb.from('platform_settings').select('key, value');
  if (error) throw new Error(`platform_settings: ${error.message}`);
  return mergeSettings((data ?? []) as { key: string; value: unknown }[]);
}

export async function saveSetting<K extends SettingsKey>(key: K, value: Settings[K], userId: string, sb: Sb = createServiceClient()): Promise<void> {
  if (coerce(key, value) === undefined) throw new Error(`Invalid value for ${key}.`);
  const { error } = await sb
    .from('platform_settings')
    .upsert({ key, value: value as never, updated_by: userId, updated_at: new Date().toISOString() } as never, { onConflict: 'key' });
  if (error) throw new Error(error.message);
}

/** Can an invoice be issued? Legal name and bank account are the minimum a customer can pay against. */
export function issuerReady(s: Settings): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!s['invoice.issuer'].legalName.trim()) missing.push('issuer legal name');
  if (!s['invoice.bank'].bankName.trim()) missing.push('bank name');
  if (!s['invoice.bank'].accountNumber.trim()) missing.push('bank account number');
  return { ok: missing.length === 0, missing };
}
