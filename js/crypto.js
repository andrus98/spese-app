// Cifratura end-to-end lato client (D2, D9).
//
// Modello: la passphrase deriva UNA VOLTA una CryptoKey AES-256-GCM non
// estraibile, salvata in IndexedDB. La passphrase non viene mai conservata.
// Il salt PBKDF2 è quindi necessariamente GLOBALE — uno per dataset, non uno
// per file — altrimenti sarebbe impossibile ri-derivare la chiave dei file
// successivi. Vive in chiaro in data/crypto.json insieme a un canarino
// cifrato che permette di riconoscere subito una passphrase sbagliata.

import {
  PBKDF2_ITERATIONS, ENVELOPE_FORMAT, KEYRING_FORMAT, KEYCHECK_PLAINTEXT,
  SALT_BYTES, IV_BYTES, IDB_STORE, IDB_KEY_ID,
} from './config.js';
import { withStore } from './idb.js';
import { WrongPassphraseError, DecryptError, FormatError } from './errors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- Utilità binarie --------------------------------------------------------

// n <= 65536: è il tetto per chiamata di getRandomValues. Qui serve per
// salt (16) e IV (12), quindi non c'è motivo di chunkare.
export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toBase64(bytes) {
  // A chunk, perché String.fromCharCode(...bytes) sfonda lo stack sui payload grandi.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(b64) {
  // Il base64 restituito dalla Contents API di GitHub contiene a capo (E6).
  const binary = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// --- Derivazione della chiave ----------------------------------------------

/**
 * @returns {Promise<CryptoKey>} AES-256-GCM, extractable: false.
 *   Nessun JavaScript può leggerne i byte, nemmeno il nostro.
 */
export async function deriveKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false, // extractable
    ['encrypt', 'decrypt'],
  );
}

// --- Busta cifrata ----------------------------------------------------------

/** Cifra un oggetto JSON. IV nuovo a ogni chiamata: requisito di AES-GCM. */
export async function encryptJSON(obj, key, salt, iterations = PBKDF2_ITERATIONS) {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(obj)),
  );
  return {
    format: ENVELOPE_FORMAT,
    kdf: { algo: 'PBKDF2-SHA256', iterations, salt: toBase64(salt) },
    cipher: { algo: 'AES-256-GCM', iv: toBase64(iv) },
    payload: toBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decifra una busta. `expectedSalt` è il salt del keyring: se non coincide,
 * il file è stato cifrato con un'altra passphrase e va segnalato, non provato
 * a decifrare (produrrebbe comunque un errore GCM, ma opaco).
 */
export async function decryptEnvelope(envelope, key, expectedSalt) {
  if (!envelope || envelope.format !== ENVELOPE_FORMAT) {
    throw new FormatError(`Formato busta non riconosciuto: ${envelope?.format}`);
  }
  if (expectedSalt && !sameBytes(fromBase64(envelope.kdf.salt), expectedSalt)) {
    throw new DecryptError('File cifrato con un\'altra passphrase (salt diverso dal keyring)');
  }
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.cipher.iv) },
      key,
      fromBase64(envelope.payload),
    );
  } catch (cause) {
    // GCM è autenticato: un fallimento è chiave errata o file manomesso.
    // Mai un dato da ignorare.
    throw new DecryptError('Decifratura fallita: chiave errata o file manomesso', { cause });
  }
  return JSON.parse(decoder.decode(plaintext));
}

// --- Keyring (D9) -----------------------------------------------------------

/** Primo dispositivo: genera il salt e il canarino. */
export async function createKeyring(passphrase, iterations = PBKDF2_ITERATIONS) {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(passphrase, salt, iterations);
  const iv = randomBytes(IV_BYTES);
  const check = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, encoder.encode(KEYCHECK_PLAINTEXT),
  );
  const keyring = {
    format: KEYRING_FORMAT,
    kdf: { algo: 'PBKDF2-SHA256', iterations, salt: toBase64(salt) },
    check: { algo: 'AES-256-GCM', iv: toBase64(iv), payload: toBase64(new Uint8Array(check)) },
  };
  return { keyring, key, salt };
}

/**
 * Dispositivi successivi: deriva con il salt già esistente e verifica il
 * canarino. È qui che una passphrase sbagliata viene respinta — non alla
 * prima lettura fallita, quando avrebbe già potuto scrivere dati corrotti.
 */
export async function openKeyring(keyring, passphrase) {
  if (!keyring || keyring.format !== KEYRING_FORMAT) {
    throw new FormatError(`Formato keyring non riconosciuto: ${keyring?.format}`);
  }
  const salt = fromBase64(keyring.kdf.salt);
  const iterations = keyring.kdf.iterations;
  const key = await deriveKey(passphrase, salt, iterations);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(keyring.check.iv) },
      key,
      fromBase64(keyring.check.payload),
    );
  } catch (cause) {
    throw new WrongPassphraseError('Passphrase errata', { cause });
  }
  if (decoder.decode(plaintext) !== KEYCHECK_PLAINTEXT) {
    throw new WrongPassphraseError('Passphrase errata (canarino non corrispondente)');
  }
  return { key, salt, iterations };
}

// --- Persistenza della chiave (IndexedDB) -----------------------------------
//
// Non localStorage: una CryptoKey non estraibile si serializza solo con
// structured clone, che è ciò che usa IndexedDB.
//
// L'apertura del database sta in idb.js, non qui: è condivisa con la coda
// offline, e due moduli che aprono lo stesso database con due upgrade diversi
// si escludono a vicenda. Il perché per esteso è in testa a quel file.

/** Salva chiave e salt insieme: il salt serve a validare le buste in lettura. */
export async function saveKey(key, salt, iterations) {
  await withStore(IDB_STORE, 'readwrite', (store) =>
    store.put({ id: IDB_KEY_ID, key, salt, iterations }));
}

/** @returns {Promise<{key, salt, iterations}|null>} null se mai configurato o evictato. */
export async function loadKey() {
  const rec = await withStore(IDB_STORE, 'readonly', (store) => store.get(IDB_KEY_ID));
  return rec ?? null;
}

export async function clearKey() {
  await withStore(IDB_STORE, 'readwrite', (store) => store.delete(IDB_KEY_ID));
}

/**
 * Chiede a iOS/macOS di non evictare lo storage. Su iOS lo storage scrivibile
 * da script può sparire dopo un periodo di inattività: se succede, la chiave
 * va ri-derivata dalla passphrase (il salt è recuperabile dal keyring).
 * @returns {Promise<boolean|null>} null se l'API non esiste.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return null;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
