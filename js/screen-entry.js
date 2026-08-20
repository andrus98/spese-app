// Schermata 1 — griglia delle categorie e foglio di inserimento.

import { el, clear, formatEur, toast, humanError } from './ui.js';
import { categoryIcon, uiIcon } from './icons.js';
import { createKeypad, keypadValue, keypadDisplay } from './keypad.js';
import { MONTH_NAMES_IT, currentMonth, monthsOfYear, sumAmounts } from './model.js';
import { SEED_CATEGORIES } from './config.js';
import { createRecurringSheet } from './recurring.js';

// Ordine FISSO (F4.9): la posizione deve diventare memoria muscolare, quindi
// la griglia non si riordina mai da sola. Scelto una volta sulla frequenza
// reale gen-apr: le prime cinque coprono il 75% degli inserimenti.
const TILE_ORDER = [
  'svago', 'pasti_fuori', 'viaggi', 'tabacchi',
  'benzina', 'alimenti', 'shopping', 'caffe',
  'investimenti', 'manutenzione_mazda_sh', 'palestra', 'bollette',
  'spese_mediche', 'barbiere', 'casa', 'altro',
  'spotify', 'dazn', 'vodafone',
];

export function createEntryScreen(app) {
  const grid = el('div', { class: 'cat-grid' });
  const queue = el('div', { class: 'queue' });
  const node = el('section', { class: 'screen', id: 'screen-entry' }, [grid, queue]);
  const sheet = createSheet(app);
  const recurring = createRecurringSheet(app);
  node.append(sheet.node, recurring.node);

  function render() {
    // Senza store le categorie vengono dai seed spediti con l'app. Non è un
    // ripiego: syncCategoryLabels stabilisce che le etichette dell'app battono
    // quelle salvate, quindi la griglia offline è identica a quella online.
    const categories = app.store?.meta?.categories ?? SEED_CATEGORIES;
    const byId = new Map(categories.map((c) => [c.id, c]));

    // TILE_ORDER dà l'ordine; eventuali categorie aggiunte dopo finiscono in coda.
    const ordered = [
      ...TILE_ORDER.filter((id) => byId.has(id)).map((id) => byId.get(id)),
      ...categories.filter((c) => !TILE_ORDER.includes(c.id)),
    ];

    clear(grid);
    for (const category of ordered) {
      grid.append(el('button', {
        class: 'cat-tile', type: 'button', 'aria-label': category.label,
        onclick: () => sheet.open(category),
      }, [
        el('span', { class: 'ico', html: categoryIcon(category.id) }),
        el('span', { class: 'label', text: category.label }),
      ]));
    }

    // Ventesima tessera: non registra una spesa, apre i canoni ricorrenti.
    // Riempie lo slot che restava vuoto e li mette dove si pensa alle spese.
    // Senza store non ha nulla da leggere né dove scrivere: si spegne.
    grid.append(el('button', {
      class: 'cat-tile special', type: 'button', 'aria-label': 'Canoni ricorrenti',
      disabled: !app.store,
      onclick: () => recurring.open(),
    }, [
      el('span', { class: 'ico', html: categoryIcon('canoni') }),
      el('span', { class: 'label', text: 'Canoni' }),
    ]));

    renderQueue();
  }

  /**
   * Le spese non ancora sincronizzate. Senza questo elenco si sono digitate
   * tre spese senza avere NESSUN modo di sapere se ci sono ancora — ed è anche
   * l'unico posto in cui correggerne una prima che parta: si cancella e si
   * reinserisce. La modifica vera di una voce in coda non vale il codice che
   * costerebbe.
   */
  function renderQueue() {
    clear(queue);
    const waiting = app.pending ?? [];
    if (!waiting.length) return;

    const labelOf = new Map((app.store?.meta?.categories ?? SEED_CATEGORIES)
      .map((c) => [c.id, c.label]));

    queue.append(el('div', { class: 'queue-title', text: 'In attesa di rete' }));
    for (const item of waiting) {
      const discard = el('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Elimina dalla coda',
        html: uiIcon('trash'),
        onclick: () => app.discardPending?.(item.seq),
      });

      if (item.unreadable) {
        // Non si scarta in silenzio: si mostra e si lascia cancellare a mano.
        queue.append(el('div', { class: 'queue-row bad' }, [
          el('span', { class: 'queue-cat', text: 'Voce illeggibile' }),
          el('span', { class: 'queue-detail', text: 'cifrata con un\'altra chiave' }),
          discard,
        ]));
        continue;
      }

      queue.append(el('div', { class: 'queue-row' }, [
        el('span', { class: 'ico', html: categoryIcon(item.tx.category) }),
        el('span', { class: 'queue-cat', text: labelOf.get(item.tx.category) ?? item.tx.category }),
        el('span', { class: 'queue-detail', text: item.tx.detail || '' }),
        el('span', { class: 'queue-amount num', text: formatEur(item.tx.amount) }),
        discard,
      ]));
    }
  }

  return { node, render };
}

// --------------------------------------------------------------------------

function createSheet(app) {
  let category = null;
  let month = currentMonth();
  let saving = false;

  const dialog = el('dialog', { class: 'sheet' });

  const headIcon = el('span', { class: 'chip' });
  const headName = el('span', { class: 'name' });

  const amountValue = el('span', { class: 'val num' });
  const amountBox = el('div', { class: 'amount empty num' }, [
    el('span', { class: 'cur', text: '€' }),
    amountValue,
    el('span', { class: 'caret' }),
  ]);
  const amountError = el('div', { class: 'amount-err' });

  // --- riga "mese e anno" ---
  const monthValue = el('span', { class: 'val' });
  const monthPanel = el('div', { class: 'panel', hidden: true });
  const monthToggle = el('button', {
    class: 'toggle-row', type: 'button', 'aria-expanded': 'false',
    onclick: () => togglePanel(monthToggle, monthPanel),
  }, [
    el('span', { html: uiIcon('calendar') }),
    el('span', { text: 'Mese' }),
    monthValue,
  ]);

  // --- riga "note" ---
  const detailField = el('input', { class: 'field', type: 'text', placeholder: 'Dettaglio (es. pranzo)', enterkeyhint: 'done' });
  const noteField = el('input', { class: 'field', type: 'text', placeholder: 'Nota / evento (es. Ovindoli)', list: 'note-suggestions', enterkeyhint: 'done' });
  const noteList = el('datalist', { id: 'note-suggestions' });
  const notePanel = el('div', { class: 'panel', hidden: true }, [detailField, noteField, noteList]);
  const noteToggle = el('button', {
    class: 'toggle-row', type: 'button', 'aria-expanded': 'false',
    onclick: () => togglePanel(noteToggle, notePanel),
  }, [
    el('span', { html: uiIcon('tag') }),
    el('span', { text: 'Dettaglio e nota' }),
    el('span', { class: 'val', text: 'facoltativi' }),
  ]);

  const keypad = createKeypad({
    onChange: (state) => {
      amountValue.textContent = keypadDisplay(state);
      amountBox.classList.toggle('empty', state === '');
      amountError.textContent = '';
      keypad.syncConfirm();
    },
    onConfirm: () => save(),
  });

  const inner = el('div', { class: 'sheet-inner' }, [
    el('div', { class: 'grabber' }),
    el('div', { class: 'sheet-head' }, [
      headIcon, headName,
      el('button', {
        class: 'icon-btn close', type: 'button', 'aria-label': 'Chiudi',
        html: uiIcon('close'), onclick: () => close(),
      }),
    ]),
    // Qui dentro sta tutto ciò che può cedere se il foglio non entra nello
    // schermo — con i due pannelli aperti succede già su un SE. Il tastierino
    // resta fuori: non deve spostarsi mai (F4.13).
    el('div', { class: 'sheet-scroll' }, [
      amountBox,
      amountError,
      monthToggle, monthPanel,
      noteToggle, notePanel,
    ]),
    keypad.node,
  ]);
  dialog.append(inner);
  keypad.attachHardwareKeyboard(dialog);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });

  // Toccare sopra il pannello chiude: il fondale è il dialog stesso, quindi
  // basta distinguere un click su di lui da uno sul contenuto.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  // Su iOS la tastiera di sistema (serve solo per dettaglio e nota) restringe
  // il visual viewport senza che gli elementi fixed se ne accorgano: senza
  // questo, i campi finirebbero sotto la tastiera. Il CSS usa --kb per alzare
  // il foglio E per togliergli altezza: alzarlo e basta, com'era prima con un
  // translate, lo faceva uscire dal bordo superiore.
  if (window.visualViewport) {
    const reflow = () => {
      if (!dialog.open) return;
      const overlap = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
      inner.style.setProperty('--kb', overlap > 20 ? `${Math.round(overlap)}px` : '0px');
    };
    window.visualViewport.addEventListener('resize', reflow);
    window.visualViewport.addEventListener('scroll', reflow);
  }

  function togglePanel(toggle, panel) {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    panel.hidden = open;
  }

  function renderMonthPanel() {
    clear(monthPanel);
    const thisYear = new Date().getFullYear();
    const years = [...new Set([thisYear - 1, thisYear, app.year])].sort();
    const selectedYear = Number(month.slice(0, 4));

    monthPanel.append(el('div', { class: 'chips' }, years.map((year) => el('button', {
      class: 'chip-btn', type: 'button', text: String(year),
      'aria-pressed': String(year === selectedYear),
      onclick: () => { setMonth(`${year}-${month.slice(5)}`); },
    }))));

    monthPanel.append(el('div', { class: 'chips' }, monthsOfYear(selectedYear).map((m, i) => el('button', {
      class: 'chip-btn', type: 'button', text: MONTH_NAMES_IT[i].slice(0, 3),
      'aria-pressed': String(m === month),
      onclick: () => { setMonth(m); },
    }))));
  }

  function setMonth(next) {
    month = next;
    const [year, mm] = next.split('-');
    const label = `${MONTH_NAMES_IT[Number(mm) - 1]} ${year}`;
    monthValue.textContent = next === currentMonth() ? `${label} · oggi` : label;
    renderMonthPanel();
  }

  function open(selected) {
    category = selected;
    saving = false;
    headIcon.innerHTML = categoryIcon(selected.id);
    headName.textContent = selected.label;

    keypad.reset();
    detailField.value = '';
    noteField.value = '';
    amountError.textContent = '';
    monthToggle.setAttribute('aria-expanded', 'false');
    noteToggle.setAttribute('aria-expanded', 'false');
    monthPanel.hidden = true;
    notePanel.hidden = true;
    inner.style.setProperty('--kb', '0px');

    setMonth(currentMonth());

    clear(noteList);
    for (const suggestion of app.store?.meta?.noteSuggestions ?? []) {
      noteList.append(el('option', { value: suggestion }));
    }

    dialog.showModal();
    keypad.setBusy(false);
  }

  function close() {
    dialog.close();
  }

  async function save() {
    if (saving) return;
    const amount = keypadValue(keypad.get());
    if (amount == null) { amountError.textContent = 'Inserisci un importo'; return; }

    saving = true;
    keypad.setBusy(true);
    try {
      const saved = await app.addTransaction({
        month,
        category: category.id,
        detail: detailField.value,
        note: noteField.value,
        amount,
      });
      close();
      // Una spesa accodata NON è una spesa salvata su GitHub: dirlo con lo
      // stesso messaggio sarebbe una bugia, e chi non se ne accorge esporta
      // dal Mac un Excel a cui manca.
      toast(saved?.queued
        ? `${category.label} · ${formatEur(amount)} · in attesa di rete`
        : `${category.label} · ${formatEur(amount)}`);
    } catch (err) {
      amountError.textContent = humanError(err);
      toast(humanError(err), 'ko');
    } finally {
      saving = false;
      keypad.setBusy(false);
    }
  }

  return { node: dialog, open };
}

/** Totale del mese, ricorrenti inclusi (D3) — usato nell'header. */
export function monthTotal(store, month) {
  if (!store) return 0;
  const fromTransactions = sumAmounts(store.transactionsOf(month).map((t) => t.amount));
  const fromRecurring = sumAmounts(
    (store.meta?.recurring ?? [])
      .filter((r) => String(r.from) <= month && (r.to == null || month <= String(r.to)))
      .map((r) => r.amount),
  );
  return sumAmounts([fromTransactions, fromRecurring]);
}
