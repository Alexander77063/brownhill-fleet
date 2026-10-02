'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';

/**
 * "Get alerts on this phone" — the web-push opt-in.
 *
 * Renders on an owner's Settings page (and later on the on-call roster for our
 * own staff). The browser owns the subscription; this component asks for it,
 * hands a copy to `/api/push/subscribe`, and shows plainly whether this
 * particular device will get alerts. Copy is addressed to an owner about their
 * car, not to an operator about a fleet.
 *
 * The public VAPID key is inlined at build time from
 * `NEXT_PUBLIC_VAPID_PUBLIC_KEY`; without it, or on a browser with no push
 * support, the component says so in one muted line and offers nothing else —
 * a button that can never work is worse than no button.
 *
 * Push needs a service worker. The app only registers `/sw.js` in production
 * builds, so the opt-in registers it itself when the person taps the button —
 * `navigator.serviceWorker.ready` would otherwise wait forever in development,
 * and registering an already-registered worker is a no-op.
 */

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const SUBSCRIBE_URL = '/api/push/subscribe';

type State =
  | 'checking' // first render, before the browser has been asked
  | 'unsupported' // no Notification / serviceWorker / PushManager, or no key
  | 'blocked' // permission previously denied — only browser settings can undo that
  | 'off'
  | 'on'
  | 'working'; // a subscribe/unsubscribe round trip is in flight

function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

/** VAPID keys are URL-safe base64; `pushManager.subscribe` wants raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (!existing) await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

/**
 * True when a subscription the browser already holds was made with OUR key.
 * After a VAPID rotation the old one still exists client-side but every send
 * to it is refused, so it must be replaced rather than reported as "on".
 */
function madeWithKey(sub: PushSubscription, key: string): boolean {
  const held = sub.options.applicationServerKey;
  if (!held) return true; // browser did not expose it; nothing to compare against
  const ours = urlBase64ToUint8Array(key);
  const theirs = new Uint8Array(held);
  return theirs.length === ours.length && theirs.every((b, i) => b === ours[i]);
}

/**
 * The route answers `{ ok: true }` as JSON. Checking the body, not just the
 * status, matters: with an expired session the middleware redirects to
 * /login, fetch follows it, and the login page comes back as a 200.
 */
async function send(method: 'POST' | 'DELETE', body: unknown): Promise<boolean> {
  try {
    const res = await fetch(SUBSCRIBE_URL, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return data?.ok === true;
  } catch {
    return false;
  }
}

export function PushOptIn({ available = true }: { available?: boolean }) {
  const [state, setState] = useState<State>('checking');
  const [error, setError] = useState<string | null>(null);

  // Ask the browser what it already knows. Same first render on server and
  // client ('checking'), so there is nothing to mismatch on hydration.
  useEffect(() => {
    if (!PUBLIC_KEY || !supported()) {
      setState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setState('blocked');
      return;
    }
    let cancelled = false;
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => reg?.pushManager.getSubscription() ?? null)
      .then((sub) => {
        if (cancelled) return;
        const usable = !!sub && madeWithKey(sub, PUBLIC_KEY);
        setState(usable ? 'on' : 'off');
        // A subscription the browser still holds is re-sent so the server row
        // follows whoever is signed in on this device now. Idempotent upsert.
        if (sub && usable) void send('POST', sub.toJSON());
      })
      .catch(() => {
        if (!cancelled) setState('off');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOn() {
    if (!PUBLIC_KEY) return;
    setError(null);
    setState('working');
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'denied') {
        setState('blocked');
        return;
      }
      if (permission !== 'granted') {
        setState('off');
        return;
      }
      const reg = await registration();
      let sub = await reg.pushManager.getSubscription();
      if (sub && !madeWithKey(sub, PUBLIC_KEY)) {
        // Left over from an earlier key; the push service would refuse it.
        await sub.unsubscribe().catch(() => {});
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(PUBLIC_KEY) as BufferSource,
      });
      if (!(await send('POST', sub.toJSON()))) {
        // The browser subscribed but we could not record it — undo, so the
        // status shown matches what will actually happen.
        await sub.unsubscribe().catch(() => {});
        setError("Couldn't switch alerts on for this phone. Check your connection and try again.");
        setState('off');
        return;
      }
      setState('on');
    } catch {
      setError("Couldn't switch alerts on for this phone. Try again in a moment.");
      setState('off');
    }
  }

  async function turnOff() {
    setError(null);
    setState('working');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = (await reg?.pushManager.getSubscription()) ?? null;
      if (sub) {
        await send('DELETE', { endpoint: sub.endpoint });
        await sub.unsubscribe().catch(() => {});
      }
      setState('off');
    } catch {
      setError("Couldn't switch alerts off. Try again in a moment.");
      setState('on');
    }
  }

  if (!available) {
    return (
      <p className="text-sm text-muted" role="status">
        Alerts on your phone come with the Gold plan. Ask your insurer or fleet about upgrading.
      </p>
    );
  }

  if (state === 'unsupported') {
    return (
      <p className="text-sm text-muted" role="status">
        {PUBLIC_KEY
          ? 'This browser can’t show alerts. On an iPhone, add this site to your Home Screen first, then come back here.'
          : 'Alerts on your phone aren’t switched on for this service yet.'}
      </p>
    );
  }

  const busy = state === 'working' || state === 'checking';
  const status =
    state === 'checking'
      ? 'Checking this phone…'
      : state === 'working'
        ? 'One moment…'
        : state === 'blocked'
          ? 'Notifications are blocked for this site. Allow them in your browser settings, then come back here.'
          : state === 'on'
            ? 'This phone will get alerts about your car.'
            : 'Alerts on this phone are off.';

  return (
    <div className="space-y-3">
      <p className="text-sm text-parchment">
        Get a notification the moment your car moves at night, speeds, leaves its area or its tracker goes
        quiet — even when this page is closed.
      </p>
      <p role="status" aria-live="polite" className={`text-sm ${state === 'on' ? 'text-profit' : 'text-muted'}`}>
        {status}
      </p>
      {error && (
        <p role="alert" className="text-sm text-loss">
          {error}
        </p>
      )}
      {state !== 'blocked' && (
        <Button
          type="button"
          variant={state === 'on' ? 'outline' : 'primary'}
          onClick={state === 'on' ? turnOff : turnOn}
          disabled={busy}
          className="min-h-11 w-full sm:w-auto"
        >
          {state === 'on' ? 'Turn off' : 'Get alerts on this phone'}
        </Button>
      )}
    </div>
  );
}
