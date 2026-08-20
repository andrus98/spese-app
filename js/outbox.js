// Coda delle spese inserite senza rete (D19).
//
// Non è una cache dei dati: è un BUFFER DI SCRITTURA. Contiene solo ciò che
// non è ancora arrivato su GitHub, e si svuota appena la rete torna. I dati
// letti restano sempre e solo quelli remoti (D20).
//
// Una voce è un INTENTO, non un file già confezionato: la transazione, già
// passata da makeTransaction al momento dell'inserimento. Da qui tre
// proprietà su cui si regge tutto il resto:
//
// 1. La validazione avviene all'accodamento, col telefono in mano. Un importo
//    o un mese sbagliato falliscono subito, non tre ore dopo.
// 2. `id` (ULID) e `createdAt` sono fissati all'accodamento: il replay
//    riscrive la transazione IDENTICA, e l'ordinamento per ULID resta quello
//    di quando la spesa è stata inserita, non di quando è stata sincronizzata.
// 3. La fusione col Mac è gratis: al flush ogni voce ripassa da #writeMonth,
//    che il 409 lo gestisce già ricaricando il file fresco.
//
// Le voci sono cifrate con la stessa chiave dei dati (D21): la coda vive nello
// stesso IndexedDB della CryptoKey, e lasciare lì gli importi in chiaro
// sarebbe l'unico punto del progetto in cui i dati non sono cifrati a riposo.

import { encryptJSON, decryptEnvelope } from './crypto.js';
import { withStore } from './idb.js';
import { IDB_STORE_OUTBOX } from './config.js';
import { yearOf } from './model.js';

/**
 * Accoda una transazione già validata.
 * @returns {Promise<number>} il `seq` assegnato
 */
export async function enqueue(transaction, key, salt) {
  const envelope = await encryptJSON(transaction, key, salt);
  return withStore(IDB_STORE_OUTBOX, 'readwrite', (store) =>
    store.add({ enqueuedAt: new Date().toISOString(), envelope }));
}

/**
 * Le voci in attesa, in ordine FIFO (`seq` è autoincrementale e `getAll`
 * restituisce in ordine di chiave).
 *
 * Una voce che non si decifra NON viene scartata in silenzio: torna con
 * `unreadable: true`. Scartarla significherebbe far sparire una spesa senza
 * dirlo, che è esattamente ciò che questa coda esiste per evitare. Il caso è
 * remoto — succede se la chiave viene evictata e la coda no — ma se capita
 * deve essere visibile e cancellabile a mano.
 *
 * @returns {Promise<Array<{seq: number, enqueuedAt: string, tx?: object, unreadable?: true}>>}
 */
export async function list(key, salt) {
  const rows = await withStore(IDB_STORE_OUTBOX, 'readonly', (store) => store.getAll());
  const entries = [];
  for (const row of rows) {
    try {
      entries.push({
        seq: row.seq,
        enqueuedAt: row.enqueuedAt,
        tx: await decryptEnvelope(row.envelope, key, salt),
      });
    } catch {
      entries.push({ seq: row.seq, enqueuedAt: row.enqueuedAt, unreadable: true });
    }
  }
  return entries;
}

export const remove = (seq) =>
  withStore(IDB_STORE_OUTBOX, 'readwrite', (store) => store.delete(seq));

export const count = () =>
  withStore(IDB_STORE_OUTBOX, 'readonly', (store) => store.count());

/** Svuota la coda. Serve ai test; nell'app nessuno la chiama. */
export const clear = () =>
  withStore(IDB_STORE_OUTBOX, 'readwrite', (store) => store.clear());

// --- Flush -------------------------------------------------------------------

// Un flush alla volta. I trigger sono tre (`online`, `visibilitychange`, avvio)
// e arrivano volentieri a coppie: due flush paralleli scriverebbero le stesse
// voci due volte e si contenderebbero la rimozione dalla coda.
let flushing = false;

/**
 * Riversa la coda su GitHub.
 *
 * Politica degli errori (D23): al primo fallimento si **ferma e lo dice**,
 * senza consumare la coda. Non distingue fra temporaneo e permanente perché
 * sotto D25 l'unico errore permanente possibile è "anno chiuso", che è remoto:
 * uno stato per voce sarebbe macchinario per un caso che non capita. Le voci
 * dei mesi già scritti prima del fallimento vengono comunque rimosse, così il
 * progresso non si perde.
 *
 * L'errore viene RESTITUITO, non lanciato: un flush che scrive due mesi su tre
 * è un successo parziale, e chi chiama deve poter dire entrambe le cose. Un
 * throw butterebbe via il conteggio di ciò che è passato.
 *
 * @param {import('./store.js').Store} store
 * @returns {Promise<{written: number, pending: number, unreadable: number,
 *                    error: Error|null, skipped?: true}>}
 */
export async function flush(store, key, salt) {
  if (flushing) return { written: 0, pending: await count(), unreadable: 0, error: null, skipped: true };
  flushing = true;

  const originalYear = store.year;
  let written = 0;
  let error = null;

  try {
    const entries = await list(key, salt);
    const unreadable = entries.filter((e) => e.unreadable).length;
    const usable = entries.filter((e) => !e.unreadable);

    // Raggruppate per ANNO, non per mese: il raggruppamento per mese lo fa
    // store.addTransactions, che è dove vivono le scritture. Qui serve l'anno
    // perché lo store ne tiene caricato uno solo per volta, e una spesa
    // inserita offline su un anno diverso da quello caricato verrebbe
    // rifiutata da #assertYearLoaded e bloccherebbe la coda per sempre.
    const byYear = new Map();
    for (const entry of usable) {
      const year = yearOf(entry.tx.month);
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(entry);
    }

    for (const [year, group] of [...byYear].sort(([a], [b]) => a - b)) {
      try {
        if (year !== store.year) {
          await store.ensureMeta(year);
          await store.loadYear(year);
        }
        await store.addTransactions(group.map((entry) => entry.tx));
      } catch (err) {
        error = err;
        break; // la coda non si consuma: si riproverà
      }
      for (const entry of group) await remove(entry.seq);
      written += group.length;
    }

    return { written, pending: await count(), unreadable, error };
  } finally {
    // L'anno caricato è stato cambiato per scrivere: va rimesso com'era, o la
    // schermata che l'utente stava guardando cambierebbe da sola sotto i piedi.
    if (store.year !== originalYear && originalYear != null) {
      await store.loadYear(originalYear).catch(() => {});
    }
    flushing = false;
  }
}
