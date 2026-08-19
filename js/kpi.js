// KPI. Funzioni pure su (transactions, meta): nessun DOM, così i numeri si
// verificano da soli.
//
// Regola di composizione (D3), valida OVUNQUE — dashboard ed export devono
// dare lo stesso risultato al centesimo:
//
//   cella[categoria, mese] = canone ricorrente attivo nel mese
//                          + somma delle transazioni della categoria nel mese
//
// Il canone SI SOMMA, non sostituisce. È ciò che rende rappresentabile
// Palestra: spese sporadiche fino ad aprile, canone fisso da maggio.

import {
  sumAmounts, recurringFor, monthsOfYear, daysElapsedInMonth, assertMonth,
} from './model.js';

const cat = (meta) => meta?.categories ?? [];

// --- Spese ------------------------------------------------------------------

/** Somma delle sole transazioni, senza canoni. */
export function transactionsTotal(transactions, { month, category } = {}) {
  return sumAmounts(
    transactions
      .filter((t) => (month == null || t.month === month) && (category == null || t.category === category))
      .map((t) => t.amount),
  );
}

/** L'equivalente della cella del master: transazioni + canone. */
export function categoryMonth(transactions, meta, category, month) {
  return sumAmounts([
    transactionsTotal(transactions, { month, category }),
    recurringFor(meta, category, month),
  ]);
}

/** Riga TOTALE del master, per un mese. */
export function monthTotal(transactions, meta, month) {
  return sumAmounts(cat(meta).map((c) => categoryMonth(transactions, meta, c.id, month)));
}

/** Colonna TOTALE ANNO del master, per una categoria. */
export function categoryYear(transactions, meta, category, year) {
  return sumAmounts(monthsOfYear(year).map((m) => categoryMonth(transactions, meta, category, m)));
}

export function yearTotal(transactions, meta, year) {
  return sumAmounts(monthsOfYear(year).map((m) => monthTotal(transactions, meta, m)));
}

/** Tutte le categorie di un mese, ordinate per importo decrescente. */
export function breakdown(transactions, meta, month) {
  const total = monthTotal(transactions, meta, month);
  return cat(meta)
    .map((c) => {
      const amount = categoryMonth(transactions, meta, c.id, month);
      return {
        id: c.id,
        label: c.label,
        amount,
        share: total > 0 ? amount / total : 0,
        recurring: recurringFor(meta, c.id, month),
      };
    })
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

// --- Entrate e risparmio ----------------------------------------------------

export function incomeMonth(meta, month) {
  return sumAmounts((meta?.income ?? []).filter((e) => e.month === month).map((e) => Number(e.amount) || 0));
}

export function incomeYear(meta, year) {
  return sumAmounts(monthsOfYear(year).map((m) => incomeMonth(meta, m)));
}

/** Riga Risparmio del master: entrate − spese. Può essere negativo. */
export function savings(transactions, meta, month) {
  return sumAmounts([incomeMonth(meta, month), -monthTotal(transactions, meta, month)]);
}

export function savingsYear(transactions, meta, year) {
  return sumAmounts([incomeYear(meta, year), -yearTotal(transactions, meta, year)]);
}

/** Quota di risparmio. null se non ci sono entrate: 0% sarebbe una bugia. */
export function savingsRate(transactions, meta, month) {
  const income = incomeMonth(meta, month);
  if (income <= 0) return null;
  return savings(transactions, meta, month) / income;
}

// --- Confronti e proiezioni -------------------------------------------------

export function previousMonth(month) {
  const year = Number(assertMonth(month).slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 1
    ? `${year - 1}-12`
    : `${year}-${String(index - 1).padStart(2, '0')}`;
}

/**
 * Variazione rispetto al mese precedente.
 * @returns {{delta: number, ratio: number|null}} ratio null se il mese
 *   precedente era a zero: una variazione percentuale su zero non esiste.
 */
export function monthOverMonth(transactions, meta, month) {
  const now = monthTotal(transactions, meta, month);
  const before = monthTotal(transactions, meta, previousMonth(month));
  return {
    delta: sumAmounts([now, -before]),
    ratio: before > 0 ? (now - before) / before : null,
  };
}

/** Mesi con almeno una transazione, oppure conclusi: quelli su cui si può mediare. */
function elapsedMonths(transactions, year, now = new Date()) {
  return monthsOfYear(year).filter((m) => {
    const index = Number(m.slice(5, 7)) - 1;
    const concluded = now.getFullYear() > year || (now.getFullYear() === year && now.getMonth() > index);
    return concluded || transactions.some((t) => t.month === m);
  });
}

/**
 * Proiezione a fine anno. Calcolata sui mesi CONCLUSI: includere il mese in
 * corso, che è per definizione incompleto, sottostima sistematicamente.
 * @returns {number|null} null se nessun mese è ancora concluso
 */
export function runRate(transactions, meta, year, now = new Date()) {
  const concluded = monthsOfYear(year).filter((m) => {
    const index = Number(m.slice(5, 7)) - 1;
    return now.getFullYear() > year || (now.getFullYear() === year && now.getMonth() > index);
  });
  if (concluded.length === 0) return null;
  const spent = sumAmounts(concluded.map((m) => monthTotal(transactions, meta, m)));
  return Math.round((spent / concluded.length) * 12 * 100) / 100;
}

/** Media mensile per categoria, sui mesi trascorsi. */
export function monthlyAverage(transactions, meta, category, year, now = new Date()) {
  const months = elapsedMonths(transactions, year, now);
  if (months.length === 0) return 0;
  const total = sumAmounts(months.map((m) => categoryMonth(transactions, meta, category, m)));
  return Math.round((total / months.length) * 100) / 100;
}

/**
 * Spesa media giornaliera. Usa i giorni TRASCORSI del mese, non il giorno
 * delle singole transazioni — che sotto D11 non esiste.
 */
export function dailyAverage(transactions, meta, month, now = new Date()) {
  const days = daysElapsedInMonth(month, now);
  if (days === 0) return 0;
  return Math.round((monthTotal(transactions, meta, month) / days) * 100) / 100;
}

// --- Dettaglio --------------------------------------------------------------

/**
 * Le spese più grandi del mese. Solo TRANSAZIONI: un canone ricorrente non è
 * una spesa che hai fatto, e comparirebbe ogni mese in cima falsando la lista.
 */
export function topExpenses(transactions, month, limit = 5) {
  return transactions
    .filter((t) => t.month === month)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

/** Totale per nota/evento: quanto è costato "Ovindoli" (D4). */
export function byNote(transactions, { year } = {}) {
  const totals = new Map();
  for (const tx of transactions) {
    if (!tx.note) continue;
    if (year != null && Number(tx.month.slice(0, 4)) !== Number(year)) continue;
    const current = totals.get(tx.note) ?? { note: tx.note, amount: 0, count: 0 };
    current.amount = sumAmounts([current.amount, tx.amount]);
    current.count += 1;
    totals.set(tx.note, current);
  }
  return [...totals.values()].sort((a, b) => b.amount - a.amount);
}

/** Tutto quello che serve alla schermata, in una passata. */
export function summarize(transactions, meta, month, now = new Date()) {
  const year = Number(assertMonth(month).slice(0, 4));
  return {
    month,
    year,
    spese: monthTotal(transactions, meta, month),
    entrate: incomeMonth(meta, month),
    risparmio: savings(transactions, meta, month),
    tassoRisparmio: savingsRate(transactions, meta, month),
    variazione: monthOverMonth(transactions, meta, month),
    mediaGiornaliera: dailyAverage(transactions, meta, month, now),
    speseAnno: yearTotal(transactions, meta, year),
    entrateAnno: incomeYear(meta, year),
    risparmioAnno: savingsYear(transactions, meta, year),
    proiezione: runRate(transactions, meta, year, now),
    categorie: breakdown(transactions, meta, month),
    top: topExpenses(transactions, month),
    eventi: byNote(transactions, { year }),
  };
}
