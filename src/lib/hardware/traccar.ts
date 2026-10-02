/**
 * Traccar — the gateway trackers talk to (NG-3 §5). Two halves:
 *
 *  - what Traccar SENDS us (position and event forwarding, `forward.type=json`),
 *    parsed by pure functions pinned with fixtures; speed arrives in KNOTS and
 *    odometer in METRES, and we store miles like the rest of the app;
 *  - what we ASK Traccar (register a device by IMEI, send engineStop /
 *    engineResume, probe the server), through a small client with a timeout and
 *    an injectable stub for tests.
 *
 * Field names follow Traccar's long-stable JSON model; docs/runbook/traccar.md
 * says to verify them against the deployed version and update the fixtures.
 */
import crypto from 'node:crypto';
import type { Position } from '@/lib/gps';

export type Env = Record<string, string | undefined>;
export const KNOTS_TO_MPH = 1.150779;
export const METRES_TO_MILES = 1 / 1609.344;
export const TRACCAR_TIMEOUT_MS = 8_000;
export const FORWARD_HEADER = 'x-forward-secret';

// ── Forwarded positions ──────────────────────────────────────────────────────

export interface ParsedTraccarPosition {
  imei: string;
  traccarDeviceId: number | null;
  position: Position;
  attributes: Record<string, unknown>;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A forwarded position, or null when there is no usable fix or no IMEI. */
export function parseTraccarPosition(body: unknown): ParsedTraccarPosition | null {
  const b = obj(body);
  if (!b) return null;
  const device = obj(b.device);
  const position = obj(b.position);
  const imei = String(device?.uniqueId ?? '').trim();
  if (!imei || !position) return null;
  if (position.valid === false) return null;
  const lat = num(position.latitude);
  const lng = num(position.longitude);
  if (lat === null || lng === null || (lat === 0 && lng === 0)) return null;
  const attributes = obj(position.attributes) ?? {};
  const knots = num(position.speed);
  const odometerM = num(attributes.odometer);
  const battery = num(attributes.batteryLevel);
  const fixTime = typeof position.fixTime === 'string' ? position.fixTime : typeof position.deviceTime === 'string' ? position.deviceTime : undefined;
  return {
    imei,
    traccarDeviceId: num(device?.id) ?? num(position.deviceId),
    position: {
      lat,
      lng,
      speed: knots === null ? null : Math.round(knots * KNOTS_TO_MPH * 10) / 10,
      heading: num(position.course),
      odometerMiles: odometerM === null ? null : Math.round(odometerM * METRES_TO_MILES * 10) / 10,
      batteryPct: battery === null ? null : Math.max(0, Math.min(100, Math.round(battery))),
      rangeMiles: null,
      recordedAt: fixTime,
    },
    attributes,
  };
}

// ── Forwarded events ─────────────────────────────────────────────────────────

export type TraccarEvent =
  | { kind: 'commandResult'; imei: string; traccarDeviceId: number | null; result: string | null; commandType: string | null }
  | { kind: 'alarm'; imei: string; traccarDeviceId: number | null; alarm: string }
  | { kind: 'deviceOnline' | 'deviceOffline'; imei: string; traccarDeviceId: number | null }
  | { kind: 'ignored'; type: string; imei: string | null };

export const ACTIONABLE_ALARMS = new Set(['powerCut', 'tamper', 'lowBattery', 'removing', 'lowPower']);

export function parseTraccarEvent(body: unknown): TraccarEvent | null {
  const b = obj(body);
  if (!b) return null;
  const event = obj(b.event);
  const device = obj(b.device);
  if (!event) return null;
  const type = String(event.type ?? '');
  const imei = String(device?.uniqueId ?? '').trim() || null;
  const traccarDeviceId = num(device?.id) ?? num(event.deviceId);
  const attrs = obj(event.attributes) ?? {};
  if (!imei) return { kind: 'ignored', type, imei: null };
  if (type === 'commandResult') {
    return {
      kind: 'commandResult',
      imei,
      traccarDeviceId,
      result: attrs.result == null ? null : String(attrs.result),
      commandType: attrs.type == null ? null : String(attrs.type),
    };
  }
  if (type === 'alarm') {
    // The alarm name is on the event's attributes; some protocols put it on the position instead.
    const positionAttrs = obj(obj(b.position)?.attributes);
    const alarm = String(attrs.alarm ?? positionAttrs?.alarm ?? '');
    return { kind: 'alarm', imei, traccarDeviceId, alarm };
  }
  if (type === 'deviceOnline' || type === 'deviceOffline') return { kind: type, imei, traccarDeviceId };
  return { kind: 'ignored', type, imei };
}

// ── The shared secret on forwarded requests ──────────────────────────────────

export function verifyForwardSecret(headers: Headers, env: Env = process.env): boolean {
  const expected = env.TRACCAR_FORWARD_SECRET ?? '';
  const got = headers.get(FORWARD_HEADER) ?? '';
  if (!expected || !got) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── The client: what we ask Traccar ──────────────────────────────────────────

export type CommandType = 'engineStop' | 'engineResume';

export interface TraccarClient {
  configured(): boolean;
  ping(): Promise<boolean>;
  /** Traccar's numeric device id for this IMEI, registering it if unknown. */
  ensureDevice(imei: string): Promise<number>;
  sendCommand(deviceId: number, type: CommandType): Promise<{ status: 'sent' | 'queued'; externalRef: string | null }>;
}

export function traccarClient(env: Env = process.env): TraccarClient {
  const base = (env.TRACCAR_URL ?? '').replace(/\/$/, '');
  const token = env.TRACCAR_TOKEN ?? '';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const configured = () => base.length > 0 && token.length > 0;
  const call = async (path: string, init: RequestInit = {}) => {
    if (!configured()) throw new Error('Traccar is not configured (TRACCAR_URL / TRACCAR_TOKEN).');
    return fetch(`${base}/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TRACCAR_TIMEOUT_MS) });
  };
  return {
    configured,
    async ping() {
      try {
        const res = await call('/server');
        return res.ok;
      } catch {
        return false;
      }
    },
    async ensureDevice(imei) {
      const found = await call(`/devices?uniqueId=${encodeURIComponent(imei)}`);
      if (found.ok) {
        const list = (await found.json()) as { id?: number; uniqueId?: string }[];
        const hit = Array.isArray(list) ? list.find((d) => d.uniqueId === imei) : undefined;
        if (hit?.id) return hit.id;
      }
      const created = await call('/devices', { method: 'POST', body: JSON.stringify({ name: imei, uniqueId: imei }) });
      if (!created.ok) throw new Error(`Traccar device registration failed (${created.status}): ${await created.text().catch(() => '')}`);
      const dev = (await created.json()) as { id?: number };
      if (!dev.id) throw new Error('Traccar returned no device id.');
      return dev.id;
    },
    async sendCommand(deviceId, type) {
      const res = await call('/commands/send', { method: 'POST', body: JSON.stringify({ deviceId, type }) });
      if (res.status === 202) {
        const q = (await res.json().catch(() => null)) as { id?: number } | { id?: number }[] | null;
        const id = Array.isArray(q) ? q[0]?.id : q?.id;
        return { status: 'queued', externalRef: id == null ? null : String(id) };
      }
      if (!res.ok) throw new Error(`Traccar command failed (${res.status}): ${await res.text().catch(() => '')}`);
      const c = (await res.json().catch(() => null)) as { id?: number } | null;
      return { status: 'sent', externalRef: c?.id == null ? null : String(c.id) };
    },
  };
}
