// Ban Kho TQ: giu giao dien + bo quet tren dien thoai (mang TQ -> VN cham). API luon di mang.
const C = 'kho-v3';
const SHELL = ['/kho/', '/kho/help', '/ext/vendor/html5-qrcode.min.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (SHELL.indexOf(u.pathname) >= 0) {
    // Mo ngay ban da luu; cap nhat ngam (ETag -> thuong chi 304) cho lan mo sau
    e.respondWith(caches.open(C).then((c) => c.match(u.pathname).then((hit) => {
      const net = fetch(e.request).then((r) => { if (r.ok) c.put(u.pathname, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    })));
  }
});
