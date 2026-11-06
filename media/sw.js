const CACHE = 'lvgl-go-shell-v44';
const SHELL = ['/app/', '/app/app.js', '/app/styles.css', '/app/session.js', '/app/updates.js', '/app/player.js', '/app/console.js', '/app/memory.js', '/app/view.js', '/app/qr.js', '/app/manifest.webmanifest', '/app/icon.svg', '/app/icon-180.png', '/app/icon-192.png', '/app/icon-512.png', '/app/icon-maskable-512.png'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('lvgl-go-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache pairing tokens, SSE, manifests describing sessions, or WASM bundles.
  // Cache the launch image requested by this device, without downloading every size.
  const startupImage = /^\/app\/startup-\d{3,4}x\d{3,4}\.png$/.test(url.pathname);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || (!SHELL.includes(url.pathname) && !startupImage)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); }
    return response;
  }).catch(() => caches.match(event.request)));
});
