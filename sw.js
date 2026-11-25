// Foglio — service worker: funziona offline dopo la prima apertura
const VERSION = 'foglio-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/app.js', 'js/db.js', 'js/imgproc.js', 'js/worker.js', 'vendor/jspdf.umd.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];
const RUNTIME = 'foglio-runtime'; // motore e lingue OCR scaricati da CDN

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== RUNTIME).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // prima la rete (aggiornamenti), poi la cache se offline
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  } else if (/jsdelivr|tessdata|unpkg/.test(url.hostname)) {
    // file OCR: dalla cache se presenti
    e.respondWith(caches.open(RUNTIME).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res;
    }));
  }
});
