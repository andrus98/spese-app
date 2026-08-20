// Apertura del database IndexedDB dell'app: un punto solo, per tutti i moduli.
//
// Non è un'astrazione di comodo, è una necessità. Due moduli che aprono lo
// STESSO database con due `onupgradeneeded` diversi si escludono a vicenda:
// chi apre per primo esegue il proprio handler, la versione sale, e l'handler
// dell'altro non verrà eseguito MAI più — il suo object store non esisterà, e
// non ci sarà nessun upgrade successivo a crearlo, perché la versione è già
// quella giusta. Il guasto dipende dall'ordine di caricamento dei moduli:
// passa i test in locale e si rompe su un dispositivo reale, in modo non
// riproducibile.
//
// Da qui la regola: `applyUpgrade` conosce TUTTI gli store dell'app, e nessun
// altro file chiama `indexedDB.open`.

import { IDB_NAME, IDB_VERSION, IDB_STORE, IDB_STORE_OUTBOX } from './config.js';

/**
 * Crea gli store mancanti. Ogni creazione è condizionata perché l'upgrade può
 * partire da qualunque versione precedente: un dispositivo già configurato
 * arriva qui con `keys` che esiste già e `outbox` che non esiste ancora.
 *
 * Esportata a parte perché è la parte che va verificata: il test la applica a
 * un database di prova, senza toccare quello vero.
 */
export function applyUpgrade(db) {
  if (!db.objectStoreNames.contains(IDB_STORE)) {
    db.createObjectStore(IDB_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(IDB_STORE_OUTBOX)) {
    // `seq` autoincrementale: è l'ordine FIFO della coda. Serve una chiave che
    // non dipenda dal contenuto, che qui è una busta cifrata e opaca.
    db.createObjectStore(IDB_STORE_OUTBOX, { keyPath: 'seq', autoIncrement: true });
  }
}

/**
 * @param {string} [name] sovrascrivibile solo dai test
 * @param {number} [version] idem
 * @returns {Promise<IDBDatabase>}
 */
export function openDB(name = IDB_NAME, version = IDB_VERSION) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => applyUpgrade(req.result);
    req.onsuccess = () => {
      const db = req.result;
      // Se un'altra scheda tiene aperta una connessione a una versione più
      // vecchia, l'upgrade resta bloccato e l'avvio si pianta senza dire
      // perché. Questo handler fa mollare la presa alla scheda vecchia.
      // Le connessioni qui vivono quanto una singola operazione (vedi
      // withStore), quindi chiudere non interrompe niente di lungo.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Una transazione, una promessa. Risolve sul `complete` della transazione e
 * non sul `success` della richiesta: è il commit che garantisce che il dato
 * sia davvero scritto.
 *
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest|undefined} fn
 */
export function tx(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Apre, esegue, chiude: nessuna connessione resta aperta fra un'operazione e l'altra. */
export async function withStore(storeName, mode, fn) {
  const db = await openDB();
  try {
    return await tx(db, storeName, mode, fn);
  } finally {
    db.close();
  }
}
