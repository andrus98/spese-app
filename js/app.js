// Guscio dell'app: stato, router a tre schermate, avvio.

import { el, clear, toast, humanError } from './ui.js';
import { uiIcon } from './icons.js';
import { GitHubClient } from './github.js';
import { Store } from './store.js';
import { loadKey } from './crypto.js';
import { yearOf } from './model.js';
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

const app = {
  store: null,
  year: new Date().getFullYear(),
  tab: 'entry',

  /**
   * Aggiunge una spesa, caricando prima l'anno giusto se il mese scelto
   * appartiene a un altro anno (inserimento di arretrato a cavallo d'anno).
   */
  async addTransaction(input) {
    const year = yearOf(input.month);
    if (year !== app.store.year) {
      await app.store.ensureMeta(year);
      await app.store.loadYear(year);
      app.year = year;
    }
    const tx = await app.store.addTransaction(input);
    render();
    return tx;
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

const main = el('div', { class: 'screen-host', id: 'host' });
const tabbar = el('nav', { class: 'tabbar' }, TABS.map((tab) => el('button', {
  class: 'tab', type: 'button', role: 'tab', dataset: { tab: tab.id },
  'aria-selected': String(tab.id === app.tab),
  onclick: () => setTab(tab.id),
}, [
  el('span', { html: uiIcon(tab.icon) }),
  el('span', { text: tab.label }),
])));

const shell = el('div', { class: 'app' }, [topbar, main, tabbar]);
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
  app.tab = id;
  for (const tab of tabbar.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === id));
  }
  render();
}

function render() {
  if (app.store) {
    entry.render();
    income.render();
    summary.render();
    movements.render();
  }
  clear(main).append(screens[app.tab]);
}

// --- Avvio -------------------------------------------------------------------

async function boot() {
  const repo = localStorage.getItem(LS_REPO);
  const token = localStorage.getItem(LS_TOKEN);
  const stored = await loadKey().catch(() => null);

  const setup = createSetupScreen({
    onReady: async ({ client, key, salt }) => {
      await start(client, key, salt);
    },
  });

  // Manca qualcosa → setup. Se mancano solo chiave o token si riparte dal
  // punto giusto invece di rifare tutto (F4.22).
  if (!repo || !token) {
    tabbar.hidden = true;
    gearBtn.hidden = true;
    clear(main).append(setup.node);
    setup.renderStep1();
    return;
  }

  const client = GitHubClient.fromSlug(repo, token);

  if (!stored?.key) {
    tabbar.hidden = true;
    gearBtn.hidden = true;
    clear(main).append(setup.node);
    setup.renderRelock(client);
    return;
  }

  await start(client, stored.key, stored.salt);
}

async function start(client, key, salt) {
  tabbar.hidden = false;
  gearBtn.hidden = false;
  clear(main).append(el('div', { class: 'empty-state', text: 'Carico l\'anno…' }));

  app.store = new Store({ client, key, salt });
  try {
    await app.store.ensureMeta(app.year);
    await app.store.loadYear(app.year);
  } catch (err) {
    clear(main).append(el('div', { class: 'empty-state', text: humanError(err) }));
    return;
  }
  setTab('entry');
}

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
