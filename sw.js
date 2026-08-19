// Service worker: guscio dell'app in cache, dati MAI.
//
// La versione arriva dalla query di registrazione (`sw.js?v=…`), che viene da
// APP_VERSION in config.js: un'unica fonte di verità, e cambiando versione
// cambia anche l'URL del worker, quindi il browser se ne accorge di sicuro.

const VERSION = new URL(self.location.href).searchParams.get('v') ?? 'dev';
const CACHE = `spese-${VERSION}`;

// Minimo indispensabile per aprire l'app offline. Il resto entra in cache da
// solo alla prima visita (vedi il fetch handler): un elenco lungo e scritto a
// mano si rompe in silenzio appena si rinomina un file, e un precache che
// fallisce impedisce al worker di attivarsi.
const CORE = ['./', './index.html', './css/app.css', './js/app.js', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // I dati non si mettono MAI in cache. Servire spese stantie sarebbe peggio
  // che non servirle, e le risposte sono comunque cifrate e inutili offline.
  if (url.hostname === 'api.github.com') return;

  // Solo la nostra origine: niente di terze parti da conservare.
  if (url.origin !== self.location.origin) return;

  // Prima la rete, la cache come rete di sicurezza.
  //
  // Non cache-first: l'app NON funziona offline comunque, perché i dati
  // arrivano dall'API di GitHub. La cache serve solo a non lasciare una
  // schermata bianca quando la rete manca. Con cache-first, invece, dopo
  // ogni deploy si continuerebbe a eseguire il codice vecchio — che su
  // un'app che scrive dati finanziari è un rischio sproporzionato al
  // vantaggio di qualche centinaio di millisecondi all'avvio.
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch (err) {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
