// Keeps the app's own files on the phone so it opens fast and works with a weak signal.
const CACHE = "cbs-v1";
const FILES = ["./", "index.html", "config.js", "shim.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "flyer-1.jpg", "flyer-2.jpg"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;   // never cache Supabase data
  // Network first, so updates you upload show up; fall back to the saved copy offline.
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
