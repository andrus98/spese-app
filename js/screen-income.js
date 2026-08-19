// Schermata Entrate (D6): 4 voci × 12 mesi.
//
// Ha una schermata sua e non un angolo delle impostazioni perché il KPI
// "Risparmio" — entrate meno spese — dipende interamente da qui: se resta
// nascosto fra le opzioni, resta vuoto, e il risparmio diventa una bugia.

import { el, clear, formatEur, toast, humanError } from './ui.js';
import { uiIcon } from './icons.js';
import { parseAmount, currentMonth, monthLabel, monthsOfYear, yearOf, MONTH_NAMES_IT } from './model.js';
import { incomeMonth, incomeYear, monthTotal, savings } from './kpi.js';
import { INCOME_SOURCES } from './config.js';

export function createIncomeScreen(app) {
  let month = currentMonth();

  const periodLabel = el('button', { class: 'period-label', type: 'button' });
  const body = el('div', { class: 'summary-body' });

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

  const node = el('section', { class: 'screen' }, [header, body]);

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
    clear(body);
    if (!app.store?.meta) return;

    if (yearOf(month) !== app.store.year) month = `${app.store.year}-01`;

    const meta = app.store.meta;
    const entrate = incomeMonth(meta, month);
    const spese = monthTotal(app.store.transactions, meta, month);
    const risparmio = savings(app.store.transactions, meta, month);

    // Il mese in una riga: quanto entra, quanto esce, cosa resta.
    body.append(el('div', { class: 'card hero' }, [
      el('div', { class: 'card-label', text: 'Entrate del mese' }),
      el('div', { class: 'card-value num', text: formatEur(entrate) }),
      el('div', {
        class: 'card-delta',
        text: `${formatEur(spese)} di spese · ${risparmio >= 0 ? 'restano' : 'mancano'} ${formatEur(Math.abs(risparmio))}`,
      }),
    ]));

    // --- le quattro voci ---
    const rows = INCOME_SOURCES.map((source) => {
      const existing = (meta.income ?? []).find((e) => e.month === month && e.source === source.id);
      const field = el('input', {
        class: 'field small', type: 'text', inputmode: 'decimal',
        placeholder: '—',
        value: existing ? String(existing.amount).replace('.', ',') : '',
      });

      // Su blur e non a ogni tasto: ogni salvataggio è un commit su GitHub.
      field.addEventListener('blur', async () => {
        const raw = field.value.trim();
        const before = existing ? String(existing.amount).replace('.', ',') : '';
        if (raw === before) return;
        try {
          await app.store.setIncome(month, source.id, raw === '' ? 0 : parseAmount(raw));
          app.refresh();
          render();
          toast(raw === '' ? `${source.label} azzerata` : `${source.label}: ${formatEur(parseAmount(raw))}`);
        } catch (err) {
          toast(humanError(err), 'ko');
          field.value = before;
        }
      });

      return el('label', { class: 'inline-field' }, [source.label, field]);
    });

    body.append(el('div', { class: 'block' }, [
      el('div', { class: 'block-title', text: 'Voci del mese' }),
      el('div', { class: 'block-body stack' }, [
        el('p', { class: 'hint', text: 'Lascia vuoto ciò che non c\'è: uno zero scritto a mano e una casella vuota si assomigliano a schermo, ma solo il vuoto dice "non è successo".' }),
        ...rows,
      ]),
    ]));

    // --- l'anno intero, per vedere i buchi ---
    const months = monthsOfYear(app.store.year);
    body.append(el('div', { class: 'block' }, [
      el('div', { class: 'block-title', text: `Anno ${app.store.year} · ${formatEur(incomeYear(meta, app.store.year))}` }),
      el('div', { class: 'block-body' }, months.map((m, i) => {
        const value = incomeMonth(meta, m);
        return el('button', {
          class: `line as-button${m === month ? ' current' : ''}`,
          type: 'button',
          onclick: () => { month = m; render(); },
        }, [
          el('span', { class: 'line-label', text: MONTH_NAMES_IT[i] }),
          el('span', {
            class: `line-value num${value > 0 ? '' : ' muted'}`,
            text: value > 0 ? formatEur(value) : '—',
          }),
        ]);
      })),
    ]));
  }

  return { node, render };
}
