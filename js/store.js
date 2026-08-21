// Stato dell'anno in memoria e scritture verso GitHub.
//
// L'anno è l'unità logica: dashboard, KPI ed export lavorano sempre
// sull'anno intero. Il mese è solo il file che contiene la transazione.

import { encryptJSON, decryptEnvelope } from './crypto.js';
import { isNotFound, isConflict } from './github.js';
import { KIND, ValidationError } from './errors.js';
import {
  makeTransaction, makeCategory, monthsOfYear, yearOf, dedupeById, sortTransactions,
  emptyMonthFile, emptyMeta, validateMonthFile, validateMeta, normalizeText,
  syncShippedCategories,
} from './model.js';
import { metaPath, monthPath, yearDir, DATA_ROOT, SEED_CATEGORIES } from './config.js';

const MAX_WRITE_ATTEMPTS = 3;
const clone = (obj) => JSON.parse(JSON.stringify(obj));

/**
 * Inserisce una transazione solo se quell'id non c'è già.
 *
 * Rende la scrittura idempotente, che è ciò che permette di riprovare una voce
 * della coda offline senza rischi. Il caso non è teorico e non richiede due
 * dispositivi: la PUT arriva a GitHub e la risposta si perde: la voce resta in
 * coda e al tentativo successivo verrebbe scritta due volte, con lo STESSO id.
 */
const pushOnce = (file, tx) => {
  if (!file.transactions.some((t) => t.id === tx.id)) file.transactions.push(tx);
};

export class Store {
  #years = null;

  /**
   * @param {object} opts
   * @param {import('./github.js').GitHubClient} opts.client
   * @param {CryptoKey} opts.key
   * @param {Uint8Array} opts.salt salt globale del keyring
   */
  constructor({ client, key, salt }) {
    this.client = client;
    this.key = key;
    this.salt = salt;
    this.year = null;
    this.meta = null;
    this.metaSha = null;
    /** @type {Map<string, {file: object, sha: string|null}>} */
    this.months = new Map();
  }

  // --- Lettura --------------------------------------------------------------

  /**
   * Quali mesi esistono davvero. Chiedere l'elenco costa una richiesta e ne
   * risparmia fino a undici: senza, ogni avvio spara dodici GET di cui la
   * gran parte torna 404, che è corretto ma riempie la console di errori che
   * sembrano guasti e non lo sono.
   */
  async #existingMonths(year) {
    try {
      const entries = await this.client.listDir(yearDir(year));
      return new Set(entries
        .filter((e) => e.type === 'file' && /^\d{4}-\d{2}\.json$/.test(e.name))
        .map((e) => e.name.replace('.json', '')));
    } catch (err) {
      if (isNotFound(err)) return new Set(); // anno non ancora creato
      throw err;
    }
  }

  /** Carica meta + i mesi esistenti in parallelo. Gli altri valgono vuoti. */
  async loadYear(year) {
    const months = monthsOfYear(year);
    const existing = await this.#existingMonths(year);
    const [meta, ...files] = await Promise.all([
      this.#readMeta(year),
      ...months.map((m) => (existing.has(m)
        ? this.#readMonth(m)
        : Promise.resolve({ file: emptyMonthFile(m), sha: null }))),
    ]);

    this.year = Number(year);
    this.meta = meta.file;
    this.metaSha = meta.sha;
    this.months = new Map(months.map((m, i) => [m, files[i]]));

    return { meta: this.meta, transactions: this.transactions };
  }

  /** Tutte le transazioni dell'anno, deduplicate e ordinate. */
  get transactions() {
    const all = [];
    for (const { file } of this.months.values()) all.push(...file.transactions);
    return sortTransactions(dedupeById(all));
  }

  /**
   * Deduplica come il getter `transactions`: un replay della coda offline può
   * riscrivere una transazione già presente (PUT arrivata, risposta persa), e
   * questa è la lista che alimenta i Movimenti e il totale del mese. Senza
   * dedupe il doppione si vedrebbe e raddoppierebbe il totale.
   */
  transactionsOf(month) {
    return sortTransactions(dedupeById(this.months.get(month)?.file.transactions ?? []));
  }

  find(id) {
    return this.transactions.find((t) => t.id === id) ?? null;
  }

  async #readMonth(month) {
    try {
      const { data, sha } = await this.client.getJSON(monthPath(month));
      const file = validateMonthFile(await decryptEnvelope(data, this.key, this.salt), month);
      return { file, sha };
    } catch (err) {
      // Un mese non ancora creato è la normalità, non un errore.
      if (isNotFound(err)) return { file: emptyMonthFile(month), sha: null };
      throw err;
    }
  }

  async #readMeta(year) {
    try {
      const { data, sha } = await this.client.getJSON(metaPath(year));
      const file = validateMeta(await decryptEnvelope(data, this.key, this.salt), year);
      // Etichette e visibilità seguono l'app, non il file: vedi
      // syncShippedCategories.
      file.categories = syncShippedCategories(file.categories);
      return { file, sha };
    } catch (err) {
      if (isNotFound(err)) return { file: null, sha: null }; // lo crea ensureMeta
      throw err;
    }
  }

  // --- Scrittura ------------------------------------------------------------

  /**
   * Applica `mutate` al file del mese e lo salva.
   *
   * In caso di conflitto NON riapplica la modifica sul contenuto vecchio:
   * ricarica il file, decifra, riapplica sul contenuto fresco e ritenta.
   * Riapplicare sul vecchio cancellerebbe la scrittura dell'altro dispositivo.
   *
   * Il 422 è trattato come un conflitto: succede quando due dispositivi
   * creano lo stesso mese insieme e il secondo invia una PUT senza sha su un
   * file che nel frattempo esiste.
   */
  async #writeMonth(month, mutate) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
      const entry = this.months.get(month) ?? await this.#readMonth(month);
      const next = clone(entry.file);
      mutate(next);
      next.updatedAt = new Date().toISOString();

      try {
        const envelope = await encryptJSON(next, this.key, this.salt);
        const { sha } = await this.client.putFile(
          monthPath(month),
          JSON.stringify(envelope, null, 2),
          { sha: entry.sha, message: `sync ${month}` },
        );
        this.months.set(month, { file: next, sha });
        return next;
      } catch (err) {
        const recoverable = isConflict(err) || err.kind === KIND.UNPROCESSABLE;
        if (!recoverable || attempt === MAX_WRITE_ATTEMPTS) throw err;
        lastError = err;
        this.months.set(month, await this.#readMonth(month)); // ricarica fresco
      }
    }
    throw lastError;
  }

  async #writeMeta(mutate) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
      const next = clone(this.meta);
      mutate(next);
      next.updatedAt = new Date().toISOString();

      try {
        const envelope = await encryptJSON(next, this.key, this.salt);
        const { sha } = await this.client.putFile(
          metaPath(next.year),
          JSON.stringify(envelope, null, 2),
          { sha: this.metaSha, message: `sync meta ${next.year}` },
        );
        this.meta = next;
        this.metaSha = sha;
        return next;
      } catch (err) {
        const recoverable = isConflict(err) || err.kind === KIND.UNPROCESSABLE;
        if (!recoverable || attempt === MAX_WRITE_ATTEMPTS) throw err;
        lastError = err;
        const fresh = await this.#readMeta(next.year);
        this.meta = fresh.file;
        this.metaSha = fresh.sha;
      }
    }
    throw lastError;
  }

  // --- Operazioni sulle transazioni -----------------------------------------

  /**
   * Un anno chiuso è in sola lettura (F8.3). Il flag vive in meta.json, non
   * in localStorage: deve valere su tutti i dispositivi, non solo su quello
   * dove è stato messo.
   */
  #assertWritable() {
    if (this.meta?.locked) {
      throw new ValidationError(
        `Il ${this.year} è chiuso in sola lettura. Sbloccalo dalle impostazioni per correggerlo.`,
      );
    }
  }

  /** @returns {Promise<object>} la transazione creata */
  async addTransaction(input) {
    this.#assertWritable();
    const tx = makeTransaction(input);
    this.#assertYearLoaded(tx.month);
    await this.#writeMonth(tx.month, (file) => { pushOnce(file, tx); });
    await this.#rememberNotes([tx.note]);
    return tx;
  }

  /**
   * Inserimento in blocco, usato dal flush della coda offline.
   *
   * Raggruppa per mese e scrive UNA volta per mese, invece di una volta per
   * transazione: otto spese inserite senza rete diventano un commit, non otto.
   * `github.js` serializza già le PUT, ma il limite secondario di GitHub sulle
   * scritture è un rischio reale (F2.12), e ogni PUT è comunque un commit.
   *
   * Anche i suggerimenti nota si scrivono una volta sola alla fine: altrimenti
   * ogni transazione porterebbe con sé una SECONDA scrittura su meta.json.
   *
   * Se la scrittura di un mese fallisce, i mesi già scritti restano scritti e
   * l'errore si propaga. Il chiamante non deve svuotare la coda: al tentativo
   * successivo i mesi già andati a buon fine si riscrivono senza duplicare,
   * perché `pushOnce` ignora gli id già presenti.
   *
   * @param {object[]} inputs transazioni da validare e scrivere
   * @returns {Promise<object[]>} le transazioni validate
   */
  async addTransactions(inputs) {
    this.#assertWritable();
    const txs = inputs.map((input) => makeTransaction(input));

    const byMonth = new Map();
    for (const tx of txs) {
      this.#assertYearLoaded(tx.month);
      if (!byMonth.has(tx.month)) byMonth.set(tx.month, []);
      byMonth.get(tx.month).push(tx);
    }

    for (const [month, group] of [...byMonth].sort(([a], [b]) => (a < b ? -1 : 1))) {
      await this.#writeMonth(month, (file) => {
        for (const tx of group) pushOnce(file, tx);
      });
    }

    await this.#rememberNotes(txs.map((tx) => tx.note));
    return txs;
  }

  /**
   * Modifica una transazione. Se cambia il mese, la sposta: prima la scrive
   * sulla destinazione, poi la toglie dall'origine. Se la seconda scrittura
   * fallisce resta un duplicato — visibile e correggibile — invece di una
   * perdita silenziosa.
   */
  async updateTransaction(id, changes) {
    this.#assertWritable();
    const current = this.find(id);
    if (!current) throw new ValidationError(`Transazione ${id} non trovata`);

    const updated = makeTransaction({
      ...current,
      ...changes,
      id: current.id,
      createdAt: current.createdAt,
    });

    if (updated.month === current.month) {
      await this.#writeMonth(updated.month, (file) => {
        const i = file.transactions.findIndex((t) => t.id === id);
        if (i === -1) file.transactions.push(updated);
        else file.transactions[i] = updated;
      });
    } else {
      this.#assertYearLoaded(updated.month);
      await this.#writeMonth(updated.month, (file) => {
        if (!file.transactions.some((t) => t.id === id)) file.transactions.push(updated);
      });
      await this.#writeMonth(current.month, (file) => {
        file.transactions = file.transactions.filter((t) => t.id !== id);
      });
    }

    await this.#rememberNotes([updated.note]);
    return updated;
  }

  /** Cancellazione fisica (D12): la history di git è il meccanismo di recupero. */
  async deleteTransaction(id) {
    this.#assertWritable();
    const current = this.find(id);
    if (!current) throw new ValidationError(`Transazione ${id} non trovata`);
    await this.#writeMonth(current.month, (file) => {
      file.transactions = file.transactions.filter((t) => t.id !== id);
    });
    return current;
  }

  #assertYearLoaded(month) {
    if (this.year != null && yearOf(month) !== this.year) {
      throw new ValidationError(
        `Il mese ${month} non appartiene all'anno ${this.year} caricato. Cambia anno prima di scrivere.`,
      );
    }
  }

  /**
   * Aggiunge le note ai suggerimenti (D4). È una SECONDA scrittura, con il suo
   * sha e il suo conflitto: se fallisce non deve far fallire l'inserimento
   * delle spese, che è già andato a buon fine.
   *
   * Accetta una lista perché il flush della coda ne ha molte in una volta: una
   * scrittura sola invece di una per transazione.
   */
  async #rememberNotes(notes) {
    if (!this.meta) return;
    const known = new Set(this.meta.noteSuggestions ?? []);
    const fresh = [...new Set(notes.map(normalizeText).filter(Boolean))]
      .filter((note) => !known.has(note));
    if (!fresh.length) return;
    try {
      await this.#writeMeta((meta) => {
        meta.noteSuggestions = [...new Set([...(meta.noteSuggestions ?? []), ...fresh])];
      });
    } catch (err) {
      console.warn('Suggerimenti nota non salvati (le spese sono comunque salvate):', err.message);
    }
  }

  // --- Entrate e ricorrenti -------------------------------------------------

  /** Entrate manuali, 4 voci × 12 mesi (D6). Importo 0 o vuoto = voce rimossa. */
  async setIncome(month, source, amount) {
    this.#assertWritable();
    return this.#writeMeta((meta) => {
      const entries = (meta.income ?? []).filter((e) => !(e.month === month && e.source === source));
      if (amount != null && amount !== '' && Number(amount) !== 0) {
        entries.push({ month, source, amount: Number(amount) });
      }
      meta.income = entries;
    });
  }

  async setRecurring(recurring) {
    this.#assertWritable();
    return this.#writeMeta((meta) => { meta.recurring = recurring; });
  }

  /**
   * Crea una categoria e la salva in meta.json.
   *
   * Vale per l'anno caricato e solo per quello: le categorie si ereditano al
   * rollover del 1° gennaio (ensureMeta), quindi una creata a dicembre 2026 si
   * ritrova nel 2027 senza doverla rifare, mentre gli anni già chiusi restano
   * come sono — ed è giusto: una categoria che nel 2025 non esisteva non deve
   * comparire nel suo Excel.
   *
   * @param {string} label come la scrive l'utente
   * @returns {Promise<object>} la categoria creata, con il suo id
   */
  async addCategory(label) {
    this.#assertWritable();
    const category = makeCategory(label, this.meta?.categories ?? []);
    await this.#writeMeta((meta) => {
      // `mutate` viene rieseguito sul meta FRESCO dopo un 409: se nel
      // frattempo l'altro dispositivo ha creato la stessa categoria, qui non
      // se ne aggiunge una seconda con lo stesso id.
      const list = meta.categories ?? [];
      meta.categories = list.some((c) => c.id === category.id) ? list : [...list, category];
    });
    return category;
  }

  /** Chiude o riapre l'anno. Non passa da #assertWritable, ovviamente. */
  async setLocked(locked) {
    return this.#writeMeta((meta) => { meta.locked = locked || undefined; });
  }

  // --- Import (fase 3) ------------------------------------------------------

  /**
   * Sostituisce l'intero contenuto di un mese. Usato dalla migrazione una
   * tantum: passa dallo stesso percorso di cifratura e dalla stessa gestione
   * dei conflitti delle scritture normali.
   */
  async importMonth(incoming) {
    this.#assertWritable();
    validateMonthFile(incoming, incoming.month);
    this.#assertYearLoaded(incoming.month);
    return this.#writeMonth(incoming.month, (file) => {
      file.transactions = incoming.transactions;
    });
  }

  /** Sostituisce meta.json (categorie, ricorrenti, entrate, suggerimenti). */
  async importMeta(incoming) {
    this.#assertWritable();
    validateMeta(incoming, this.year);
    return this.#writeMeta((meta) => {
      meta.categories = incoming.categories;
      meta.recurring = incoming.recurring ?? [];
      meta.income = incoming.income ?? [];
      meta.noteSuggestions = incoming.noteSuggestions ?? [];
    });
  }

  /**
   * Carica un anno SENZA crearlo. Sfogliare gli anni indietro non deve
   * lasciare cartelle vuote su GitHub: la creazione avviene solo quando si
   * inserisce davvero una spesa (ensureMeta).
   * @returns {Promise<boolean>} false se quell'anno non esiste
   */
  async loadYearIfExists(year) {
    // Si chiede prima quali anni esistono, invece di tentare la lettura e
    // incassare un 404: e' corretto ma riempie la console di errori che
    // sembrano guasti. L'elenco si tiene in cache, cambia solo quando
    // nasce un anno nuovo.
    const years = await this.availableYears();
    if (!years.includes(Number(year))) return false;
    await this.loadYear(year);
    return true;
  }

  /** Anni presenti nel repo, in cache. */
  async availableYears() {
    if (!this.#years) this.#years = await this.client.listYears(DATA_ROOT);
    return this.#years;
  }

  /** Da chiamare quando nasce un anno nuovo. */
  forgetYearList() { this.#years = null; }

  // --- Creazione lazy di anno e meta (F8.2) ---------------------------------

  /**
   * Garantisce che meta.json dell'anno esista. Se manca, lo crea copiando
   * categorie e canoni ancora attivi dall'anno precedente; se non c'è nemmeno
   * quello, parte dalle 19 categorie del master.
   *
   * È il rollover del 1° gennaio: non serve nessuna azione manuale, l'anno
   * nuovo nasce alla prima transazione.
   */
  async ensureMeta(year) {
    if (this.meta && Number(this.meta.year) === Number(year)) return this.meta;

    const existing = await this.#readMeta(year);
    if (existing.file) {
      this.meta = existing.file;
      this.metaSha = existing.sha;
      this.year = Number(year);
      return this.meta;
    }

    const previous = await this.#readMeta(Number(year) - 1);
    const categories = previous.file?.categories ?? clone(SEED_CATEGORIES);
    const carried = (previous.file?.recurring ?? [])
      .filter((r) => r.to == null)
      .map((r) => ({ ...r, from: `${year}-01` }));

    const meta = emptyMeta(year, categories);
    meta.recurring = carried;
    meta.noteSuggestions = previous.file?.noteSuggestions ?? [];

    this.meta = meta;
    this.metaSha = null;
    this.year = Number(year);
    await this.#writeMeta(() => {});
    this.forgetYearList(); // e' nato un anno: l'elenco in cache non vale piu
    return this.meta;
  }
}
