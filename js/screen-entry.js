// Schermata 1 — griglia delle categorie e foglio di inserimento.

import { el, clear, formatEur, toast, humanError } from './ui.js';
import { categoryIcon, uiIcon } from './icons.js';
import { createKeypad, keypadValue, keypadDisplay } from './keypad.js';
import { MONTH_NAMES_IT, currentMonth, monthsOfYear, sumAmounts } from './model.js';
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
  const node = el('section', { class: 'screen', id: 'screen-entry' }, [grid]);
  const sheet = createSheet(app);
  const recurring = createRecurringSheet(app);
  node.append(sheet.node, recurring.node);

  function render() {
    const categories = app.store?.meta?.categories ?? [];
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
    grid.append(el('button', {
      class: 'cat-tile special', type: 'button', 'aria-label': 'Canoni ricorrenti',
      onclick: () => recurring.open(),
    }, [
      el('span', { class: 'ico', html: categoryIcon('canoni') }),
      el('span', { class: 'label', text: 'Canoni' }),
    ]));
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
    amountBox,
    amountError,
    monthToggle, monthPanel,
    noteToggle, notePanel,
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
  // questo, i campi finirebbero sotto la tastiera.
  if (window.visualViewport) {
    const reflow = () => {
      if (!dialog.open) return;
      const overlap = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
      inner.style.transform = overlap > 20 ? `translateY(${-overlap}px)` : '';
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
    inner.style.transform = '';

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
      await app.addTransaction({
        month,
        category: category.id,
        detail: detailField.value,
        note: noteField.value,
        amount,
      });
      close();
      toast(`${category.label} · ${formatEur(amount)}`);
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
