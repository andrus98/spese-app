// Canoni ricorrenti (D3), raggiungibili da una tessera della griglia.
//
// Stanno fra le categorie e non nelle impostazioni perché è lì che si pensa
// alle spese: un canone è una spesa che si ripete, non un'opzione.
//
// Regola, ricordata anche a schermo: il canone SI SOMMA alle transazioni
// della sua categoria, non le sostituisce.

import { el, clear, toast, humanError, formatEur } from './ui.js';
import { uiIcon, categoryIcon } from './icons.js';
import { parseAmount, isValidMonth, monthLabel } from './model.js';

// Valore sentinella della voce "+ Nuova categoria" nel menu a tendina. I doppi
// underscore lo tengono fuori dallo spazio degli id veri, che categoryIdFrom
// non genera mai con un underscore iniziale.
const NEW_CATEGORY = '__nuova__';

export function createRecurringSheet(app) {
  const body = el('div', { class: 'settings-body' });

  const dialog = el('dialog', { class: 'sheet full' }, [
    el('div', { class: 'sheet-full-inner' }, [
      el('div', { class: 'sheet-head' }, [
        el('span', { class: 'chip', html: categoryIcon('canoni') }),
        el('span', { class: 'name', text: 'Canoni ricorrenti' }),
        el('button', {
          class: 'icon-btn close', type: 'button', 'aria-label': 'Chiudi',
          html: uiIcon('close'), onclick: () => dialog.close(),
        }),
      ]),
      body,
    ]),
  ]);

  function render() {
    clear(body);
    if (!app.store?.meta) {
      body.append(el('div', { class: 'empty-state', text: 'Dati non ancora caricati.' }));
      return;
    }

    const categories = app.store.meta.categories;
    const list = app.store.meta.recurring ?? [];
    const labelOf = (id) => categories.find((c) => c.id === id)?.label ?? id;

    body.append(el('p', {
      class: 'hint',
      text: 'Un canone si somma alle spese della sua categoria, non le sostituisce: '
        + 'se in un mese fai anche una spesa extra della stessa categoria, si vedono entrambe.',
    }));

    // --- attivi ---
    if (list.length) {
      body.append(el('div', { class: 'block' }, [
        el('div', { class: 'block-title', text: `${list.length} attivi` }),
        el('div', { class: 'block-body stack' }, list.map((entry, index) => {
          const amountField = el('input', {
            class: 'field small', type: 'text', inputmode: 'decimal',
            value: String(entry.amount).replace('.', ','),
          });
          const toField = el('input', {
            class: 'field small', type: 'text', placeholder: 'attivo',
            value: entry.to ?? '',
          });

          const save = async () => {
            const to = toField.value.trim();
            if (to && !isValidMonth(to)) {
              toast('Il mese di fine va scritto come 2026-09', 'ko');
              toField.value = entry.to ?? '';
              return;
            }
            try {
              await app.store.setRecurring(app.store.meta.recurring.map((r, i) => (i === index ? {
                ...r, amount: parseAmount(amountField.value), to: to || null,
              } : r)));
              app.refresh();
              render();
              toast('Canone aggiornato');
            } catch (err) {
              toast(humanError(err), 'ko');
              render();
            }
          };
          amountField.addEventListener('blur', save);
          toField.addEventListener('blur', save);

          return el('div', { class: 'recurring-row' }, [
            el('div', { class: 'recurring-head' }, [
              el('span', { class: 'cat-ico', html: categoryIcon(entry.category) }),
              el('span', { text: labelOf(entry.category) }),
              el('span', { class: 'recurring-when', text: periodo(entry) }),
              el('button', {
                class: 'icon-btn', type: 'button',
                'aria-label': `Elimina il canone ${labelOf(entry.category)}`,
                html: uiIcon('trash'),
                onclick: async () => {
                  if (!confirm(`Eliminare il canone ${labelOf(entry.category)} da ${formatEur(entry.amount)}?`)) return;
                  try {
                    await app.store.setRecurring(app.store.meta.recurring.filter((_, i) => i !== index));
                    app.refresh();
                    render();
                    toast('Canone eliminato');
                  } catch (err) { toast(humanError(err), 'ko'); }
                },
              }),
            ]),
            el('div', { class: 'recurring-fields' }, [
              el('label', { class: 'inline-field' }, ['€ al mese', amountField]),
              el('label', { class: 'inline-field' }, ['fino a (vuoto = attivo)', toField]),
            ]),
          ]);
        })),
      ]));
    } else {
      body.append(el('div', { class: 'empty-state', text: 'Nessun canone attivo.' }));
    }

    // --- nuovo ---
    // L'ultima voce non è una categoria: apre il campo per crearne una. Sta
    // qui e non nella griglia perché è qui che serve — un canone di qualcosa
    // che le 19 del master non prevedono (un affitto, un'assicurazione) è il
    // solo motivo per cui finora mancava un posto dove aggiungerne.
    const catSelect = el('select', { class: 'field' }, [
      ...categories.map((c) => el('option', { value: c.id, text: c.label })),
      el('option', { value: NEW_CATEGORY, text: '+ Nuova categoria…' }),
    ]);
    const newCatName = el('input', {
      class: 'field', type: 'text', placeholder: 'Es. Affitto', enterkeyhint: 'done',
    });
    const newCatRow = el('label', { class: 'inline-field', hidden: true }, ['Nome', newCatName]);
    catSelect.addEventListener('change', () => {
      newCatRow.hidden = catSelect.value !== NEW_CATEGORY;
      if (!newCatRow.hidden) newCatName.focus();
    });

    const newAmount = el('input', { class: 'field small', type: 'text', inputmode: 'decimal', placeholder: '0,00' });
    const newFrom = el('input', { class: 'field small', type: 'text', value: `${app.store.year}-01` });

    body.append(el('div', { class: 'block' }, [
      el('div', { class: 'block-title', text: 'Aggiungi' }),
      el('div', { class: 'block-body stack' }, [
        el('label', { class: 'inline-field' }, ['Categoria', catSelect]),
        newCatRow,
        el('label', { class: 'inline-field' }, ['€ al mese', newAmount]),
        el('label', { class: 'inline-field' }, ['da', newFrom]),
        el('p', {
          class: 'hint',
          text: 'Una categoria creata qui vive nei totali e nell\'export come tutte '
            + 'le altre, ma non prende una tessera nella griglia della nuova spesa: '
            + 'quella deve entrare nello schermo senza scorrere.',
        }),
        el('button', {
          class: 'btn', type: 'button', text: 'Aggiungi canone',
          onclick: async () => {
            // Importo e mese si validano PRIMA di creare la categoria: un
            // typo sull'importo lascerebbe altrimenti una categoria nuova e
            // nessun canone, cioè esattamente il contrario di quanto chiesto.
            let amount;
            try {
              amount = parseAmount(newAmount.value);
            } catch (err) { toast(humanError(err), 'ko'); return; }

            if (!isValidMonth(newFrom.value.trim())) {
              toast('Il mese di inizio va scritto come 2026-09', 'ko');
              return;
            }

            try {
              let categoryId = catSelect.value;
              if (categoryId === NEW_CATEGORY) {
                // Due scritture su meta.json, non una: se la seconda fallisce
                // resta una categoria senza canone — visibile nell'elenco qui
                // sopra e riutilizzabile al tentativo successivo — invece di
                // un canone che punta a una categoria inesistente.
                categoryId = (await app.store.addCategory(newCatName.value)).id;
              }
              await app.store.setRecurring([...(app.store.meta.recurring ?? []), {
                category: categoryId,
                amount,
                from: newFrom.value.trim(),
                to: null,
              }]);
              app.refresh();
              render();
              toast('Canone aggiunto');
            } catch (err) { toast(humanError(err), 'ko'); }
          },
        }),
      ]),
    ]));
  }

  // Toccare sopra il pannello chiude, come per il foglio della nuova spesa.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  return { node: dialog, open: () => { render(); dialog.showModal(); } };
}

function periodo(entry) {
  const from = isValidMonth(entry.from) ? `da ${monthLabel(entry.from)} ${entry.from.slice(0, 4)}` : '';
  const to = entry.to && isValidMonth(entry.to)
    ? ` a ${monthLabel(entry.to)} ${entry.to.slice(0, 4)}`
    : '';
  return `${from}${to}`;
}
