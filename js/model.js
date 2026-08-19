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
 * Riallinea le etichette delle categorie a quelle dell'app.
 *
 * L'`id` è la chiave e non si tocca mai; la `label` è solo ciò che si legge a
 * schermo e finisce nell'Excel. Non esiste nessun punto dell'interfaccia in
 * cui rinominare una categoria, quindi un'etichetta memorizzata è sempre una
 * copia di quella spedita con l'app: se differisce, è perché l'app è stata
 * aggiornata, e sovrascriverla non calpesta nessuna scelta dell'utente.
 *
 * Le categorie che l'app non conosce restano intatte.
 */
export function syncCategoryLabels(categories) {
  const shipped = new Map(SEED_CATEGORIES.map((c) => [c.id, c.label]));
  return (categories ?? []).map((category) => (shipped.has(category.id)
    ? { ...category, label: shipped.get(category.id) }
    : category));
}

// --- Ricorrenti (D3) --------------------------------------------------------

/**
 * Canone attivo per una categoria in un mese. Il canone SI SOMMA alle
 * transazioni, non le sostituisce: è la regola che rende rappresentabile
 * Palestra (spese sporadiche fino ad aprile, canone fisso da maggio).
 * @returns {number} 0 se nessun canone attivo
 */
export function recurringFor(meta, categoryId, month) {
  assertMonth(month);
  const entries = meta?.recurring ?? [];
  return sumAmounts(
    entries
      .filter((r) => r.category === categoryId
        && String(r.from) <= month
        && (r.to == null || month <= String(r.to)))
      .map((r) => r.amount),
  );
}
