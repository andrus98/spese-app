// Costanti dell'applicazione. Nessun segreto: questo file sta in un repo pubblico.

// 0.4.0: inserimento offline con coda e sincronizzazione differita.
// 0.4.1: corregge la griglia del guscio, che la 0.4.0 rompeva quando la barra
//        di stato era nascosta — cioè nell'uso normale.
// 0.4.2: investimenti dell'anno nel riepilogo, sotto il risparmio.
// 0.4.3: il foglio non ha più un'altezza illimitata. Quello dei movimenti
//        cresceva verso l'alto oltre il bordo dello schermo — è ancorato in
//        basso — portandosi fuori intestazione, importo e pulsante di chiusura.
//        Insieme, il ricolore delle tessere sull'accento dell'app.
// Il bump non è cosmetico: dà il nome alla cache del service worker, quindi
// senza di lui il codice nuovo non arriverebbe sul dispositivo.
export const APP_VERSION = '0.4.3';

// --- Crittografia -----------------------------------------------------------

// Iterazioni PBKDF2. Il valore finisce nel keyring al primo setup e da quel
// momento non è più cambiabile senza ri-cifrare tutto: 600 000 è la
// raccomandazione OWASP corrente (la specifica citava 310 000, che è quella
// vecchia). La derivazione avviene una volta per dispositivo, quindi il costo
// è irrilevante.
export const PBKDF2_ITERATIONS = 600000;

export const ENVELOPE_FORMAT = 'spese-enc-v1';
export const KEYRING_FORMAT = 'spese-keyring-v1';
export const KEYCHECK_PLAINTEXT = 'spese-keycheck-v1';

export const SALT_BYTES = 16;
export const IV_BYTES = 12; // requisito AES-GCM

// --- Percorsi nel repo dati -------------------------------------------------

export const DATA_ROOT = 'data';
export const KEYRING_PATH = `${DATA_ROOT}/crypto.json`;

export const yearDir = (year) => `${DATA_ROOT}/${year}`;
export const metaPath = (year) => `${yearDir(year)}/meta.json`;
export const monthPath = (month) => `${yearDir(month.slice(0, 4))}/${month}.json`;

// --- Storage locale ---------------------------------------------------------

export const LS_REPO = 'spese.repo';   // "owner/repo"
export const LS_TOKEN = 'spese.token';

export const IDB_NAME = 'spese';
// v2: aggiunge lo store `outbox` (coda offline). Gli store si creano tutti in
// un punto solo — vedi il commento in testa a idb.js, dove sta il motivo per
// cui non possono nascere ciascuno nel proprio modulo.
export const IDB_VERSION = 2;
export const IDB_STORE = 'keys';
export const IDB_KEY_ID = 'aesKey';
export const IDB_STORE_OUTBOX = 'outbox';

// --- Schema -----------------------------------------------------------------

export const SCHEMA_VERSION = 1;

// --- Semi per il primo avvio ------------------------------------------------

// Le categorie sono un DATO, non codice: vivono in meta.json e si possono
// aggiungere senza un deploy. Questo elenco serve solo a costruire il
// meta.json del primo anno quando non esiste ancora (F2.28).
// Ordine e label corrispondono esattamente al master dell'Excel: la label è
// ciò che finisce in colonna A dei fogli mensili, dove la SUMIF la confronta
// come stringa.
export const SEED_CATEGORIES = [
  { id: 'bollette', label: 'Bollette', order: 1 },
  { id: 'alimenti', label: 'Alimenti', order: 2 },
  { id: 'spese_mediche', label: 'Spese mediche', order: 3 },
  { id: 'casa', label: 'Casa', order: 4 },
  { id: 'shopping', label: 'Shopping', order: 5 },
  { id: 'pasti_fuori', label: 'Pasti fuori', order: 6 },
  { id: 'spotify', label: 'Spotify', order: 7 },
  { id: 'dazn', label: 'Dazn', order: 8 },
  { id: 'benzina', label: 'Benzina', order: 9 },
  { id: 'svago', label: 'Svago', order: 10 },
  { id: 'viaggi', label: 'Viaggi', order: 11 },
  { id: 'palestra', label: 'Palestra', order: 12 },
  { id: 'vodafone', label: 'Vodafone', order: 13 },
  { id: 'manutenzione_mazda_sh', label: 'Mazda SH', order: 14 },
  { id: 'caffe', label: 'Caffè', order: 15 },
  { id: 'investimenti', label: 'Investimenti', order: 16 },
  { id: 'tabacchi', label: 'Tabacchi', order: 17 },
  { id: 'barbiere', label: 'Barbiere', order: 18 },
  { id: 'altro', label: 'Altro', order: 19 },
];

// Voci di entrata, identiche a Tabella3 del master.
// Attenzione: `altro` esiste sia qui sia fra le categorie di spesa. Namespace
// separati — non confonderli.
export const INCOME_SOURCES = [
  { id: 'stipendio', label: 'Stipendio' },
  { id: 'buoni_pasto', label: 'Buoni Pasto' },
  { id: 'checco', label: 'Checco' },
  { id: 'altro', label: 'Altro' },
];
