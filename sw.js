// Service worker: rede primeiro (sempre pega a versão nova quando online),
// cache como reserva para funcionar offline.
const CACHE = 'tetis-v14';
const ARQUIVOS = [
  './',
  './index.html',
  './styles.css',
  './tema-shadcn.css',
  './config.js',
  './icones.js',
  './plano.js',
  './graficos-financas.js',
  './app.js',
  './nuvem.js',
  './manifest.webmanifest',
  './icons/favicon-32.png',
  './icons/logo-96.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];
// Bibliotecas do Firebase (URLs com versão fixa: podem vir direto do cache)
const CDN_FIREBASE = 'https://www.gstatic.com/firebasejs/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  if (req.url.startsWith(CDN_FIREBASE)) {
    e.respondWith(
      caches.match(req).then((r) => r || fetch(req).then((resp) => {
        const copia = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copia));
        return resp;
      }))
    );
    return;
  }

  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    // no-cache: sempre confere com o servidor, para nunca ficar preso numa versão antiga
    fetch(req, { cache: 'no-cache' })
      .then((resp) => {
        const copia = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copia));
        return resp;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});
