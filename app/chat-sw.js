// Service worker trang "Tin nhan khach" (nhan vien): chi nhan thong bao day, khong luu du lieu.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'Tin nhắn khách', { body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: '/chat-icon-192.png', badge: '/chat-icon-192.png', data: { url: d.url || '/chat' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/chat';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if (new URL(c.url).pathname === '/chat' && 'focus' in c) { c.postMessage({ open: url }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
