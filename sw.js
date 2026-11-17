// Service worker: guarda la app en caché para que abra sin conexión.
// Cambie CACHE_VERSION cada vez que publique cambios en los archivos.
const CACHE_VERSION = 'v3';
const CACHE_NAME = `inventario-${CACHE_VERSION}`;
const ASSETS = [
    './', 'index.html', 'app.js', 'style.css', 'lib/xlsx.full.min.js',
    'manifest.webmanifest', 'icon.svg',
    'fonts/outfit-300.ttf', 'fonts/outfit-400.ttf', 'fonts/outfit-500.ttf',
    'fonts/outfit-600.ttf', 'fonts/outfit-700.ttf'
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Red primero para HTML/JS/CSS (siempre la versión nueva si hay internet); caché si no hay conexión.
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
    event.respondWith(
        fetch(req)
            .then((res) => {
                const copy = res.clone();
                if (res.ok) caches.open(CACHE_NAME).then((c) => c.put(req, copy));
                return res;
            })
            .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
    );
});
