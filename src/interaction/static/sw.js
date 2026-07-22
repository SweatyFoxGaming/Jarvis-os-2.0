// Jarvis OS service worker — exists for exactly one reason: receive Push
// API events (from src/interaction/push.ts, via scheduler.pushNotification)
// and show them as real OS-level notifications, even when no Jarvis tab is
// open. Deliberately does NOT do offline caching/asset pre-fetching — this
// app depends on a live backend connection for everything real it does, so
// an offline shell would just be a broken-looking app pretending to work.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Jarvis OS', body: 'You have a new notification.' };
  if (event.data) {
    try { data = event.data.json(); } catch { data.body = event.data.text(); }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Jarvis OS', {
      body: data.body || '',
      icon: '/pwa/icon-256.png',
      badge: '/pwa/icon-256.png',
      tag: 'jarvis-proactive', // replaces a still-visible prior notification instead of stacking
    })
  );
});

// Clicking the notification focuses an existing Jarvis tab if one's open,
// otherwise opens a new one — never leaves the user staring at a dead notification.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
