// Service worker mínimo: permite instalar la app y abrirla sin conexión (muestra la última versión).
// Las consultas a Apps Script no se tocan: siempre van a la red.
const CACHE = 'asistente-v2';
const COMPARTIDOS = 'compartidos';   // archivo recibido por "Compartir" (se borra al usarlo)
const ARCHIVOS = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== COMPARTIDOS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Red primero (para recibir siempre la versión nueva), caché si no hay conexión.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // "Compartir" desde otra app (WhatsApp, Galería…): Android manda el archivo por POST a ./compartir
  // (share_target del manifiesto). Se guarda un momento y se abre la app, que lo toma y lo envía.
  if (e.request.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/compartir')) {
    e.respondWith((async () => {
      try {
        const datos = await e.request.formData();
        const archivo = datos.get('archivo');
        const texto = [datos.get('title'), datos.get('text')].filter(Boolean).join(' ').trim();
        const c = await caches.open(COMPARTIDOS);
        await c.delete('./compartido-archivo'); await c.delete('./compartido-texto');
        if (archivo && archivo.size) {
          await c.put('./compartido-archivo', new Response(archivo, { headers: {
            'Content-Type': archivo.type || 'application/octet-stream', 'X-Nombre': encodeURIComponent(archivo.name || 'comprobante') } }));
        }
        if (texto) await c.put('./compartido-texto', new Response(texto));
      } catch (err) { /* si falla, la app abre igual */ }
      return Response.redirect(new URL('./?compartido=1', self.location).href, 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
