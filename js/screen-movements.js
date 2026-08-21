// Schermata 3 — Movimenti: elenco, correzione, cancellazione, export.

import { el, clear, formatEur, toast, humanError, iconButton } from './ui.js';
import { uiIcon, categoryIcon } from './icons.js';
import { createKeypad, keypadValue, keypadDisplay } from './keypad.js';
import { MONTH_NAMES_IT, monthsOfYear, currentMonth, monthLabel, yearOf, sumAmounts } from './model.js';
import { downloadWorkbook } from './export-xlsx.js';

export function createMovementsScreen(app) {
  let month = currentMonth();
  let query = '';

  const periodLabel = el('button', { class: 'period-label', type: 'button' });
  const list = el('div', { class: 'movements' });
  const totalLine = el('div', { class: 'movements-total' });
  const editor = createEditor(app, () => render());

  const header = el('div', { class: 'period' }, [
    el('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'Mese precedente',
      html: uiIcon('chevronLeft'), onclick: () => go(-1),
    }),
    periodLabel,
    el('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'Mese successivo',
      html: uiIcon('chevronRight'), onclick: () => go(1),
    }),
  ]);

  // Una casella sola per categoria e dettaglio: cercando "caffè" non si sa —
  // e non interessa — in quale dei due campi la parola si trovi.
  const searchInput = el('input', {
    class: 'field search-input', type: 'text',
    placeholder: 'Cerca categoria o dettaglio',
    'aria-label': 'Cerca fra i movimenti del mese',
    // `search` mette "Cerca" al posto di "A capo" sulla tastiera di iOS.
    enterkeyhint: 'search',
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false',
  });

  const clearBtn = el('button', {
    class: 'icon-btn search-clear', type: 'button', hidden: true,
    'aria-label': 'Annulla la ricerca',
    html: uiIcon('close'), onclick: () => setQuery(''),
  });

  const searchBar = el('div', { class: 'searchbar' }, [
    el('span', { class: 'search-ico', html: uiIcon('search') }),
    searchInput,
    clearBtn,
  ]);

  searchInput.addEventListener('input', () => {
    // Cancellare tutto è l'altro modo di uscire dalla ricerca, oltre alla ×,
    // quindi passa dalla stessa strada — blur compreso: senza, la tastiera di
    // sistema resterebbe aperta a coprire mezzo elenco proprio mentre
    // l'elenco torna completo.
    if (!searchInput.value) { setQuery(''); return; }
    query = searchInput.value;
    render();
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setQuery('');
    else if (event.key === 'Enter') searchInput.blur();
  });

  function setQuery(value) {
    query = value;
    searchInput.value = value;
    if (!value) searchInput.blur();
    render();
  }

  const exportBtn = iconButton(uiIcon('download'), 'Esporta Excel', {
    class: 'btn',
    onclick: () => {
      if (!app.store) return;
      try {
        downloadWorkbook(app.store.transactions, app.store.meta, app.store.year);
        toast(`Spese_${app.store.year}.xlsx generato`);
      } catch (err) {
        toast(humanError(err), 'ko');
      }
    },
  });

  const node = el('section', { class: 'screen' }, [
    header, searchBar, totalLine, list,
    el('div', { class: 'export-zone' }, [exportBtn]),
    editor.node,
  ]);

  async function go(delta) {
    const index = Number(month.slice(5, 7)) - 1 + delta;
    const year = yearOf(month) + Math.floor(index / 12);
    const next = `${year}-${String(((index % 12) + 12) % 12 + 1).padStart(2, '0')}`;
    if (year !== app.store?.year && !(await app.setYear(year))) return;
    month = next;
    render();
  }

  function render() {
    periodLabel.textContent = `${monthLabel(month)} ${yearOf(month)}`;
    clear(list);
    clear(totalLine);
    clearBtn.hidden = !query;

    if (!app.store) return;

    if (yearOf(month) !== app.store.year) {
      searchBar.hidden = true;
      list.append(el('div', { class: 'empty-state', text: `Il ${yearOf(month)} non è caricato.` }));
      return;
    }

    const all = app.store.transactionsOf(month);
    const labelOf = new Map(app.store.meta.categories.map((c) => [c.id, c.label]));
    const tokens = searchTokens(query);
    const rows = tokens.length ? all.filter((tx) => matchesSearch(tx, tokens, labelOf)) : all;

    // Su un mese vuoto la casella non serve a niente: sparisce, a meno che non
    // sia proprio lei ad aver svuotato l'elenco.
    searchBar.hidden = !all.length && !tokens.length;

    totalLine.append(
      el('span', {
        text: tokens.length
          ? `${rows.length} ${rows.length === 1 ? 'risultato' : 'risultati'}`
          : `${rows.length} ${rows.length === 1 ? 'movimento' : 'movimenti'}`,
      }),
      el('span', { class: 'num', text: formatEur(sumAmounts(rows.map((t) => t.amount))) }),
    );

    if (!rows.length) {
      list.append(el('div', {
        class: 'empty-state',
        text: tokens.length
          ? `Nessun movimento per "${query.trim()}" in questo mese.`
          : 'Nessun movimento in questo mese.',
      }));
      return;
    }

    // Dal più recente: l'errore da correggere è quasi sempre l'ultimo inserito.
    for (const tx of [...rows].reverse()) {
      list.append(el('button', {
        class: 'mov', type: 'button', onclick: () => editor.open(tx),
      }, [
        el('span', { class: 'cat-ico', html: categoryIcon(tx.category) }),
        el('span', { class: 'mov-main' }, [
          el('span', { class: 'mov-title', text: tx.detail || labelOf.get(tx.category) || tx.category }),
          el('span', { class: 'mov-sub', text: [labelOf.get(tx.category), tx.note].filter(Boolean).join(' · ') }),
        ]),
        el('span', { class: 'mov-amount num', text: formatEur(tx.amount) }),
      ]));
    }
  }

  return { node, render };
}

// --- Ricerca ----------------------------------------------------------------

/**
 * Minuscole e senza accenti: "caffè" si digita "caffe" quasi sempre, e una
 * ricerca che non trova "Caffè" perché manca l'accento sembra un guasto.
 */
const normalize = (value) => (value ?? '')
  .toString()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '');

/** Parole, non stringa unica: così "pizza sabato" trova anche "sabato pizza". */
export const searchTokens = (query) => normalize(query).split(/\s+/).filter(Boolean);

/**
 * Vero se la transazione contiene TUTTE le parole cercate, indifferentemente
 * nella categoria o nel dettaglio: chi cerca non pensa per campi.
 */
export function matchesSearch(tx, tokens, labelOf) {
  const haystack = normalize(`${labelOf.get(tx.category) ?? tx.category ?? ''} ${tx.detail ?? ''}`);
  return tokens.every((token) => haystack.includes(token));
}

// --- Editor -----------------------------------------------------------------

function createEditor(app, onChanged) {
  let current = null;
  let month = currentMonth();
  let category = null;
  let saving = false;

  const dialog = el('dialog', { class: 'sheet' });

  const headIcon = el('span', { class: 'chip' });
  const headName = el('span', { class: 'name' });
  const amountValue = el('span', { class: 'val num' });
  const amountBox = el('div', { class: 'amount num' }, [
    el('span', { class: 'cur', text: '€' }),
    amountValue,
    el('span', { class: 'caret' }),
  ]);
  const errorLine = el('div', { class: 'amount-err' });

  const catSelect = el('select', { class: 'field' });
  catSelect.addEventListener('change', () => {
    category = app.store.meta.categories.find((c) => c.id === catSelect.value);
    headIcon.innerHTML = categoryIcon(category.id);
    headName.textContent = category.label;
  });

  const monthSelect = el('select', { class: 'field' });
  monthSelect.addEventListener('change', () => { month = monthSelect.value; });

  const detailField = el('input', { class: 'field', type: 'text', placeholder: 'Dettaglio' });
  const noteField = el('input', { class: 'field', type: 'text', placeholder: 'Nota / evento' });

  const keypad = createKeypad({
    confirmLabel: 'Salva',
    onChange: (state) => {
      amountValue.textContent = keypadDisplay(state);
      amountBox.classList.toggle('empty', state === '');
      errorLine.textContent = '';
      keypad.syncConfirm();
    },
    onConfirm: () => save(),
  });

  const deleteBtn = iconButton(uiIcon('trash'), 'Elimina', {
    class: 'btn ghost danger',
    onclick: () => remove(),
  });

  const inner = el('div', { class: 'sheet-inner' }, [
    el('div', { class: 'grabber' }),
    el('div', { class: 'sheet-head' }, [
      headIcon, headName,
      el('button', {
        class: 'icon-btn close', type: 'button', 'aria-label': 'Chiudi',
        html: uiIcon('close'), onclick: () => dialog.close(),
      }),
    ]),
    // Qui dentro sta tutto ciò che può cedere se il foglio non entra nello
    // schermo. Tastierino, Salva ed Elimina restano fuori: non devono
    // spostarsi mai (F4.13).
    el('div', { class: 'sheet-scroll' }, [
      amountBox,
      errorLine,
      el('div', { class: 'panel' }, [catSelect, monthSelect, detailField, noteField]),
    ]),
    keypad.node,
    deleteBtn,
  ]);
  dialog.append(inner);
  keypad.attachHardwareKeyboard(dialog);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  // Quanto schermo si prende la tastiera di sistema (serve solo per dettaglio
  // e nota). Il CSS lo usa per alzare il foglio E per togliergli altezza:
  // alzarlo e basta lo faceva uscire dal bordo superiore.
  if (window.visualViewport) {
    const reflow = () => {
      if (!dialog.open) return;
      const overlap = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
      inner.style.setProperty('--kb', overlap > 20 ? `${Math.round(overlap)}px` : '0px');
    };
    window.visualViewport.addEventListener('resize', reflow);
    window.visualViewport.addEventListener('scroll', reflow);
  }

  function open(tx) {
    current = tx;
    saving = false;
    month = tx.month;
    category = app.store.meta.categories.find((c) => c.id === tx.category) ?? { id: tx.category, label: tx.category };

    headIcon.innerHTML = categoryIcon(category.id);
    headName.textContent = category.label;

    clear(catSelect).append(...app.store.meta.categories.map((c) => el('option', {
      value: c.id, text: c.label, selected: c.id === category.id,
    })));
    clear(monthSelect).append(...monthsOfYear(app.store.year).map((m) => el('option', {
      value: m, text: `${MONTH_NAMES_IT[Number(m.slice(5, 7)) - 1]} ${app.store.year}`, selected: m === tx.month,
    })));

    detailField.value = tx.detail ?? '';
    noteField.value = tx.note ?? '';
    errorLine.textContent = '';
    inner.style.setProperty('--kb', '0px');

    // Precarica l'importo esistente: si corregge quasi sempre quello.
    keypad.set(tx.amount);

    dialog.showModal();
  }

  async function save() {
    if (saving) return;
    const amount = keypadValue(keypad.get());
    if (amount == null) { errorLine.textContent = 'Inserisci un importo'; return; }

    saving = true;
    keypad.setBusy(true);
    try {
      await app.store.updateTransaction(current.id, {
        amount, month, category: category.id,
        detail: detailField.value, note: noteField.value,
      });
      dialog.close();
      app.refresh();
      onChanged();
      toast('Movimento aggiornato');
    } catch (err) {
      errorLine.textContent = humanError(err);
    } finally {
      saving = false;
      keypad.setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Eliminare "${current.detail || category.label}" da ${formatEur(current.amount)}?`)) return;
    try {
      await app.store.deleteTransaction(current.id);
      dialog.close();
      app.refresh();
      onChanged();
      toast('Movimento eliminato');
    } catch (err) {
      errorLine.textContent = humanError(err);
    }
  }

  return { node: dialog, open };
}
