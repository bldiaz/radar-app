// Service worker: la app abre al instante y funciona sin conexión con el último análisis descargado.
const CACHE = "radar-v1";
const BASE = ["./", "index.html", "estilos.css", "app.js", "vendor/lightweight-charts.js", "manifest.webmanifest", "iconos/icono-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Siempre intenta la red primero (datos y app actualizados); si no hay conexión, usa la copia guardada.
  e.respondWith(fetch(e.request).then((r) => {
    const copia = r.clone();
    if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, copia));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
