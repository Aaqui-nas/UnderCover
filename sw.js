const CACHE = 'undercover-dev'; // remplacé automatiquement par la CI à chaque déploiement
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'firebase-config.js', 'cloud.js', 'manifest.json',
  'fonts/stencil-800.woff2', 'fonts/plexmono-400.woff2', 'fonts/plexmono-600.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Réseau d'abord (pour récupérer les mises à jour), cache si hors-ligne.
// Seuls les fichiers de l'appli et le SDK Firebase sont mis en cache ;
// les requêtes Firestore/Auth passent directement au réseau.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin && url.hostname !== 'www.gstatic.com') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
