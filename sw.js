// Service worker: guscio dell'app in cache, dati MAI.
//
// La versione arriva dalla query di registrazione (`sw.js?v=…`), che viene da
// APP_VERSION in config.js: un'unica fonte di verità, e cambiando versione
// cambia anche l'URL del worker, quindi il browser se ne accorge di sicuro.

const VERSION = new URL(self.location.href).searchParams.get('v') ?? 'dev';
const CACHE = `spese-${VERSION}`;

// Il guscio COMPLETO, non il minimo indispensabile.
//
// Prima bastava poco: il resto entrava in cache da solo alla prima visita, e
// l'app offline non funzionava comunque. Con la coda offline non è più vero —
// l'inserimento deve partire senza rete — e `app.js` importa una ventina di
// moduli: se ne manca uno, l'avvio offline è una schermata bianca.
//
// La finestra scoperta è stretta ma reale: subito dopo un cambio di
// APP_VERSION la cache è nuova e contiene solo questo elenco, perché quella
// vecchia viene cancellata in `activate`.
//
// L'elenco è scritto a mano — non c'è un build step che possa generarlo — ma
// NON si rompe in silenzio quando si rinomina un file: un test cammina il
// grafo degli import a partire da app.js e verifica che sia tutto qui
// (dev/selftest.js, suite PWA).
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './js/app.js',
  './js/config.js',
  './js/crypto.js',
  './js/errors.js',
  './js/export-xlsx.js',
  './js/github.js',
  './js/icons.js',
  './js/idb.js',
  './js/keypad.js',
  './js/kpi.js',
  './js/model.js',
  './js/outbox.js',
  './js/recurring.js',
  './js/screen-entry.js',
  './js/screen-income.js',
  './js/screen-movements.js',
  './js/screen-settings.js',
  './js/screen-summary.js',
  './js/setup.js',
  './js/store.js',
  './js/ui.js',
  './js/zip.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Uno per uno dentro allSettled, MAI addAll: addAll è atomico, e un solo
    // file irraggiungibile farebbe fallire l'intero install lasciando il
    // worker non attivo — cioè nessun guscio offline invece di uno parziale.
    const results = await Promise.allSettled(CORE.map((url) => cache.add(url)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) console.warn(`[sw] ${failed} risorse su ${CORE.length} non precacheate`);
    await self.skipWaiting();
  })());
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
