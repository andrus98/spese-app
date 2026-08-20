// Guscio dell'app: stato, router a tre schermate, avvio.

import { el, clear, toast, humanError } from './ui.js';
import { uiIcon } from './icons.js';
import { GitHubClient } from './github.js';
import { Store } from './store.js';
import { loadKey } from './crypto.js';
import { makeTransaction, yearOf } from './model.js';
import { KIND } from './errors.js';
import {
  enqueue, list as listQueue, count as countQueue, remove as removeQueued, flush,
} from './outbox.js';
import { LS_REPO, LS_TOKEN, APP_VERSION } from './config.js';
import { createSetupScreen } from './setup.js';
import { createEntryScreen } from './screen-entry.js';
import { createSummaryScreen } from './screen-summary.js';
import { createSettingsSheet } from './screen-settings.js';
import { createMovementsScreen } from './screen-movements.js';
import { createIncomeScreen } from './screen-income.js';

const TABS = [
  { id: 'entry', label: 'Nuova spesa', icon: 'grid' },
  { id: 'income', label: 'Entrate', icon: 'income' },
  { id: 'summary', label: 'Riepilogo', icon: 'chart' },
  { id: 'movements', label: 'Movimenti', icon: 'list' },
];

// Credenziali della sessione. Vivono qui e non dentro boot() perché al ritorno
// della rete si rientra da start() senza rifare il boot da capo.
const session = { client: null, key: null, salt: null };

const app = {
  store: null,
  year: new Date().getFullYear(),
  tab: 'entry',

  /**
   * Modalità ridotta: l'app è partita senza rete e non ha nessun dato.
   * Diverso da "la rete è caduta a sessione avviata", dove i dati restano in
   * memoria e tutto è consultabile: lì cambia solo la destinazione delle
   * scritture, non ciò che si può vedere.
   */
  offline: false,

  /** Voci in coda, per la schermata di inserimento. Vedi outbox.list(). */
  pending: [],

  /**
   * Unico punto da cui passa un inserimento, e unico punto in cui si decide
   * se scrivere o accodare.
   *
   * La validazione avviene SEMPRE qui, prima del fork: un importo o un mese
   * sbagliato devono fallire col telefono in mano, non al flush di tre ore
   * dopo. È anche ciò che fissa ULID e createdAt al momento giusto.
   */
  async addTransaction(input) {
    const tx = makeTransaction(input);

    // Avvio senza rete: non c'è nessuno store con cui scrivere.
    if (!app.store) return queueTransaction(tx);

    try {
      const year = yearOf(tx.month);
      if (year !== app.store.year) {
        await app.store.ensureMeta(year);
        await app.store.loadYear(year);
        app.year = year;
      }
      const saved = await app.store.addTransaction(tx);
      render();
      return saved;
    } catch (err) {
      // Rete caduta a metà: è il caso più frequente (parcheggio, metro,
      // ascensore). Prima finiva in un messaggio d'errore e nella spesa da
      // ridigitare.
      if (err.kind === KIND.NETWORK) return queueTransaction(tx);
      throw err;
    }
  },

  /** Ridisegna dopo una modifica fatta altrove (entrate, canoni). */
  refresh() { render(); },

  /**
   * Cambia l'anno caricato. Non lo CREA: sfogliare indietro non deve
   * lasciare cartelle vuote su GitHub. L'anno nuovo nasce solo quando ci si
   * inserisce davvero una spesa (vedi addTransaction).
   * @returns {Promise<boolean>} false se quell'anno non esiste
   */
  async setYear(year) {
    if (!app.store || year === app.store.year) return true;
    const previous = app.year;
    try {
      const found = await app.store.loadYearIfExists(year);
      if (!found) {
        await app.store.loadYear(previous); // ripristina lo stato precedente
        toast(`Nessun dato per il ${year}`);
        return false;
      }
      app.year = year;
      render();
      return true;
    } catch (err) {
      toast(humanError(err), 'ko');
      return false;
    }
  },
};

// --- Guscio -----------------------------------------------------------------

const title = el('h1', {}, [
  el('span', { text: 'Prj' }),
  el('span', { class: 'accent', text: 'Spesa' }),
]);
const gearBtn = el('button', {
  class: 'icon-btn', type: 'button', 'aria-label': 'Impostazioni',
  html: uiIcon('gear'),
  onclick: () => settings.open(),
});

const topbar = el('header', { class: 'topbar' }, [
  el('div', { class: 'brand' }, [
    // L'icona vera, non una riproduzione: marchio e icona non possono divergere.
    el('img', { class: 'brand-mark', src: './icons/icon-192.png', alt: '', width: '30', height: '30' }),
    title,
  ]),
  gearBtn,
]);

// Una barra sola per due stati, perché sono la stessa domanda ("le mie spese
// sono al sicuro?") e devono avere lo stesso posto sullo schermo.
// Usare l'app senza rete è raro: senza un segnale sempre visibile, una coda
// ferma resterebbe invisibile proprio perché non ci si pensa.
const statusbar = el('div', { class: 'statusbar', hidden: true, role: 'status' });

const main = el('div', { class: 'screen-host', id: 'host' });
const tabbar = el('nav', { class: 'tabbar' }, TABS.map((tab) => el('button', {
  class: 'tab', type: 'button', role: 'tab', dataset: { tab: tab.id },
  'aria-selected': String(tab.id === app.tab),
  onclick: () => setTab(tab.id),
}, [
  el('span', { html: uiIcon(tab.icon) }),
  el('span', { text: tab.label }),
])));

const shell = el('div', { class: 'app' }, [topbar, statusbar, main, tabbar]);
document.body.replaceChildren(shell);

// --- Schermate ---------------------------------------------------------------

const entry = createEntryScreen(app);
const summary = createSummaryScreen(app);
const movements = createMovementsScreen(app);
const income = createIncomeScreen(app);
const settings = createSettingsSheet(app);
document.body.append(settings.node);

const screens = {
  entry: entry.node,
  income: income.node,
  summary: summary.node,
  movements: movements.node,
};

function setTab(id) {
  // Senza dati non c'è niente da mostrare fuori dall'inserimento.
  if (app.offline && id !== 'entry') return;
  app.tab = id;
  for (const tab of tabbar.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === id));
  }
  render();
}

function render() {
  // La griglia si disegna SEMPRE, anche senza store: offline le categorie
  // vengono dai seed spediti con l'app. Le altre tre leggono dati remoti e
  // senza store non hanno nulla da dire.
  entry.render();
  if (app.store) {
    income.render();
    summary.render();
    movements.render();
  }
  renderStatusbar();

  // Solo se la schermata è cambiata davvero. `clear(main)` stacca dal DOM il
  // nodo che contiene il foglio di inserimento, e un <dialog> aperto non
  // sopravvive a un distacco: un flush innescato dal ritorno della rete mentre
  // si sta digitando lo chiuderebbe sotto le dita.
  if (main.firstChild !== screens[app.tab]) clear(main).append(screens[app.tab]);
}

/** Aggiorna la barra di stato. Due messaggi, un solo posto. */
function renderStatusbar() {
  const waiting = app.pending.length;
  if (app.offline) {
    statusbar.className = 'statusbar off';
    statusbar.textContent = waiting
      ? `Senza rete · ${waiting} ${waiting === 1 ? 'spesa' : 'spese'} in attesa, partono da sole`
      : 'Senza rete · le spese restano qui e partono da sole';
  } else if (waiting) {
    statusbar.className = 'statusbar wait';
    statusbar.textContent = `${waiting} ${waiting === 1 ? 'spesa' : 'spese'} in attesa di sincronizzazione`;
  }
  statusbar.hidden = !app.offline && !waiting;
}

/**
 * Entra o esce dalla modalità ridotta. Le tre schermate che leggono dati
 * remoti si spengono, e con loro l'ingranaggio: in Impostazioni non c'è nulla
 * che funzioni senza rete, e "Dimentica questo dispositivo" cancellerebbe la
 * coda.
 */
function setOffline(flag) {
  app.offline = flag;
  for (const tab of tabbar.querySelectorAll('.tab')) {
    const off = flag && tab.dataset.tab !== 'entry';
    tab.disabled = off;
    tab.setAttribute('aria-disabled', String(off));
  }
  gearBtn.disabled = flag;
}

// --- Avvio -------------------------------------------------------------------

async function boot() {
  const repo = localStorage.getItem(LS_REPO);
  const token = localStorage.getItem(LS_TOKEN);
  const stored = await loadKey().catch(() => null);

  const setup = createSetupScreen({
    onReady: async ({ client, key, salt }) => {
      Object.assign(session, { client, key, salt });
      await start();
    },
  });

  // Manca qualcosa → setup. Se mancano solo chiave o token si riparte dal
  // punto giusto invece di rifare tutto (F4.22).
  //
  // Il setup richiede la rete — test di connessione e keyring — quindi un
  // dispositivo mai configurato non si configura in modalità aereo. È un
  // limite dichiarato, non un caso da gestire.
  if (!repo || !token) {
    tabbar.hidden = true;
    gearBtn.hidden = true;
    clear(main).append(setup.node);
    setup.renderStep1();
    return;
  }

  session.client = GitHubClient.fromSlug(repo, token);

  if (!stored?.key) {
    tabbar.hidden = true;
    gearBtn.hidden = true;
    clear(main).append(setup.node);
    setup.renderRelock(session.client);
    return;
  }

  session.key = stored.key;
  session.salt = stored.salt;
  await refreshPending();
  await start();
}

async function start() {
  tabbar.hidden = false;
  gearBtn.hidden = false;
  clear(main).append(el('div', { class: 'empty-state', text: 'Carico l\'anno…' }));

  const store = new Store({ client: session.client, key: session.key, salt: session.salt });
  try {
    await store.ensureMeta(app.year);
    await store.loadYear(app.year);
  } catch (err) {
    // Senza rete si entra in modalità ridotta invece di mostrare un errore:
    // inserire una spesa non richiede nessun dato remoto. Ogni ALTRO errore
    // (token revocato, repo sbagliato, file corrotto) resta un errore, perché
    // proseguire lo nasconderebbe.
    if (err.kind === KIND.NETWORK) {
      app.store = null;
      setOffline(true);
      app.tab = 'entry';
      render();
      return;
    }
    app.store = null;
    clear(main).append(el('div', { class: 'empty-state', text: humanError(err) }));
    return;
  }

  app.store = store;
  setOffline(false);
  setTab('entry');
  await flushQueue();
}

// --- Coda offline ------------------------------------------------------------

/** Accoda e restituisce la transazione marcata, così il chiamante sa cosa dire. */
async function queueTransaction(tx) {
  await enqueue(tx, session.key, session.salt);
  await refreshPending();
  render();
  return { ...tx, queued: true };
}

async function refreshPending() {
  app.pending = session.key ? await listQueue(session.key, session.salt).catch(() => []) : [];
}

/** Toglie una voce dalla coda prima che parta. È l'unico modo di correggerla. */
app.discardPending = async (seq) => {
  await removeQueued(seq);
  await refreshPending();
  render();
};

async function flushQueue() {
  if (!app.store || !session.key) return;
  if (!(await countQueue())) return; // niente in coda: nessun rumore

  const result = await flush(app.store, session.key, session.salt);
  await refreshPending();
  render();

  if (result.skipped) return;
  if (result.written) {
    toast(`${result.written} ${result.written === 1 ? 'spesa sincronizzata' : 'spese sincronizzate'}`);
  }
  if (result.error) toast(humanError(result.error), 'ko');
}

// Tre trigger, perché nessuno da solo è affidabile: `online` su iOS non arriva
// sempre, e l'app viene riaperta più spesso di quanto cambi stato la rete.
//
// `navigator.onLine` NON è la fonte di verità — è `true` anche su una rete
// captive senza uscita — ma quando è `false` è quasi sempre giusto, e serve a
// non tentare a vuoto. La verità resta il fallimento della fetch.
let reconnecting = false;
async function reconnect() {
  if (reconnecting || !session.key || navigator.onLine === false) return;
  reconnecting = true;
  try {
    if (app.offline) await start(); // start() flusha da sé, in coda al carico
    else await flushQueue();
  } catch (err) {
    console.warn('Riconnessione non riuscita:', err.message);
  } finally {
    reconnecting = false;
  }
}

window.addEventListener('online', reconnect);
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnect(); });

// Qualunque errore non gestito deve diventare visibile: su iPhone non c'è
// una console da aprire, e un'app che non reagisce al tocco senza dire
// perché è impossibile da diagnosticare a distanza.
function surfaceError(prefix, error) {
  console.error(prefix, error);
  const detail = error?.message ?? String(error);
  toast(`${prefix}: ${detail}`, 'ko');
  const bar = document.querySelector('.errorbar') ?? el('div', { class: 'errorbar' });
  bar.textContent = `${prefix}: ${detail}`;
  bar.onclick = () => bar.remove();
  document.body.append(bar);
}

window.addEventListener('error', (event) => surfaceError('Errore', event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => surfaceError('Errore', event.reason));

// --- Service worker ---------------------------------------------------------
// La versione finisce nella query: cambiandola cambia l'URL del worker, quindi
// il browser si accorge dell'aggiornamento senza affidarsi alla sua euristica.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`).then((registration) => {
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        // Un controller già attivo significa che non è la prima installazione:
        // c'è davvero una versione nuova pronta.
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Nuova versione disponibile: ricarica');
        }
      });
    });
  }).catch((err) => console.warn('Service worker non registrato:', err.message));
}

document.documentElement.dataset.appVersion = APP_VERSION;
boot().catch((err) => {
  surfaceError('Avvio fallito', err);
  clear(main).append(el('div', { class: 'empty-state', text: humanError(err) }));
});
