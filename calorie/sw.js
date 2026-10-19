/* オフラインでも開けるようにアプリ本体をキャッシュする（写真の解析には通信が必要） */
const CACHE = 'calorie-note-v1';
const SHELL = ['./', './index.html', './assets/style.css', './assets/app.js', './manifest.webmanifest', './assets/icon.svg'];

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

// 自分のファイルだけ扱う（API への通信はキャッシュしない）
self.addEventListener('fetch', (ev) => {
  if (ev.request.method !== 'GET' || new URL(ev.request.url).origin !== self.location.origin) return;
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
