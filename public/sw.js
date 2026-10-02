// Elite Fleet Management service worker — minimal offline shell, plus web push.
// Network-first for navigations (always try fresh data), cache-first for static.
// Push: show what the server sent, and a tap opens the page it names.
const CACHE = 'fleet-management-v1';
const SHELL = ['/', '/offline', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first, fall back to cached shell / offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/offline'))),
    );
    return;
  }

  // Static assets: cache-first.
  if (/\.(?:css|js|png|svg|woff2?|webp|ico)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
            return res;
          }),
      ),
    );
  }
});

// ── Web push ──────────────────────────────────────────────────────────────
// Payload shape (see src/lib/push.ts pushPayload): { title, body, data: { url }, tag? }.
// A push with no readable payload still shows something — the browser revokes
// a subscription that receives pushes and shows nothing.

function readPushPayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json() || {};
  } catch {
    try {
      return { body: event.data.text() };
    } catch {
      return {};
    }
  }
}

self.addEventListener('push', (event) => {
  const payload = readPushPayload(event);
  const title = payload.title || 'Alert about your car';
  const url = (payload.data && payload.data.url) || '/';
  const options = {
    body: payload.body || '',
    data: { url },
    icon: '/icon.svg',
  };
  if (payload.tag) {
    // Same episode, same notification: replace rather than stack, but still buzz.
    options.tag = payload.tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Prefer a tab already on the page; then any of our tabs, steered there; else a new one.
      const exact = list.find((c) => c.url === target && 'focus' in c);
      if (exact) return exact.focus();
      const any = list.find((c) => 'focus' in c && 'navigate' in c);
      if (any) {
        return any
          .focus()
          .then((c) => (c && c.navigate ? c.navigate(target) : c))
          .catch(() => self.clients.openWindow(target));
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    }),
  );
});

// The push service rotated the subscription under us. Re-subscribe with the
// same server key and tell the server about the new endpoint, so alerts keep
// arriving without the owner having to visit Settings again.
self.addEventListener('pushsubscriptionchange', (event) => {
  const old = event.oldSubscription;
  const key = old && old.options && old.options.applicationServerKey;
  if (!key) return;
  const post = (method, body) =>
    fetch('/api/push/subscribe', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .then((sub) => post('POST', sub.toJSON()))
      .then(() => (old.endpoint ? post('DELETE', { endpoint: old.endpoint }) : undefined))
      .catch(() => {}),
  );
});
