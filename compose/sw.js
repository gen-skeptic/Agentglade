// Service worker for the composer PWA. Bump VERSION when shell files change.
const VERSION = 'agentglade-compose-v8';
const SHELL = [
  './',
  '../assets/app.webmanifest',
  '../assets/css/terminal.css',
  '../assets/css/site.css?v=8',
  '../assets/css/compose.css?v=8',
  '../assets/css/community.css?v=8',
  '../assets/fonts/fonts.css',
  '../assets/fonts/jetbrains-mono-latin-wght-normal.woff2',
  '../assets/fonts/manrope-latin-wght-normal.woff2',
  '../assets/js/compose.js?v=8',
  '../assets/js/icons.js?v=8',
  '../assets/js/render.js?v=8',
  '../assets/js/profile-directory.js?v=8',
  '../assets/js/data.js?v=8',
  '../assets/js/auth.js?v=8',
  '../assets/js/theme.js?v=8',
  '../assets/js/drafts.js?v=8',
  '../assets/js/media.js?v=8',
  '../assets/js/camera.js?v=8',
  '../assets/img/favicon.svg',
  '../assets/img/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (fresh code when online), cache as the offline fallback.
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  // Never cache the API (identity, uploads) or post data.
  if (request.method !== 'GET' || url.origin !== location.origin || /^\/(api|data|media)\//.test(url.pathname)) return;
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(request, copy)); }
        return res;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })),
  );
});
