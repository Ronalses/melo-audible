const CACHE_NAME = 'melo-audiolibros-shell-v8';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './db.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

function scopeUrl(relPath) {
  return new URL(relPath, self.registration.scope).href;
}

function fetchWithTimeout(req, ms = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SW timeout')), ms);
    fetch(req)
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL.map((p) => scopeUrl(p))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) {
            return caches.delete(k);
          }
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Nunca interceptar API, audios MP3 ni el archivo cifrado de descubrimiento de túnel
  if (
    url.pathname.includes('/api/') ||
    url.pathname.includes('/books/') ||
    url.pathname.endsWith('.mp3') ||
    url.pathname.endsWith('tunnel_sync.json')
  ) {
    return;
  }

  const indexUrl = scopeUrl('./index.html');
  const rootUrl = scopeUrl('./');

  // Navegación principal (HTML): Network-First con timeout corto (2.5s) y fallback instantáneo a caché offline
  if (req.mode === 'navigate' || url.href.split('?')[0] === rootUrl || url.href.split('?')[0] === indexUrl) {
    event.respondWith(
      fetchWithTimeout(req, 2500)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(indexUrl, clone));
          }
          return res;
        })
        .catch(async () => (await caches.match(indexUrl)) || (await caches.match(rootUrl)))
    );
    return;
  }

  // Recursos del App Shell en el mismo origen (CSS, JS, Iconos, Manifest)
  if (url.origin === self.location.origin) {
    const cleanKey = url.origin + url.pathname;
    event.respondWith(
      fetchWithTimeout(req, 2500)
        .then((networkRes) => {
          if (networkRes && networkRes.ok) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((c) => c.put(cleanKey, clone));
          }
          return networkRes;
        })
        .catch(async () => (await caches.match(cleanKey)) || (await caches.match(req, { ignoreSearch: true })))
    );
  }
});
