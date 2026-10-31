// Service worker trang khach VMT: cho phep cai app (them vao man hinh chinh) + nhan thong bao day sau nay.
// Khong luu du lieu khach vao bo nho dem (chi trang "mat mang" de khach biet).
const OFF = '/offline.html';
self.addEventListener('install', (e) => { e.waitUntil(caches.open('vmt-v1').then((c) => c.add(OFF)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFF)));
});
// Thong bao day (dung cho tin nhan / don hang o buoc sau). Cung "tag" -> thay the thong bao cu, khong chong nhieu cai.
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'Thông báo mới', { body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: d.icon || '/pwa/icon-192.png', badge: '/pwa/icon-192.png', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
