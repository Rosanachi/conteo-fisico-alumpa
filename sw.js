// Service worker: guarda la app en caché para que abra sin conexión.
// Cambie CACHE_VERSION cada vez que publique cambios en los archivos.
const CACHE_VERSION = 'v10';
const CACHE_NAME = `inventario-${CACHE_VERSION}`;
// Caché aparte para las imágenes del catálogo (cache-first, se llena bajo demanda; no se borra al cambiar de versión)
const IMG_CACHE = 'inventario-img-v1';
const IMG_MAX = 400;
const ASSETS = [
    './', 'index.html', 'app.js', 'cliente-api.js', 'admin.js', 'style.css',
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
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== IMG_CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Red primero para HTML/JS/CSS (siempre la versión nueva si hay internet); caché si no hay conexión.
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
    const path = new URL(req.url).pathname;
    // Las respuestas de la API (sesión, conteos) nunca se guardan en caché: son por usuario y deben ser actuales
    if (path.startsWith('/api/')) return;
    if (/\/catalog\/img\//.test(path)) {
        event.respondWith(caches.open(IMG_CACHE).then((cache) => cache.match(req).then((hit) => hit || fetch(req).then((res) => {
            if (res.ok) {
                cache.put(req, res.clone()).then(() => cache.keys()).then((keys) => { if (keys.length > IMG_MAX) cache.delete(keys[0]); });
            }
            return res;
        }))));
        return;
    }
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
