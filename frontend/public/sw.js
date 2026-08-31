const CACHE_VERSION = "wheely-shell-v5";
const APP_SHELL = [
  "/app.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const response = await fetch("/app.html", { cache: "reload" });
    if (!response.ok) throw new Error("App shell unavailable");
    const html = await response.clone().text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)[^\"]*"/g)].map((match) => match[1]);
    await cache.put("/app.html", response);
    await cache.addAll([...new Set([...APP_SHELL.filter((path) => path !== "/app.html"), ...assets])]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
  ]));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    const isApp = url.pathname === "/app" || url.pathname === "/app.html";
    if (!isApp) return;
    event.respondWith((async () => {
      try {
        const response = await fetch("/app.html", { cache: "no-cache" });
        if (response.ok) await caches.open(CACHE_VERSION).then((cache) => cache.put("/app.html", response.clone()));
        return response;
      } catch {
        return (await caches.match("/app.html")) || Response.error();
      }
    })());
    return;
  }
  const cached = caches.match(request);
  const update = fetch(request).then(async (response) => {
      if (response.ok && ["script", "style", "image", "font", "manifest"].includes(request.destination)) {
        await caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    }).catch(() => null);
  event.waitUntil(update.then(() => undefined));
  event.respondWith(cached.then(async (saved) => saved || (await update) || Response.error()));
});
