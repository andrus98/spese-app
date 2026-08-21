// Modello dati e normalizzazione degli input.
//
// D11: l'unità temporale è il MESE. Nessuna transazione porta un giorno.
// `createdAt` è un campo di audit — quando la riga è stata inserita, non
// quando è avvenuta la spesa — e nessun KPI lo legge.

import { SCHEMA_VERSION, SEED_CATEGORIES } from './config.js';
import { ValidationError, FormatError } from './errors.js';
import { randomBytes } from './crypto.js';

// --- Testo ------------------------------------------------------------------

/**
 * Rimuove spazi non-breaking (residuo di copia-incolla da iPhone, anomalia G)
 * e normalizza gli spazi. Va applicata a ogni campo testuale in ingresso.
 */
export function normalizeText(value) {
  if (value == null) return '';
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- Importi (anomalia A) ---------------------------------------------------

/**
 * Unico punto di ingresso per gli importi: nessun altro percorso deve
 * scrivere `amount`. È la contromisura strutturale all'anomalia A dell'Excel,
 * dove cinque importi erano stringhe e sparivano silenziosamente dai totali.
 *
 * Accetta "12,50", "12.50", "€ 12,50", "20\u00a0", "1.234,56".
 * Un punto isolato è sempre decimale ("12.10" → 12.1), coerentemente con i
 * dati di origine.
 *
 * @returns {number} arrotondato a 2 decimali, sempre > 0
 * @throws {ValidationError}
 */
export function parseAmount(input) {
  if (typeof input === 'number') return validateAmountNumber(input, input);

  let s = String(input ?? '').replace(/[\u00a0\s]/g, '').replace(/€/g, '');
  if (s === '') throw new ValidationError('Importo mancante');

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    // Entrambi presenti: l'ultimo è il separatore decimale, l'altro le migliaia.
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    s = s.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma !== -1) {
    s = s.replace(',', '.');
  }

  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new ValidationError(`Importo non valido: "${input}"`);
  }
  return validateAmountNumber(Number(s), input);
}

function validateAmountNumber(n, original) {
  if (!Number.isFinite(n)) throw new ValidationError(`Importo non valido: "${original}"`);
  if (n <= 0) throw new ValidationError('L\'importo deve essere maggiore di zero');
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  if (rounded <= 0) throw new ValidationError('L\'importo arrotondato è zero');
  return rounded;
}

/** Somma in centesimi interi: evita l'accumulo di errore float su molte righe. */
export function sumAmounts(values) {
  const cents = values.reduce((acc, v) => acc + Math.round((v + Number.EPSILON) * 100), 0);
  return cents / 100;
}

// --- Mesi (D11) -------------------------------------------------------------

export const MONTH_NAMES_IT = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isValidMonth(month) {
  return MONTH_RE.test(String(month ?? ''));
}

export function assertMonth(month) {
  if (!isValidMonth(month)) throw new ValidationError(`Mese non valido: "${month}"`);
  return month;
}

/**
 * Mese corrente dalla data LOCALE, mai da toISOString(): alle 23:30 del
 * 31 dicembre a Roma, in UTC è già gennaio e il default sarebbe sbagliato.
 */
export function currentMonth(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export const yearOf = (month) => Number(assertMonth(month).slice(0, 4));
export const monthIndexOf = (month) => Number(assertMonth(month).slice(5, 7)) - 1;
export const monthLabel = (month) => MONTH_NAMES_IT[monthIndexOf(month)];

/** I 12 mesi di un anno, in ordine. */
export function monthsOfYear(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

/** Giorni trascorsi nel mese: serve alla media giornaliera senza usare i giorni delle transazioni. */
export function daysElapsedInMonth(month, now = new Date()) {
  const year = yearOf(month);
  const idx = monthIndexOf(month);
  const daysInMonth = new Date(year, idx + 1, 0).getDate();
  if (now.getFullYear() > year || (now.getFullYear() === year && now.getMonth() > idx)) {
    return daysInMonth; // mese concluso
  }
  if (now.getFullYear() < year || now.getMonth() < idx) return 0; // mese futuro
  return now.getDate();
}

// --- ULID -------------------------------------------------------------------

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const ULID_TIME_LEN = 10;
const ULID_RANDOM_LEN = 16;

/**
 * ULID: 48 bit di timestamp + 80 bit casuali, ordinabile lessicograficamente
 * per tempo. Ordinare gli id ordina le transazioni per inserimento, senza
 * dover leggere createdAt.
 */
export function ulid(now = Date.now()) {
  let time = '';
  let t = now;
  for (let i = 0; i < ULID_TIME_LEN; i++) {
    time = ULID_ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 256 / 32 = 8 esatto, quindi `& 31` su un byte casuale è uniforme.
  const bytes = randomBytes(ULID_RANDOM_LEN);
  let random = '';
  for (let i = 0; i < ULID_RANDOM_LEN; i++) random += ULID_ALPHABET[bytes[i] & 31];
  return time + random;
}

// --- Transazioni ------------------------------------------------------------

/**
 * Costruisce una transazione validata. Tutti gli input passano da qui:
 * dopo questa funzione i dati sono sempre nella forma giusta.
 */
export function makeTransaction({ month, category, detail, amount, note, id, createdAt }) {
  const tx = {
    id: id ?? ulid(),
    month: assertMonth(month),
    category: normalizeText(category),
    detail: normalizeText(detail),
    amount: parseAmount(amount),
    createdAt: createdAt ?? new Date().toISOString(),
  };
  if (!tx.category) throw new ValidationError('Categoria mancante');
  const cleanNote = normalizeText(note);
  if (cleanNote) tx.note = cleanNote;
  return tx;
}

/** Ordina per id (che è un ULID, quindi cronologico sull'inserimento). */
export function sortTransactions(transactions) {
  return [...transactions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Deduplica per id, tenendo il createdAt più recente. Serve dopo uno
 * spostamento fra mesi interrotto a metà (store.moveTransaction): il
 * duplicato è visibile e correggibile, la perdita silenziosa no.
 */
export function dedupeById(transactions) {
  const byId = new Map();
  for (const tx of transactions) {
    const existing = byId.get(tx.id);
    if (!existing || String(tx.createdAt) > String(existing.createdAt)) byId.set(tx.id, tx);
  }
  return [...byId.values()];
}

// --- File ------------------------------------------------------------------

export function emptyMonthFile(month) {
  return {
    schemaVersion: SCHEMA_VERSION,
    month: assertMonth(month),
    updatedAt: new Date().toISOString(),
    transactions: [],
  };
}

export function emptyMeta(year, categories) {
  return {
    schemaVersion: SCHEMA_VERSION,
    year: Number(year),
    updatedAt: new Date().toISOString(),
    categories,
    recurring: [],
    income: [],
    noteSuggestions: [],
  };
}

/** Verifica la forma di un file mensile letto da GitHub. */
export function validateMonthFile(data, expectedMonth) {
  if (!data || typeof data !== 'object') throw new FormatError('File mensile illeggibile');
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new FormatError(`schemaVersion ${data.schemaVersion} non supportata (attesa ${SCHEMA_VERSION})`);
  }
  if (expectedMonth && data.month !== expectedMonth) {
    throw new FormatError(`Il file dice mese ${data.month}, atteso ${expectedMonth}`);
  }
  if (!Array.isArray(data.transactions)) throw new FormatError('transactions mancante');
  return data;
}

export function validateMeta(data, expectedYear) {
  if (!data || typeof data !== 'object') throw new FormatError('meta.json illeggibile');
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new FormatError(`schemaVersion ${data.schemaVersion} non supportata (attesa ${SCHEMA_VERSION})`);
  }
  if (expectedYear && Number(data.year) !== Number(expectedYear)) {
    throw new FormatError(`meta.json dice anno ${data.year}, atteso ${expectedYear}`);
  }
  if (!Array.isArray(data.categories)) throw new FormatError('categories mancante');
  return data;
}

/**
 * Riallinea alle categorie spedite con l'app quelle salvate in `meta.json`.
 *
 * L'`id` è la chiave e non si tocca mai; `label` e `hidden` sono solo il modo
 * in cui l'app presenta quella chiave. Non esiste nessun punto
 * dell'interfaccia in cui rinominare una categoria o nasconderla, quindi ciò
 * che è memorizzato è sempre una copia di quanto spedito con l'app: se
 * differisce, è perché l'app è stata aggiornata, e sovrascriverlo non calpesta
 * nessuna scelta dell'utente. È anche il motivo per cui Spotify, Dazn e
 * Vodafone spariscono dalla griglia senza toccare i dati già su GitHub.
 *
 * Le categorie che l'app non conosce restano intatte, `hidden` compreso: sono
 * quelle create dai Canoni, e la loro visibilità è un dato loro.
 */
export function syncShippedCategories(categories) {
  const shipped = new Map(SEED_CATEGORIES.map((c) => [c.id, c]));
  return (categories ?? []).map((category) => {
    const source = shipped.get(category.id);
    if (!source) return category;
    // `undefined` e non `false`: JSON.stringify lo omette, quindi il file non
    // si riempie di flag spenti a ogni scrittura.
    return { ...category, label: source.label, hidden: source.hidden || undefined };
  });
}

// --- Categorie create dall'utente -------------------------------------------

/**
 * Id di una categoria nuova, ricavato dall'etichetta.
 *
 * F2.15 fissa a mano gli id delle 19 categorie del master proprio per non
 * derivarli da una label che potrebbe cambiare. Qui la derivazione è
 * inevitabile — l'etichetta è l'unica cosa che l'utente scrive — ma il rischio
 * di drift non c'è: l'id si calcola UNA volta, alla creazione, e da quel
 * momento vive in `meta.json` come tutti gli altri. Non esiste un punto in cui
 * si rinomina una categoria, quindi non esiste un punto in cui ricalcolarlo.
 */
export function categoryIdFrom(label) {
  const id = normalizeText(label)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // "Caffè" → "caffe"
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!id) throw new ValidationError(`Nome non utilizzabile: "${label}"`);
  return id;
}

/**
 * Costruisce una categoria nuova. Nasce `hidden`: non ha un'icona, e la
 * griglia della nuova spesa è dimensionata per entrare nello schermo senza
 * scorrere (F4.7). Vale ovunque altrove — canoni, totali, movimenti, export.
 *
 * @param {string} label come la scrive l'utente
 * @param {object[]} existing le categorie già in meta.json
 */
export function makeCategory(label, existing = []) {
  const clean = normalizeText(label);
  if (!clean) throw new ValidationError('Manca il nome della categoria');
  const id = categoryIdFrom(clean);
  const clash = existing.find((c) => c.id === id);
  if (clash) throw new ValidationError(`"${clash.label}" esiste già`);
  const order = existing.reduce((max, c) => Math.max(max, Number(c.order) || 0), 0) + 1;
  return { id, label: clean, order, hidden: true };
}

// --- Ricorrenti (D3) --------------------------------------------------------

/**
 * I canoni attivi in un mese. `from` e `to` sono mesi in formato `2026-01`,
 * quindi il confronto è fra stringhe ed è corretto: l'ordine lessicografico di
 * quel formato coincide con quello cronologico.
 */
export function activeRecurring(meta, month) {
  assertMonth(month);
  return (meta?.recurring ?? []).filter((r) => String(r.from) <= month
    && (r.to == null || month <= String(r.to)));
}

/**
 * Canone attivo per una categoria in un mese. Il canone SI SOMMA alle
 * transazioni, non le sostituisce: è la regola che rende rappresentabile
 * Palestra (spese sporadiche fino ad aprile, canone fisso da maggio).
 * @returns {number} 0 se nessun canone attivo
 */
export function recurringFor(meta, categoryId, month) {
  return sumAmounts(
    activeRecurring(meta, month)
      .filter((r) => r.category === categoryId)
      .map((r) => r.amount),
  );
}
