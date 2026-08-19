// Schermata 2 — Riepilogo. Gli stessi KPI del foglio master, per anno e mese.

import { el, clear, formatEur } from './ui.js';
import { uiIcon, categoryIcon } from './icons.js';
import { summarize, previousMonth, categoryMonth } from './kpi.js';
import { MONTH_NAMES_IT, currentMonth, monthLabel, yearOf } from './model.js';

const pct = (value) => `${(value * 100).toFixed(1).replace('.', ',')} %`;

export function createSummaryScreen(app) {
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
    const normalized = ((index % 12) + 12) % 12;
    const next = `${year}-${String(normalized + 1).padStart(2, '0')}`;

    // Attraversare dicembre/gennaio carica l'altro anno invece di mostrare
    // un vicolo cieco. Se quell'anno non esiste si resta dove si era.
    if (year !== app.store?.year && !(await app.setYear(year))) return;

    month = next;
    render();
  }

  function render() {
    periodLabel.textContent = `${monthLabel(month)} ${yearOf(month)}`;
    clear(body);

    if (!app.store) return;

    // L'anno caricato in memoria è uno solo: se si naviga fuori, meglio dirlo
    // che mostrare zeri che sembrerebbero dati veri.
    if (yearOf(month) !== app.store.year) {
      body.append(el('div', {
        class: 'empty-state',
        text: `Il ${yearOf(month)} non è caricato. Inserisci una spesa in quell'anno per aprirlo.`,
      }));
      return;
    }

    const k = summarize(app.store.transactions, app.store.meta, month);

    // --- Spese del mese, con variazione ---
    const variation = k.variazione.ratio == null
      ? `nessun dato per ${monthLabel(previousMonth(month))}`
      : `${k.variazione.delta >= 0 ? '+' : '−'}${formatEur(Math.abs(k.variazione.delta))} (${pct(Math.abs(k.variazione.ratio))}) vs ${monthLabel(previousMonth(month))}`;

    body.append(el('div', { class: 'card hero' }, [
      el('div', { class: 'card-label', text: 'Spese del mese' }),
      el('div', { class: 'card-value num', text: formatEur(k.spese) }),
      el('div', {
        class: `card-delta ${k.variazione.ratio == null ? '' : k.variazione.delta > 0 ? 'up' : 'down'}`.trim(),
        text: variation,
      }),
    ]));

    // Entrate, risparmio e investimenti. Gli investimenti sono una categoria
    // di spesa come le altre, ma sono l'unica che torna indietro: tenerli
    // accanto al risparmio dice quanto del mese e' stato messo da parte in
    // un modo o nell'altro.
    const investimenti = categoryMonth(app.store.transactions, app.store.meta, 'investimenti', month);
    body.append(el('div', { class: 'kpi-row three' }, [
      card('Entrate', formatEur(k.entrate)),
      card('Risparmio', formatEur(k.risparmio), k.risparmio >= 0 ? 'pos' : 'neg'),
      card('Investimenti', formatEur(investimenti)),
    ]));

    // --- Anno ---
    body.append(section('Anno ' + k.year, [
      line('Spese', formatEur(k.speseAnno)),
      line('Entrate', formatEur(k.entrateAnno)),
      line('Risparmio', formatEur(k.risparmioAnno), k.risparmioAnno >= 0 ? 'pos' : 'neg'),
    ]));

    // --- Dove vanno i soldi ---
    if (k.categorie.length) {
      body.append(section('Dove vanno i soldi', k.categorie.map((row) => el('div', { class: 'cat-row' }, [
        el('span', { class: 'cat-ico', html: categoryIcon(row.id) }),
        el('div', { class: 'cat-main' }, [
          el('div', { class: 'cat-top' }, [
            el('span', { text: row.label }),
            el('span', { class: 'num', text: formatEur(row.amount) }),
          ]),
          bar(row.share),
        ]),
      ]))));
    } else {
      body.append(el('div', { class: 'empty-state', text: 'Nessuna spesa in questo mese.' }));
    }

    // --- Top 5: solo transazioni, i canoni non sono spese fatte ---
    if (k.top.length) {
      body.append(section('Le più grandi', k.top.map((tx) => line(
        tx.detail || app.store.meta.categories.find((c) => c.id === tx.category)?.label || tx.category,
        formatEur(tx.amount),
      ))));
    }

    // --- Totale per evento (D4) ---
    if (k.eventi.length) {
      body.append(section(`Per evento · ${k.year}`, k.eventi.map((event) => line(
        `${event.note} · ${event.count} spes${event.count === 1 ? 'a' : 'e'}`,
        formatEur(event.amount),
      ))));
    }
  }

  return { node, render, setMonth: (m) => { month = m; render(); } };
}

// --- pezzi ------------------------------------------------------------------

const card = (label, value, tone = '') => el('div', { class: 'card' }, [
  el('div', { class: 'card-label', text: label }),
  el('div', { class: `card-value num ${tone}`.trim(), text: value }),
]);

const section = (title, rows) => el('div', { class: 'block' }, [
  el('div', { class: 'block-title', text: title }),
  el('div', { class: 'block-body' }, rows),
]);

const line = (label, value, tone = '') => el('div', { class: 'line' }, [
  el('span', { class: 'line-label', text: label }),
  el('span', { class: `line-value num ${tone}`.trim(), text: value }),
]);

function bar(share) {
  const fill = el('span', { class: 'bar-fill' });
  // setProperty e non un attributo style: il CSP vieta gli style inline in markup.
  fill.style.setProperty('width', `${Math.max(share * 100, 1.5)}%`);
  return el('span', { class: 'bar' }, [fill]);
}
