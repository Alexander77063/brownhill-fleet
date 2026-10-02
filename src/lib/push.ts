/**
 * Web push on the platform's own VAPID keys.
 *
 * One table, `push_subscriptions`, one row per browser per user; owners and
 * platform admins both live in it and the sender picks by user id. Delivery is
 * best-effort by design — an alert's portal row is the record, push is a way
 * of getting someone to look at it — so nothing in here throws: a missing key,
 * a database error or a dead endpoint all degrade to "fewer than hoped were
 * sent", counted and logged.
 *
 * Dead endpoints are the one thing that must be acted on. A push service says
 * 404 or 410 for a subscription the browser has dropped (uninstalled PWA,
 * revoked permission, rotated subscription). Left in place, every alert would
 * fan out to a growing pile of endpoints that will never answer, so those rows
 * are deleted the moment the service says so.
 *
 * The VAPID triple is passed per send rather than through `setVapidDetails`:
 * that keeps the module free of global state, which matters when the same
 * process serves several deployments' tests and, later, if a tenant brings its
 * own keys.
 *
 * Env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:` or
 * `https:` URL). The browser needs the public key too, as
 * `NEXT_PUBLIC_VAPID_PUBLIC_KEY`. Generate a pair once with
 * `npx web-push generate-vapid-keys` and never rotate casually — every existing
 * subscription is bound to the public key it was created with.
 */
import webpush from 'web-push';
import { createServiceClient } from '@/lib/supabase/server';

/** What a notification says and where a tap takes the person. */
export interface PushMessage {
  title: string;
  body: string;
  /** Same-origin path the notification opens, e.g. `/owner/alerts`. */
  url: string;
  /**
   * Coalescing key: a second notification with the same tag replaces the first
   * instead of stacking. Use the alert's dedupe key so a long night-movement
   * episode is one notification, not twenty.
   */
  tag?: string;
}

/** A stored subscription, as the sender needs it. */
export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Where subscriptions live. The default reads `push_subscriptions` through the
 * service client; tests hand in a fake so the sender is exercised without a
 * database.
 */
export interface PushStore {
  listForUser(userId: string): Promise<PushSubscriptionRow[]>;
  remove(id: string): Promise<void>;
  touch(id: string, at: string): Promise<void>;
}

/** The slice of `web-push` the sender uses, so a test can stand in for it. */
export interface PushClient {
  sendNotification: typeof webpush.sendNotification;
}

export interface PushDeps {
  client?: PushClient;
  store?: PushStore;
  env?: NodeJS.ProcessEnv;
}

export interface PushSendOptions {
  /** Seconds the push service should hold the message for an offline device. */
  ttlSeconds?: number;
}

/** A day: an owner whose phone was off overnight should still see the night alert at breakfast. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** Push services return these when the browser has dropped the subscription. */
const GONE_STATUSES = new Set([404, 410]);

/** An RFC 8291 / browser-produced key: URL-safe base64, padding tolerated. */
const BASE64URL = /^[A-Za-z0-9_-]+=*$/;
/** Endpoints are ~200 characters in practice; browsers' own limit is well under this. */
const MAX_ENDPOINT_LENGTH = 2048;
/** p256dh is 87 characters, auth 22 — generous ceilings, not exact lengths. */
const MAX_KEY_LENGTH = 256;

function vapidFrom(env: NodeJS.ProcessEnv) {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { subject, publicKey, privateKey };
}

/** True when the platform can send push at all — all three VAPID variables present. */
export function pushConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return vapidFrom(env) !== null;
}

/**
 * The wire payload the service worker unpacks: `{ title, body, data: { url }, tag? }`.
 * `tag` is omitted rather than sent as `undefined`/`null` so the worker can
 * pass the object straight into `showNotification`.
 */
export function pushPayload(message: PushMessage): string {
  const { title, body, url, tag } = message;
  return JSON.stringify({ title, body, data: { url }, ...(tag ? { tag } : {}) });
}

/**
 * Validate what the browser sends from `PushSubscription.toJSON()`. Returns the
 * three columns we store, or null for anything that is not a well-formed
 * subscription — an `https:` endpoint and two base64url keys of sane length.
 * Nothing else about the body is trusted or kept.
 */
export function parsePushSubscription(body: unknown): { endpoint: string; p256dh: string; auth: string } | null {
  if (!body || typeof body !== 'object') return null;
  const { endpoint, keys } = body as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) return null;
  if (!isHttpsUrl(endpoint)) return null;
  if (!keys || typeof keys !== 'object') return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (!isKey(p256dh) || !isKey(auth)) return null;
  return { endpoint, p256dh, auth };
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH && BASE64URL.test(value);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Send one message to every device a user has subscribed.
 *
 * Returns how many went out and how many dead subscriptions were removed along
 * the way. Never throws: unconfigured → zeros immediately (the store is not
 * even asked); any other failure is logged and counted as not sent.
 */
export async function sendPushToUser(
  userId: string,
  message: PushMessage | string,
  deps: PushDeps = {},
  options: PushSendOptions = {},
): Promise<{ sent: number; pruned: number }> {
  const none = { sent: 0, pruned: 0 };
  const vapidDetails = vapidFrom(deps.env ?? process.env);
  if (!vapidDetails) return none;

  const client = deps.client ?? webpush;
  const payload = typeof message === 'string' ? message : pushPayload(message);
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  let store: PushStore;
  let rows: PushSubscriptionRow[];
  try {
    store = deps.store ?? serviceStore();
    rows = await store.listForUser(userId);
  } catch (e) {
    console.error('[push] could not load subscriptions', e);
    return none;
  }
  if (rows.length === 0) return none;

  let sent = 0;
  let pruned = 0;
  // Each device independently: one dead endpoint must not stop the others.
  await Promise.all(
    rows.map(async (row) => {
      try {
        await client.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload,
          { vapidDetails, TTL: ttl, urgency: 'high', timeout: 5_000 },
        );
        sent++;
        await store.touch(row.id, new Date().toISOString()).catch(() => {});
      } catch (e) {
        const status = (e as { statusCode?: unknown })?.statusCode;
        if (typeof status === 'number' && GONE_STATUSES.has(status)) {
          try {
            await store.remove(row.id);
            pruned++;
          } catch (removeError) {
            console.error('[push] could not prune dead subscription', row.id, removeError);
          }
          return;
        }
        console.error('[push] send failed', row.endpoint, e instanceof Error ? e.message : e);
      }
    }),
  );
  return { sent, pruned };
}

/**
 * The real store. Service client because the sender runs from crons and the
 * ingest path with no user session; every query is still scoped — by
 * `user_id` for the list, by primary key (taken from that list) for the rest.
 */
function serviceStore(): PushStore {
  const sb = createServiceClient();
  return {
    async listForUser(userId) {
      const { data, error } = await sb
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth')
        .eq('user_id', userId);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    async remove(id) {
      const { error } = await sb.from('push_subscriptions').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },
    async touch(id, at) {
      const { error } = await sb.from('push_subscriptions').update({ last_used_at: at }).eq('id', id);
      if (error) throw new Error(error.message);
    },
  };
}
