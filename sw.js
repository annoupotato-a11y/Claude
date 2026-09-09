/* オフラインでも開けるようにアプリ本体をキャッシュする（データはブラウザ内のみ） */
const CACHE = 'gengoka-note-v2';
const SHELL = [
  './', './index.html', './assets/style.css', './assets/app.js',
  './manifest.webmanifest', './assets/icon.svg', './assets/icon-180.png', './assets/icon-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// まずネットワーク、だめならキャッシュ（更新をすぐ受け取りつつ圏外でも開ける）
self.addEventListener('fetch', (ev) => {
  if (ev.request.method !== 'GET') return;
  ev.respondWith(
    fetch(ev.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(ev.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(ev.request).then((hit) => hit || caches.match('./index.html')))
  );
});
