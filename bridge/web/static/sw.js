// No-op service worker.
//
// HISTORY: this file used to be a "self-destructing" SW that wiped
// caches, force-navigated every open client (= page reload), and then
// unregistered itself. The intent was "make stale-asset issues go away
// in one cycle." The actual effect was an infinite reload loop:
//
//   1. Page loads, app.js calls navigator.serviceWorker.register('/sw.js')
//   2. Browser installs the SW, fires activate
//   3. activate: wipe caches → c.navigate(c.url) for every client → unregister
//   4. The navigate() call reloads the page
//   5. New page load → app.js re-registers → install → activate fires again
//   6. → step 3, forever
//
// On iOS Safari's PWA this manifests as a blank/white screen after every
// bridge restart, sometimes recoverable by force-quitting the PWA, and
// eventually triggers "A problem repeatedly occurred on https://..." —
// Safari's reload-loop circuit breaker.
//
// Fix: install + activate clear any stale CacheStorage entries, claim
// existing clients so future navigations route through us (without a
// reload), then idle. No fetch handler, so every request hits the
// network with the bridge's no-store HTTP headers.
//
// Re-registering this SW from app.js is harmless — if the bytes haven't
// changed, the browser doesn't trigger a new install/activate cycle.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Minimize the activate window. clients.claim() FIRST so we're
  // controlling pages ASAP; the cache wipe runs only if there's
  // actually anything to delete (skip the keys() roundtrip when
  // empty). The reason: a push arriving DURING `activating` lands at
  // a SW that iOS treats as not-yet-ready and silently drops the
  // showNotification. Was the root cause of "no banner after a
  // bridge restart" — found by code-reviewer.
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch (e) {}
    try {
      const names = await caches.keys();
      if (names.length) {
        await Promise.all(names.map((n) => caches.delete(n)));
      }
    } catch (e) {}
  })());
});

// Intentionally no fetch listener.

// ─── Web Push handler ────────────────────────────────────────────────
//
// Fires when the bridge sends a Web Push notification (via pywebpush).
// We pull a tiny JSON payload off the event ({title, body, url, tag})
// and render an iOS-native notification banner. iOS PWAs added to the
// home screen will display these even when the app is fully closed.
//
// The bridge sends pushes on `run_finished` events for tabs that
// subscribed via /api/push/subscribe — see bridge/web/server.py.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (e) {
    // Body wasn't JSON — fall back to text.
    try { payload = { body: event.data.text() }; } catch (e2) {}
  }
  const title = payload.title || 'Bridge';
  const opts = {
    body: payload.body || 'Task finished',
    icon: '/icons/app-icon.svg',
    badge: '/icons/app-icon.svg',
    data: { url: payload.url || '/' },
    // Only attach a `tag` when the server explicitly sets a non-empty
    // one. Without a tag, every push gets a unique notification id, so
    // iOS always alerts (sound + banner) instead of silently replacing
    // a previous same-tag banner.
  };
  if (payload.tag) opts.tag = payload.tag;
  // `clients.claim()` BEFORE `showNotification`. If a push arrives
  // during the activate window (right after a bridge restart with a
  // bumped asset version), the SW is still in `activating` state and
  // iOS silently discards `showNotification` calls. Claiming clients
  // first promotes the SW to `activated` so the banner actually shows.
  // Code-reviewer found this as the root cause of "no banner after a
  // version bump."
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch (e) {}
    return self.registration.showNotification(title, opts);
  })());
});

// When the user taps the notification, focus / open the PWA.
//
// On iOS Safari PWAs, `Client.navigate()` is unreliable — sometimes a
// no-op, sometimes fails silently. So we use a two-channel strategy:
//
//   1) Already-open clients: postMessage them with the target URL.
//      app.js listens for `crc-deep-link` and switches/creates the
//      matching tab in-app (no page reload, no lost state).
//   2) No client open: openWindow(targetUrl). The fresh boot's
//      `_applyPushDeepLink` reads ?project=&tab= from the URL.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Also close every OTHER visible notification we put up — if the
  // user opened the app via one banner, the other "run finished"
  // banners stacked underneath in notification center are now stale
  // and just clutter. The app's _clearVisibleNotifications hook also
  // does this on resume; doing it here too means the lock-screen /
  // notification-shade visibly empties the instant the user taps,
  // not a beat later when the app finishes booting.
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    try {
      const notifs = await self.registration.getNotifications();
      for (const n of notifs) {
        try { n.close(); } catch (e) {}
      }
    } catch (e) {}
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      try {
        const u = new URL(w.url);
        if (u.origin === self.location.origin) {
          await w.focus();
          // Tell the in-app router where to go. Parse the target
          // URL's params so the client can act on them without
          // re-parsing the path itself.
          try {
            const t = new URL(targetUrl, self.location.origin);
            const params = {};
            t.searchParams.forEach((v, k) => { params[k] = v; });
            w.postMessage({ type: 'crc-deep-link', url: targetUrl, params });
          } catch (e) {}
          return;
        }
      } catch (e) {}
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
