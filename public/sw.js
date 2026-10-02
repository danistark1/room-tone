self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let message = {};
  try { message = event.data?.json() || {}; } catch { /* Always show a visible alert. */ }
  const callId = typeof message.callId === 'string' ? message.callId.slice(0, 80) : '';
  const test = message.type === 'test';
  const expired = Number(message.expiresAt) > 0 && Date.now() > Number(message.expiresAt);
  event.waitUntil(self.registration.showNotification(test ? 'Roomtone test alert' : expired ? 'Missed Roomtone call' : 'Incoming Roomtone call', {
    body: test ? 'Your intercom can receive notifications.' : expired ? 'Open Roomtone to see your rooms.' : 'Tap to open Roomtone and answer before the call ends.',
    icon: '/icon-192.png', badge: '/icon-192.png', tag: test ? 'roomtone-test' : `roomtone-${callId || Date.now()}`,
    renotify: true, data: { callId },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const callId = event.notification.data?.callId || '';
  const target = new URL('/', self.location.origin);
  if (callId) target.searchParams.set('call', callId);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const windowClient of windows) {
      if (new URL(windowClient.url).origin !== self.location.origin) continue;
      await windowClient.focus();
      windowClient.postMessage({ type: 'roomtone:open-call', callId });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
