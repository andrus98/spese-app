// Self-test eseguibile in browser: senza Node, questo è il test runner.
// Aprire dev/selftest.html — funziona anche da GitHub Pages e da iPhone.

import * as C from '../js/crypto.js';
import * as M from '../js/model.js';
import { PBKDF2_ITERATIONS } from '../js/config.js';
import { WrongPassphraseError, DecryptError, ValidationError, FormatError, GitHubError, KIND } from '../js/errors.js';
import { GitHubClient, isNotFound, isConflict } from '../js/github.js';
import { Store } from '../js/store.js';
import { keypadReduce, keypadValue, keypadDisplay } from '../js/keypad.js';
import { hasCategoryIcon, categoryIcon as categoryIconFn } from '../js/icons.js';
import { SEED_CATEGORIES } from '../js/config.js';
import * as K from '../js/kpi.js';
import { makeZip } from '../js/zip.js';
import { buildWorkbook } from '../js/export-xlsx.js';
import { el } from '../js/ui.js';
import { createSummaryScreen } from '../js/screen-summary.js';
import { createSettingsSheet } from '../js/screen-settings.js';
import { createMovementsScreen } from '../js/screen-movements.js';
import { createIncomeScreen } from '../js/screen-income.js';
import { createEntryScreen } from '../js/screen-entry.js';

const results = [];
let currentSuite = '';

function suite(name) { currentSuite = name; }

async function test(name, fn) {
  try {
    await fn();
    results.push({ suite: currentSuite, name, ok: true });
  } catch (err) {
    results.push({ suite: currentSuite, name, ok: false, error: `${err.name}: ${err.message}` });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'asserzione fallita');
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'atteso'}: ${e}, ottenuto: ${a}`);
}
async function throwsWith(fn, ErrorClass, msg) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ErrorClass) return;
    throw new Error(`${msg || ''} atteso ${ErrorClass.name}, ottenuto ${err.name}: ${err.message}`);
  }
  throw new Error(`${msg || ''} nessun errore lanciato, atteso ${ErrorClass.name}`);
}

// Iterazioni basse nei test: la correttezza non dipende dal costo, e 600k
// per ogni derivazione renderebbe la suite lentissima. Il valore reale è
// misurato a parte in "costo PBKDF2 reale".
const FAST = 1000;

async function run() {
  // ===================== crypto: base64 ====================================
  suite('base64');

  await test('roundtrip su byte binari, inclusi 0 e 255', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    eq([...C.fromBase64(C.toBase64(bytes))], [...bytes]);
  });

  await test('roundtrip su payload grande (stack safety)', () => {
    // getRandomValues si ferma a 65536 byte per chiamata, e qui interessa
    // solo che toBase64 non sfondi lo stack: basta un riempimento a pattern.
    const bytes = new Uint8Array(200_000).map((_, i) => i & 0xff);
    const back = C.fromBase64(C.toBase64(bytes));
    assert(back.length === bytes.length, `lunghezza ${back.length}`);
    assert(back[0] === bytes[0] && back[199_999] === bytes[199_999], 'contenuto alterato');
  });

  await test('ignora gli a capo inseriti da GitHub', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const withNewlines = C.toBase64(bytes).replace(/(.{2})/, '$1\n');
    eq([...C.fromBase64(withNewlines)], [...bytes]);
  });

  // ===================== crypto: chiave e busta ============================
  suite('cifratura');

  const salt = C.randomBytes(16);
  const key = await C.deriveKey('passphrase-di-prova', salt, FAST);

  await test('la chiave non è estraibile', async () => {
    assert(key.extractable === false, 'extractable dovrebbe essere false');
    // exportKey lancia una DOMException, che non è instanceof Error ovunque:
    // qui basta accertare che fallisca.
    let threw = false;
    try { await crypto.subtle.exportKey('raw', key); } catch { threw = true; }
    assert(threw, 'exportKey dovrebbe fallire su una chiave non estraibile');
  });

  await test('roundtrip cifra/decifra', async () => {
    const data = { a: 1, b: 'àèìòù €', c: [1, 2, 3], d: null };
    const env = await C.encryptJSON(data, key, salt, FAST);
    eq(await C.decryptEnvelope(env, key, salt), data);
  });

  await test('IV diverso a ogni scrittura', async () => {
    const e1 = await C.encryptJSON({ x: 1 }, key, salt, FAST);
    const e2 = await C.encryptJSON({ x: 1 }, key, salt, FAST);
    assert(e1.cipher.iv !== e2.cipher.iv, 'IV riutilizzato');
    assert(e1.payload !== e2.payload, 'ciphertext identico con IV diverso');
  });

  await test('chiave sbagliata → DecryptError', async () => {
    const env = await C.encryptJSON({ x: 1 }, key, salt, FAST);
    const other = await C.deriveKey('passphrase-diversa', salt, FAST);
    await throwsWith(() => C.decryptEnvelope(env, other, salt), DecryptError);
  });

  await test('payload manomesso → DecryptError (GCM autenticato)', async () => {
    const env = await C.encryptJSON({ x: 1 }, key, salt, FAST);
    const bytes = C.fromBase64(env.payload);
    bytes[0] ^= 0xff;
    env.payload = C.toBase64(bytes);
    await throwsWith(() => C.decryptEnvelope(env, key, salt), DecryptError);
  });

  await test('salt diverso dal keyring → DecryptError esplicito', async () => {
    const env = await C.encryptJSON({ x: 1 }, key, salt, FAST);
    await throwsWith(() => C.decryptEnvelope(env, key, C.randomBytes(16)), DecryptError);
  });

  await test('formato busta sconosciuto → FormatError', async () => {
    await throwsWith(() => C.decryptEnvelope({ format: 'altro' }, key, salt), FormatError);
  });

  // ===================== crypto: keyring (D9) ==============================
  suite('keyring');

  const { keyring } = await C.createKeyring('la-mia-passphrase', FAST);

  await test('il keyring non contiene la passphrase né la chiave', () => {
    const dump = JSON.stringify(keyring);
    assert(!dump.includes('la-mia-passphrase'), 'passphrase trapelata nel keyring');
    eq(Object.keys(keyring).sort(), ['check', 'format', 'kdf']);
  });

  await test('passphrase corretta → apre', async () => {
    const opened = await C.openKeyring(keyring, 'la-mia-passphrase');
    assert(opened.key instanceof CryptoKey);
    eq([...opened.salt], [...C.fromBase64(keyring.kdf.salt)]);
  });

  await test('passphrase sbagliata → WrongPassphraseError al setup', async () => {
    await throwsWith(() => C.openKeyring(keyring, 'sbagliata'), WrongPassphraseError);
  });

  await test('due device con la stessa passphrase derivano la STESSA chiave', async () => {
    // È il motivo per cui il salt deve essere globale (E8/D9).
    const deviceA = await C.openKeyring(keyring, 'la-mia-passphrase');
    const deviceB = await C.openKeyring(keyring, 'la-mia-passphrase');
    const env = await C.encryptJSON({ da: 'iPhone' }, deviceA.key, deviceA.salt, FAST);
    eq(await C.decryptEnvelope(env, deviceB.key, deviceB.salt), { da: 'iPhone' });
  });

  await test('keyring di formato sconosciuto → FormatError', async () => {
    await throwsWith(() => C.openKeyring({ format: 'boh' }, 'x'), FormatError);
  });

  // ===================== crypto: IndexedDB =================================
  suite('IndexedDB');

  await test('salva, rilegge e la chiave funziona ancora', async () => {
    await C.saveKey(key, salt, FAST);
    const rec = await C.loadKey();
    assert(rec, 'nessun record letto');
    assert(rec.key instanceof CryptoKey, 'la chiave non è una CryptoKey');
    assert(rec.key.extractable === false, 'la chiave riletta è estraibile');
    const env = await C.encryptJSON({ ok: true }, rec.key, rec.salt, FAST);
    eq(await C.decryptEnvelope(env, rec.key, rec.salt), { ok: true });
  });

  await test('clearKey svuota', async () => {
    await C.clearKey();
    eq(await C.loadKey(), null);
  });

  // ===================== model: importi ====================================
  suite('parseAmount (anomalia A)');

  const amountCases = [
    ['12,50', 12.5], ['12.50', 12.5], ['12.10', 12.1], ['1.1', 1.1],
    ['20\u00a0', 20], ['\u00a020\u00a0', 20], ['14\u00a0', 14],
    ['\u20ac 12,50', 12.5], ['12,50 \u20ac', 12.5],
    ['1.234,56', 1234.56], ['1,234.56', 1234.56],
    [11.3, 11.3], ['0,01', 0.01],
  ];
  for (const [input, expected] of amountCases) {
    await test(`"${String(input).replace(/\u00a0/g, '<nbsp>')}" \u2192 ${expected}`, () => {
      eq(M.parseAmount(input), expected);
    });
  }

  for (const bad of ['', '   ', 'abc', '0', '0,00', '-5', '1.2.3', '12,,5', null, undefined, NaN]) {
    await test(`rifiuta ${JSON.stringify(bad) ?? 'undefined'}`, () =>
      throwsWith(() => M.parseAmount(bad), ValidationError));
  }

  await test('i 5 importi testuali dell\'Excel sommano a 58,50', () => {
    const recovered = ['12.10', '20\u00a0', '11.30', '14\u00a0', '1.1'].map(M.parseAmount);
    eq(M.sumAmounts(recovered), 58.5);
  });

  await test('sumAmounts non accumula errore float', () => {
    eq(M.sumAmounts([0.1, 0.2]), 0.3);
    eq(M.sumAmounts(Array(10).fill(0.1)), 1);
    eq(M.sumAmounts([20.99, 34, 30]), 84.99);
  });

  // ===================== model: mesi (D11) =================================
  suite('mesi');

  await test('currentMonth usa la data LOCALE, non UTC', () => {
    // 31 dicembre 2026, 23:30 ora locale: in UTC+1 sarebbe già gennaio.
    eq(M.currentMonth(new Date(2026, 11, 31, 23, 30)), '2026-12');
    eq(M.currentMonth(new Date(2026, 0, 1, 0, 5)), '2026-01');
  });

  await test('validazione del mese', () => {
    assert(M.isValidMonth('2026-01'));
    assert(M.isValidMonth('2026-12'));
    assert(!M.isValidMonth('2026-13'));
    assert(!M.isValidMonth('2026-00'));
    assert(!M.isValidMonth('2026-1'));
    assert(!M.isValidMonth('2026-01-15'), 'una data completa non è un mese valido (D11)');
  });

  await test('monthsOfYear dà 12 mesi ordinati', () => {
    const months = M.monthsOfYear(2026);
    eq(months.length, 12);
    eq(months[0], '2026-01');
    eq(months[11], '2026-12');
  });

  await test('etichette dei mesi come nei fogli Excel', () => {
    eq(M.monthLabel('2026-01'), 'gennaio');
    eq(M.monthLabel('2026-05'), 'maggio');
    eq(M.monthLabel('2026-12'), 'dicembre');
  });

  await test('daysElapsedInMonth: passato pieno, futuro zero, corrente parziale', () => {
    const now = new Date(2026, 7, 17); // 17 agosto 2026
    eq(M.daysElapsedInMonth('2026-01', now), 31);
    eq(M.daysElapsedInMonth('2026-02', now), 28);
    eq(M.daysElapsedInMonth('2026-08', now), 17);
    eq(M.daysElapsedInMonth('2026-09', now), 0);
  });

  // ===================== model: ULID =======================================
  suite('ULID');

  await test('26 caratteri dell\'alfabeto Crockford', () => {
    const id = M.ulid();
    eq(id.length, 26);
    assert(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id), `alfabeto inatteso: ${id}`);
  });

  await test('ordinabile per tempo', () => {
    const older = M.ulid(1_700_000_000_000);
    const newer = M.ulid(1_800_000_000_000);
    assert(older < newer, 'gli ULID non sono ordinabili lessicograficamente');
  });

  await test('1000 id nello stesso millisecondo sono tutti diversi', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => M.ulid(1_700_000_000_000)));
    eq(ids.size, 1000);
  });

  // ===================== model: transazioni ================================
  suite('transazioni');

  await test('makeTransaction normalizza e valida', () => {
    const tx = M.makeTransaction({
      month: '2026-01', category: 'viaggi',
      detail: ' pedaggio\u00a0', amount: '1,70', note: '\u00a0Ovindoli ',
    });
    eq(tx.month, '2026-01');
    eq(tx.detail, 'pedaggio');
    eq(tx.note, 'Ovindoli');
    eq(tx.amount, 1.7);
    assert(!('date' in tx), 'la transazione non deve avere un campo date (D11)');
    assert(tx.createdAt.endsWith('Z'), 'createdAt deve essere UTC');
  });

  await test('nota vuota → campo assente, non stringa vuota', () => {
    const tx = M.makeTransaction({ month: '2026-01', category: 'caffe', detail: 'caffe', amount: 1.2, note: '  ' });
    assert(!('note' in tx));
  });

  await test('mese non valido → ValidationError', () => {
    return throwsWith(() => M.makeTransaction({ month: '2026-13', category: 'casa', amount: 1 }), ValidationError);
  });

  await test('categoria mancante → ValidationError', () => {
    return throwsWith(() => M.makeTransaction({ month: '2026-01', category: '  ', amount: 1 }), ValidationError);
  });

  await test('dedupeById tiene il createdAt più recente', () => {
    const deduped = M.dedupeById([
      { id: 'A', amount: 1, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'A', amount: 2, createdAt: '2026-02-01T00:00:00Z' },
      { id: 'B', amount: 3, createdAt: '2026-01-01T00:00:00Z' },
    ]);
    eq(deduped.length, 2);
    eq(deduped.find((t) => t.id === 'A').amount, 2);
  });

  // ===================== model: ricorrenti (D3) ============================
  suite('ricorrenti');

  const meta = {
    recurring: [
      { category: 'spotify', amount: 20.99, from: '2026-01', to: null },
      { category: 'vodafone', amount: 34, from: '2026-01', to: null },
      { category: 'palestra', amount: 30, from: '2026-05', to: null },
    ],
  };

  await test('Palestra: niente canone fino ad aprile, 30 da maggio', () => {
    eq(M.recurringFor(meta, 'palestra', '2026-04'), 0);
    eq(M.recurringFor(meta, 'palestra', '2026-05'), 30);
    eq(M.recurringFor(meta, 'palestra', '2026-12'), 30);
  });

  await test('Spotify e Vodafone attivi tutto l\'anno', () => {
    eq(M.recurringFor(meta, 'spotify', '2026-01'), 20.99);
    eq(M.recurringFor(meta, 'vodafone', '2026-08'), 34);
  });

  await test('Dazn non è un ricorrente', () => {
    eq(M.recurringFor(meta, 'dazn', '2026-08'), 0);
  });

  await test('un canone con "to" smette dopo quel mese', () => {
    const closed = { recurring: [{ category: 'dazn', amount: 10, from: '2026-01', to: '2026-03' }] };
    eq(M.recurringFor(closed, 'dazn', '2026-03'), 10);
    eq(M.recurringFor(closed, 'dazn', '2026-04'), 0);
  });

  await test('totale ricorrenti mag-dic = 84,99 come nel master', () => {
    const total = M.sumAmounts(
      ['spotify', 'vodafone', 'palestra'].map((c) => M.recurringFor(meta, c, '2026-05')),
    );
    eq(total, 84.99);
  });

  // ===================== model: file =======================================
  suite('validazione file');

  await test('schemaVersion inattesa → FormatError', () => {
    return throwsWith(() => M.validateMonthFile({ schemaVersion: 99, transactions: [] }), FormatError);
  });

  await test('mese incoerente col nome del file → FormatError', () => {
    const file = M.emptyMonthFile('2026-01');
    return throwsWith(() => M.validateMonthFile(file, '2026-02'), FormatError);
  });

  await test('file mensile vuoto valido', () => {
    const file = M.emptyMonthFile('2026-03');
    eq(M.validateMonthFile(file, '2026-03').transactions, []);
  });


  // ===================== github: client ====================================
  suite('GitHub client');

  // fetch finto: registra le chiamate e risponde secondo un copione.
  function mockFetch(handler) {
    const calls = [];
    const impl = async (url, options = {}) => {
      calls.push({
        url,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body: options.body ? JSON.parse(options.body) : null,
      });
      const res = await handler({ url, options, n: calls.length });
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        headers: new Headers(res.headers ?? {}),
        json: async () => res.body ?? {},
      };
    };
    impl.calls = calls;
    return impl;
  }

  const b64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));
  const clientWith = (handler) => new GitHubClient({
    owner: 'andrus98', repo: 'spese-data', token: 'tok', fetchImpl: mockFetch(handler),
  });

  await test('fromSlug accetta "owner/repo", URL completo e suffisso .git', () => {
    for (const input of ['andrus98/spese-data', 'https://github.com/andrus98/spese-data',
                         'andrus98/spese-data.git', ' andrus98/spese-data/ ']) {
      const c = GitHubClient.fromSlug(input, 'tok');
      eq([c.owner, c.repo], ['andrus98', 'spese-data'], `input "${input}"`);
    }
  });

  await test('fromSlug rifiuta un repo malformato', () =>
    throwsWith(() => GitHubClient.fromSlug('soloqualcosa', 'tok'), GitHubError));

  await test('la GET chiede +json, non .raw (serve lo sha)', async () => {
    const impl = mockFetch(() => ({ status: 200, body: { type: 'file', content: b64('{"a":1}'), sha: 'abc' } }));
    const c = new GitHubClient({ owner: 'o', repo: 'r', token: 'tok', fetchImpl: impl });
    await c.getFile('data/2026/2026-01.json');
    eq(impl.calls[0].headers.Accept, 'application/vnd.github+json');
    assert(impl.calls[0].url.endsWith('/repos/o/r/contents/data/2026/2026-01.json'), impl.calls[0].url);
  });

  await test('getFile restituisce testo e sha, tollerando gli a capo nel base64', async () => {
    const withNewlines = b64('{"ok":true}').replace(/(.{4})/g, '$1\n');
    const c = clientWith(() => ({ status: 200, body: { type: 'file', content: withNewlines, sha: 'sha1' } }));
    const { text, sha } = await c.getFile('x.json');
    eq(JSON.parse(text), { ok: true });
    eq(sha, 'sha1');
  });

  await test('getFile decodifica correttamente UTF-8 (Caffè, €)', async () => {
    const c = clientWith(() => ({ status: 200, body: { type: 'file', content: b64('{"c":"Caffè €"}'), sha: 's' } }));
    const { data } = await c.getJSON('x.json');
    eq(data, { c: 'Caffè €' });
  });

  await test('PUT senza sha = creazione (il campo non va inviato)', async () => {
    const impl = mockFetch(() => ({ status: 201, body: { content: { sha: 'nuovo' } } }));
    const c = new GitHubClient({ owner: 'o', repo: 'r', token: 'tok', fetchImpl: impl });
    const { sha } = await c.putFile('data/2026/2026-09.json', '{"x":1}', { message: 'sync' });
    eq(impl.calls[0].method, 'PUT');
    assert(!('sha' in impl.calls[0].body), 'sha non deve essere inviato quando si crea');
    eq(sha, 'nuovo');
  });

  await test('PUT con sha lo invia, e il contenuto è base64', async () => {
    const impl = mockFetch(() => ({ status: 200, body: { content: { sha: 'sha2' } } }));
    const c = new GitHubClient({ owner: 'o', repo: 'r', token: 'tok', fetchImpl: impl });
    await c.putFile('f.json', '{"y":2}', { sha: 'sha1', message: 'sync 2026-08' });
    eq(impl.calls[0].body.sha, 'sha1');
    eq(impl.calls[0].body.message, 'sync 2026-08');
    eq(new TextDecoder().decode(Uint8Array.from(atob(impl.calls[0].body.content), (ch) => ch.charCodeAt(0))), '{"y":2}');
  });

  await test('il messaggio di commit di default non contiene dati (D10)', async () => {
    const impl = mockFetch(() => ({ status: 200, body: { content: { sha: 's' } } }));
    const c = new GitHubClient({ owner: 'o', repo: 'r', token: 'tok', fetchImpl: impl });
    await c.putFile('data/2026/2026-08.json', '{"segreto":"12.50 Pasti fuori"}');
    const msg = impl.calls[0].body.message;
    assert(!/\d+[.,]\d{2}/.test(msg), `importo nel messaggio: "${msg}"`);
    assert(!msg.toLowerCase().includes('pasti'), `categoria nel messaggio: "${msg}"`);
  });

  await test('le scritture sono serializzate, non concorrenti', async () => {
    const events = [];
    let resolveFirst;
    const impl = mockFetch(async ({ n }) => {
      events.push(`inizio${n}`);
      if (n === 1) await new Promise((r) => { resolveFirst = r; });
      events.push(`fine${n}`);
      return { status: 200, body: { content: { sha: `s${n}` } } };
    });
    const c = new GitHubClient({ owner: 'o', repo: 'r', token: 'tok', fetchImpl: impl });
    const p1 = c.putFile('a.json', '1');
    const p2 = c.putFile('b.json', '2');
    await new Promise((r) => setTimeout(r, 10));
    assert(!events.includes('inizio2'), `la seconda PUT è partita subito: ${events}`);
    resolveFirst();
    await Promise.all([p1, p2]);
    eq(events, ['inizio1', 'fine1', 'inizio2', 'fine2']);
  });

  await test('un errore non blocca le scritture successive', async () => {
    let n = 0;
    const c = clientWith(() => (++n === 1
      ? { status: 500, body: { message: 'boom' } }
      : { status: 200, body: { content: { sha: 'ok' } } }));
    await throwsWith(() => c.putFile('a.json', '1'), GitHubError);
    eq((await c.putFile('b.json', '2')).sha, 'ok');
  });

  // --- mappatura degli errori ---
  const errorCases = [
    [401, {}, KIND.UNAUTHORIZED, 'token scaduto'],
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }, KIND.RATE_LIMIT, 'limite primario'],
    [403, { 'retry-after': '60' }, KIND.SECONDARY_LIMIT, 'limite secondario'],
    [404, {}, KIND.NOT_FOUND, 'file inesistente'],
    [409, {}, KIND.CONFLICT, 'sha obsoleto'],
    [422, {}, KIND.UNPROCESSABLE, 'sha mancante'],
    [500, {}, KIND.UNKNOWN, 'errore generico'],
  ];
  for (const [status, headers, expectedKind, label] of errorCases) {
    await test(`${status} → ${expectedKind} (${label})`, async () => {
      const c = clientWith(() => ({ status, headers, body: { message: 'dettaglio' } }));
      try {
        await c.getFile('x.json');
        throw new Error('nessun errore lanciato');
      } catch (err) {
        assert(err instanceof GitHubError, `tipo inatteso: ${err.name}`);
        eq(err.kind, expectedKind);
        eq(err.status, status);
      }
    });
  }

  await test('403 con e senza rate-limit azzerato sono errori DIVERSI', async () => {
    // Hanno rimedi opposti: aspettare il reset vs rallentare e riprovare.
    const primary = clientWith(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: {} }));
    const secondary = clientWith(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '4999' }, body: {} }));
    let k1, k2;
    try { await primary.getFile('x'); } catch (e) { k1 = e.kind; }
    try { await secondary.getFile('x'); } catch (e) { k2 = e.kind; }
    assert(k1 !== k2, `entrambi ${k1}`);
  });

  await test('fetch fallita → NETWORK, non un errore opaco', async () => {
    const c = new GitHubClient({
      owner: 'o', repo: 'r', token: 'tok',
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    try {
      await c.getFile('x.json');
      throw new Error('nessun errore');
    } catch (err) {
      eq(err.kind, KIND.NETWORK);
    }
  });

  await test('isNotFound distingue il mese nuovo dal resto', async () => {
    const missing = clientWith(() => ({ status: 404, body: {} }));
    const broken = clientWith(() => ({ status: 500, body: {} }));
    try { await missing.getFile('data/2026/2026-12.json'); } catch (e) { assert(isNotFound(e)); }
    try { await broken.getFile('x'); } catch (e) { assert(!isNotFound(e) && !isConflict(e)); }
  });

  await test('listYears scarta crypto.json e tiene solo le cartelle-anno', async () => {
    const c = clientWith(() => ({
      status: 200,
      body: [
        { name: 'crypto.json', path: 'data/crypto.json', type: 'file' },
        { name: '2026', path: 'data/2026', type: 'dir' },
        { name: '2027', path: 'data/2027', type: 'dir' },
        { name: 'note.txt', path: 'data/note.txt', type: 'file' },
        { name: 'backup', path: 'data/backup', type: 'dir' },
      ],
    }));
    eq(await c.listYears('data'), [2027, 2026]);
  });

  await test('listYears su repo dati vuoto → [] invece di errore', async () => {
    const c = clientWith(() => ({ status: 404, body: {} }));
    eq(await c.listYears('data'), []);
  });

  await test('un repo VUOTO passa il test di connessione', async () => {
    // Regressione: su un repo senza nemmeno un commit `GET /contents/`
    // risponde 404 anche con auth valida, e il setup bocciava il caso del
    // primo avvio. Il test va fatto sull'endpoint del repo.
    const impl = mockFetch(({ url }) => (url.endsWith('/contents/')
      ? { status: 404, body: { message: 'This repository is empty.' } }
      : { status: 200, body: { full_name: 'o/r', size: 0, private: true, permissions: { push: true } } }));
    const c = new GitHubClient({ owner: 'o', repo: 'r', token: 'tok', fetchImpl: impl });
    const res = await c.testConnection();
    eq(res.ok, true, `repo vuoto bocciato: ${res.message}`);
    eq(res.empty, true);
    assert(!impl.calls.some((call) => call.url.includes('/contents')),
      'il test di connessione non deve passare dai contenuti');
  });

  await test('repo inesistente o fuori dal token → bocciato', async () => {
    const c = clientWith(() => ({ status: 404, body: { message: 'Not Found' } }));
    const res = await c.testConnection();
    eq(res.ok, false);
    assert(res.message.includes('token'), res.message);
  });

  await test('token in sola lettura → bocciato PRIMA di scrivere', async () => {
    // Contents: read-only passerebbe qualunque lettura e fallirebbe solo
    // alla prima spesa salvata.
    const c = clientWith(() => ({ status: 200, body: { size: 10, permissions: { push: false } } }));
    const res = await c.testConnection();
    eq(res.ok, false);
    assert(res.message.includes('scrivere'), res.message);
  });

  await test('token scaduto → messaggio diverso da repo sbagliato', async () => {
    const c = clientWith(() => ({ status: 401, body: {} }));
    const res = await c.testConnection();
    eq(res.ok, false);
    eq(res.kind, KIND.UNAUTHORIZED);
  });


  // ===================== store =============================================
  suite('store');

  // Finto GitHub in memoria che riproduce la semantica degli sha:
  // 422 se il file esiste e non mandi lo sha, 409 se lo sha e obsoleto.
  function fakeRepo(seed = {}) {
    const files = new Map(Object.entries(seed));
    let counter = 0;
    const repo = {
      files,
      beforePut: null, // hook per simulare l'altro dispositivo
      putCount: 0,
      failPut: null,   // (path, n) => status | null
    };
    const decode = (b64) => new TextDecoder().decode(
      Uint8Array.from(atob(b64.replace(/\s+/g, '')), (ch) => ch.charCodeAt(0)));
    const encode = (txt) => btoa(String.fromCharCode(...new TextEncoder().encode(txt)));

    repo.write = (path, text) => files.set(path, { text, sha: `sha${++counter}` });

    repo.fetchImpl = async (url, options = {}) => {
      const path = decodeURIComponent(url.split('/contents/')[1] ?? '');
      const method = options.method ?? 'GET';
      const reply = (status, body, headers = {}) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        json: async () => body,
      });

      if (method === 'GET') {
        (repo.gets ??= []).push(path);
        const file = files.get(path);
        if (file) return reply(200, { type: 'file', content: encode(file.text), sha: file.sha });
        const prefix = path ? `${path}/` : '';
        const children = new Map();
        for (const key of files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const [head, ...tail] = rest.split('/');
          children.set(head, { name: head, path: prefix + head, type: tail.length ? 'dir' : 'file' });
        }
        if (children.size) return reply(200, [...children.values()]);
        return reply(404, { message: 'Not Found' });
      }

      if (method === 'PUT') {
        repo.putCount += 1;
        if (repo.beforePut) { const hook = repo.beforePut; repo.beforePut = null; await hook(); }
        const forced = repo.failPut?.(path, repo.putCount);
        if (forced) return reply(forced, { message: 'forzato' });

        const body = JSON.parse(options.body);
        const existing = files.get(path);
        if (existing && !body.sha) return reply(422, { message: 'sha wasn\'t supplied' });
        if (existing && body.sha !== existing.sha) return reply(409, { message: 'does not match' });
        if (!existing && body.sha) return reply(422, { message: 'sha given but file absent' });
        files.set(path, { text: decode(body.content), sha: `sha${++counter}` });
        return reply(200, { content: { sha: files.get(path).sha } });
      }
      return reply(500, { message: `metodo non gestito: ${method}` });
    };
    return repo;
  }

  async function freshStore(seed) {
    const repo = fakeRepo(seed);
    const { keyring, key, salt } = await C.createKeyring('pass-store', FAST);
    repo.write('data/crypto.json', JSON.stringify(keyring));
    const client = new GitHubClient({ owner: 'o', repo: 'r', token: 't', fetchImpl: repo.fetchImpl });
    const store = new Store({ client, key, salt });
    return { store, repo, key, salt };
  }

  const decryptAt = async (repo, key, salt, path) =>
    C.decryptEnvelope(JSON.parse(repo.files.get(path).text), key, salt);

  await test('salva una spesa e la rilegge dopo un reload', async () => {
    const { store, repo, key, salt } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    await store.addTransaction({ month: '2026-08', category: 'pasti_fuori', detail: 'pranzo', amount: '12,50' });

    const other = new Store({ client: store.client, key, salt });
    const { transactions } = await other.loadYear(2026);
    eq(transactions.length, 1);
    eq(transactions[0].amount, 12.5);
    eq(transactions[0].detail, 'pranzo');
    eq(transactions[0].month, '2026-08');
  });

  await test('su GitHub finisce SOLO ciphertext', async () => {
    const { store, repo } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    await store.addTransaction({ month: '2026-08', category: 'viaggi', detail: 'pedaggio-segreto', amount: 1.7 });

    const raw = repo.files.get('data/2026/2026-08.json').text;
    assert(!raw.includes('pedaggio-segreto'), 'il dettaglio e leggibile in chiaro!');
    assert(!raw.includes('viaggi'), 'la categoria e leggibile in chiaro!');
    assert(!raw.includes('1.7'), 'l\'importo e leggibile in chiaro!');
    eq(JSON.parse(raw).format, 'spese-enc-v1');
  });

  await test('i mesi inesistenti valgono vuoti, non errore', async () => {
    const { store } = await freshStore();
    await store.ensureMeta(2026);
    const { transactions } = await store.loadYear(2026);
    eq(transactions, []);
    eq(store.months.size, 12);
  });

  await test('409: la scrittura dell\'altro dispositivo NON viene persa', async () => {
    const { store, repo, key, salt } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    await store.addTransaction({ month: '2026-08', category: 'caffe', detail: 'primo', amount: 1 });

    // L'altro dispositivo scrive fra la lettura e la scrittura di questo.
    repo.beforePut = async () => {
      const current = await decryptAt(repo, key, salt, 'data/2026/2026-08.json');
      current.transactions.push({ id: 'ALTRO', month: '2026-08', category: 'svago', detail: 'da-iphone', amount: 5, createdAt: '2026-08-17T10:00:00Z' });
      repo.write('data/2026/2026-08.json', JSON.stringify(await C.encryptJSON(current, key, salt)));
    };
    await store.addTransaction({ month: '2026-08', category: 'caffe', detail: 'secondo', amount: 2 });

    const saved = await decryptAt(repo, key, salt, 'data/2026/2026-08.json');
    const details = saved.transactions.map((t) => t.detail).sort();
    eq(details, ['da-iphone', 'primo', 'secondo'], 'una scrittura e andata persa');
  });

  await test('422: due dispositivi creano lo stesso mese insieme', async () => {
    const { store, repo, key, salt } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026); // 2026-09 non esiste: sha = null

    repo.beforePut = async () => {
      const file = { schemaVersion: 1, month: '2026-09', updatedAt: '2026-09-01T00:00:00Z',
        transactions: [{ id: 'ALTRO', month: '2026-09', category: 'svago', detail: 'da-iphone', amount: 5, createdAt: '2026-09-01T00:00:00Z' }] };
      repo.write('data/2026/2026-09.json', JSON.stringify(await C.encryptJSON(file, key, salt)));
    };
    await store.addTransaction({ month: '2026-09', category: 'caffe', detail: 'dal-mac', amount: 1 });

    const saved = await decryptAt(repo, key, salt, 'data/2026/2026-09.json');
    eq(saved.transactions.map((t) => t.detail).sort(), ['da-iphone', 'dal-mac']);
  });

  await test('spostamento di mese: la spesa resta una sola', async () => {
    const { store, repo, key, salt } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    const tx = await store.addTransaction({ month: '2026-07', category: 'svago', detail: 'cinema', amount: 9 });

    await store.updateTransaction(tx.id, { month: '2026-08' });

    const luglio = await decryptAt(repo, key, salt, 'data/2026/2026-07.json');
    const agosto = await decryptAt(repo, key, salt, 'data/2026/2026-08.json');
    eq(luglio.transactions.length, 0, 'non rimossa dall\'origine');
    eq(agosto.transactions.length, 1, 'non scritta sulla destinazione');
    eq(store.transactions.length, 1);
    eq(store.transactions[0].month, '2026-08');
  });

  await test('spostamento interrotto a meta: duplicato visibile, non perdita', async () => {
    const { store, repo, key, salt } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    const tx = await store.addTransaction({ month: '2026-07', category: 'svago', detail: 'cinema', amount: 9 });

    // La destinazione va a buon fine, la rimozione dall'origine fallisce.
    const putsSoFar = repo.putCount;
    repo.failPut = (path, n) => (n > putsSoFar + 1 && path.endsWith('2026-07.json') ? 500 : null);
    let failed = false;
    try { await store.updateTransaction(tx.id, { month: '2026-08' }); } catch { failed = true; }
    repo.failPut = null;

    assert(failed, 'l\'errore doveva emergere');
    const agosto = await decryptAt(repo, key, salt, 'data/2026/2026-08.json');
    const luglio = await decryptAt(repo, key, salt, 'data/2026/2026-07.json');
    eq(agosto.transactions.length, 1, 'la destinazione deve avere la spesa');
    eq(luglio.transactions.length, 1, 'l\'origine la conserva: duplicato, non perdita');
    // dedupeById tiene un solo record in memoria, quindi resta correggibile.
    eq(store.transactions.filter((t) => t.id === tx.id).length, 1);
  });

  await test('cancellazione', async () => {
    const { store, repo, key, salt } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    const tx = await store.addTransaction({ month: '2026-08', category: 'casa', detail: 'x', amount: 3 });
    await store.deleteTransaction(tx.id);
    eq(store.transactions.length, 0);
    eq((await decryptAt(repo, key, salt, 'data/2026/2026-08.json')).transactions.length, 0);
  });

  await test('scrivere su un mese di un altro anno viene rifiutato', async () => {
    const { store } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    await throwsWith(
      () => store.addTransaction({ month: '2027-01', category: 'casa', detail: 'x', amount: 1 }),
      ValidationError);
  });

  await test('le note usate finiscono nei suggerimenti (D4)', async () => {
    const { store } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    await store.addTransaction({ month: '2026-08', category: 'viaggi', detail: 'pedaggio', amount: 1.7, note: 'Ovindoli' });
    await store.addTransaction({ month: '2026-08', category: 'viaggi', detail: 'benzina', amount: 40, note: 'Ovindoli' });
    eq(store.meta.noteSuggestions, ['Ovindoli'], 'la nota non deve essere duplicata');
  });

  await test('se il salvataggio della nota fallisce, la SPESA resta salvata', async () => {
    const { store, repo } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    repo.failPut = (path) => (path.endsWith('meta.json') ? 500 : null);
    const tx = await store.addTransaction({ month: '2026-08', category: 'svago', detail: 'x', amount: 4, note: 'Madonna' });
    repo.failPut = null;
    eq(store.transactions.length, 1);
    eq(store.find(tx.id).note, 'Madonna');
  });

  await test('ensureMeta crea l\'anno con le 19 categorie del master', async () => {
    const { store } = await freshStore();
    const meta = await store.ensureMeta(2026);
    eq(meta.categories.length, 19);
    eq(meta.categories[0].label, 'Bollette');
    eq(meta.categories[18].label, 'Altro');
    eq(meta.categories[14].label, 'Caffè');
  });

  await test('rollover: riporta i canoni attivi e scarta quelli chiusi', async () => {
    const { store, key, salt, repo } = await freshStore();
    await store.ensureMeta(2026);
    await store.setRecurring([
      { category: 'spotify', amount: 20.99, from: '2026-01', to: null },
      { category: 'palestra', amount: 30, from: '2026-05', to: null },
      { category: 'dazn', amount: 10, from: '2026-01', to: '2026-06' },
    ]);

    const next = new Store({ client: store.client, key, salt });
    const meta2027 = await next.ensureMeta(2027);
    eq(meta2027.year, 2027);
    eq(meta2027.recurring.map((r) => r.category).sort(), ['palestra', 'spotify']);
    eq(meta2027.recurring.every((r) => r.from === '2027-01'), true, 'i canoni devono ripartire da gennaio');
    eq(meta2027.categories.length, 19);
  });

  await test('entrate: 4 voci per mese, azzerare rimuove la voce (D6)', async () => {
    const { store } = await freshStore();
    await store.ensureMeta(2026);
    await store.setIncome('2026-01', 'stipendio', 1800);
    await store.setIncome('2026-01', 'buoni_pasto', 55);
    eq(store.meta.income.length, 2);
    await store.setIncome('2026-01', 'stipendio', 1600);
    eq(store.meta.income.filter((e) => e.source === 'stipendio').length, 1, 'sovrascrittura, non duplicato');
    eq(store.meta.income.find((e) => e.source === 'stipendio').amount, 1600);
    await store.setIncome('2026-01', 'buoni_pasto', 0);
    eq(store.meta.income.length, 1, 'un importo a zero rimuove la voce');
  });


  // ===================== tastierino ========================================
  suite('tastierino');

  // Digita una sequenza di tasti e restituisce lo stato finale.
  const type = (keys) => [...keys].reduce(
    (state, k) => keypadReduce(state, k === '<' ? 'back' : k), '');

  const padCases = [
    ['1250', '1250'],
    ['12,50', '12,50'],
    ['12,505', '12,50'],   // massimo 2 decimali
    ['12,,5', '12,5'],     // un solo separatore
    [',50', '0,50'],       // non si puo iniziare con la virgola
    ['05', '5'],           // niente zeri iniziali
    ['1234567', '123456'], // massimo 6 cifre intere
    ['125<', '12'],        // backspace
    ['1<<<<', ''],         // backspace oltre il vuoto non rompe
  ];
  for (const [keys, expected] of padCases) {
    await test(`"${keys}" → "${expected}"`, () => eq(type(keys), expected));
  }

  await test('il valore rifiuta vuoto, zero e virgola sola', () => {
    eq(keypadValue(''), null);
    eq(keypadValue('0'), null);
    eq(keypadValue('0,'), null);
    eq(keypadValue('12,50'), 12.5);
    eq(keypadValue('0,01'), 0.01);
  });

  await test('quel che si vede a schermo mentre si digita', () => {
    eq(keypadDisplay(''), '0,00');
    eq(keypadDisplay('12'), '12');
    eq(keypadDisplay('12,'), '12,');
    eq(keypadDisplay('12,5'), '12,5');
    // In italiano i numeri di 4 cifre non si raggruppano (CLDR
    // minimumGroupingDigits = 2): 1250 resta "1250", 12500 diventa "12.500".
    eq(keypadDisplay('1250'), '1250');
    eq(keypadDisplay('12500'), '12.500');
  });

  await test('l\'importo digitato è accettato da parseAmount', () => {
    // I due percorsi devono coincidere: il tastierino non deve poter produrre
    // qualcosa che il modello poi rifiuta.
    for (const keys of ['1250', '12,50', '0,01', '999999']) {
      const state = type(keys);
      eq(M.parseAmount(state), keypadValue(state), `sequenza "${keys}"`);
    }
  });

  await test('tutte e 19 le categorie hanno un\'icona', () => {
    const missing = SEED_CATEGORIES.filter((c) => !hasCategoryIcon(c.id)).map((c) => c.id);
    eq(missing, []);
    eq(SEED_CATEGORIES.length, 19);
  });


  // ===================== kpi ===============================================
  suite('KPI');

  // Fixture SINTETICA. I numeri veri dell'Excel non stanno in questo repo,
  // che e' pubblico: la verifica contro i totali reali vive in migrate.py,
  // che gira in locale ed e' il posto giusto per farlo. Qui serve solo che
  // le regole di composizione siano corrette, e quelle valgono con qualsiasi
  // numero purche' le attese siano derivate dagli stessi dati.
  const CELLS = [
    ['2026-01','bollette',149.35],
    ['2026-01','alimenti',163.11],
    ['2026-01','spese_mediche',187.75],
    ['2026-01','casa',98.22],
    ['2026-01','shopping',125.78],
    ['2026-01','pasti_fuori',211.09],
    ['2026-01','benzina',115.69],
    ['2026-01','svago',13.96],
    ['2026-01','viaggi',38.84],
    ['2026-01','palestra',238.69],
    ['2026-01','manutenzione_mazda_sh',166.97],
    ['2026-01','caffe',86.17],
    ['2026-01','investimenti',244.49],
    ['2026-01','tabacchi',10.97],
    ['2026-01','barbiere',282.24],
    ['2026-01','altro',268.47],
    ['2026-02','bollette',87.32],
    ['2026-02','alimenti',128.66],
    ['2026-02','spese_mediche',62.85],
    ['2026-02','casa',6.8],
    ['2026-02','shopping',242.92],
    ['2026-02','pasti_fuori',95.11],
    ['2026-02','benzina',164.27],
    ['2026-02','svago',92.11],
    ['2026-02','viaggi',195.12],
    ['2026-02','palestra',283.81],
    ['2026-02','manutenzione_mazda_sh',42.16],
    ['2026-02','caffe',123.01],
    ['2026-02','investimenti',186.11],
    ['2026-02','tabacchi',140.98],
    ['2026-02','barbiere',113.55],
    ['2026-02','altro',229.48],
    ['2026-03','bollette',137.66],
    ['2026-03','alimenti',251.69],
    ['2026-03','spese_mediche',171.33],
    ['2026-03','casa',31.2],
    ['2026-03','shopping',71.84],
    ['2026-03','pasti_fuori',9.02],
    ['2026-03','benzina',254.91],
    ['2026-03','svago',212.43],
    ['2026-03','viaggi',167.41],
    ['2026-03','manutenzione_mazda_sh',244.56],
    ['2026-03','caffe',216.14],
    ['2026-03','investimenti',232.17],
    ['2026-03','tabacchi',207.61],
    ['2026-03','barbiere',105.62],
    ['2026-03','altro',115.8],
    ['2026-04','bollette',254.18],
    ['2026-04','alimenti',52.84],
    ['2026-04','spese_mediche',126.8],
    ['2026-04','casa',299.91],
    ['2026-04','shopping',150.14],
    ['2026-04','pasti_fuori',40.43],
    ['2026-04','benzina',229.83],
    ['2026-04','svago',30.39],
    ['2026-04','viaggi',20.27],
    ['2026-04','palestra',48.06],
    ['2026-04','manutenzione_mazda_sh',170.49],
    ['2026-04','caffe',91.43],
    ['2026-04','investimenti',69.39],
    ['2026-04','tabacchi',140.16],
    ['2026-04','barbiere',256.07],
    ['2026-04','altro',34.26]
  ];
  const excelTx = CELLS.map(([month, category, amount], i) => ({
    id: `T${String(i).padStart(4, '0')}`, month, category, amount,
    detail: 'x', createdAt: '2026-01-01T00:00:00Z',
  }));
  const excelMeta = {
    categories: SEED_CATEGORIES,
    recurring: [
      { category: 'spotify', amount: 20.99, from: '2026-01', to: null },
      { category: 'vodafone', amount: 34, from: '2026-01', to: null },
      { category: 'palestra', amount: 30, from: '2026-05', to: null },
    ],
    income: [
      { month: '2026-01', source: 'stipendio', amount: 1800 },
      { month: '2026-01', source: 'buoni_pasto', amount: 60 },
      { month: '2026-01', source: 'altro', amount: 5 },
      { month: '2026-02', source: 'stipendio', amount: 1800 },
      { month: '2026-02', source: 'buoni_pasto', amount: 120 },
      { month: '2026-03', source: 'stipendio', amount: 1800 },
      { month: '2026-03', source: 'buoni_pasto', amount: 128 },
      { month: '2026-03', source: 'altro', amount: 10 },
      { month: '2026-04', source: 'stipendio', amount: 1800 },
      { month: '2026-04', source: 'buoni_pasto', amount: 128 },
    ],
  };
  const NOW = new Date(2026, 7, 18); // 18 agosto 2026

  await test('somma le sole transazioni, per mese', () => {
    eq(K.transactionsTotal(excelTx, { month: '2026-01' }), 2401.79);
    eq(K.transactionsTotal(excelTx, { month: '2026-04' }), 2014.65);
  });

  await test('i canoni si SOMMANO alle transazioni (D3)', () => {
    eq(K.monthTotal(excelTx, excelMeta, '2026-01'), 2456.78);
    // Palestra: il caso ibrido. Solo transazioni fino ad aprile, canone da
    // maggio, e un mese senza nessuna delle due cose.
    eq(K.categoryMonth(excelTx, excelMeta, 'palestra', '2026-02'), 283.81);
    eq(K.categoryMonth(excelTx, excelMeta, 'palestra', '2026-03'), 0);
    eq(K.categoryMonth(excelTx, excelMeta, 'palestra', '2026-05'), 30);
    // Un mese senza transazioni vale esattamente i canoni attivi.
    eq(K.monthTotal(excelTx, excelMeta, '2026-06'), 84.99);
  });

  await test('il totale anno = transazioni + tutti i canoni dei 12 mesi', () => {
    eq(K.yearTotal(excelTx, excelMeta, 2026), 9939.97);
    eq(M.sumAmounts([9939.97, -9040.09]), 899.88);
  });

  await test('totale anno per categoria = colonna TOTALE ANNO', () => {
    eq(K.categoryYear(excelTx, excelMeta, 'spotify', 2026), 251.88);   // 20,99 x 12
    eq(K.categoryYear(excelTx, excelMeta, 'vodafone', 2026), 408);     // 34 x 12
    eq(K.categoryYear(excelTx, excelMeta, 'palestra', 2026), 810.56);
    eq(K.categoryYear(excelTx, excelMeta, 'dazn', 2026), 0);           // mai usata
  });

  await test('entrate e risparmio', () => {
    eq(K.incomeMonth(excelMeta, '2026-01'), 1865);
    eq(K.savings(excelTx, excelMeta, '2026-01'), -591.78);
    eq(K.incomeYear(excelMeta, 2026), 7651);
  });

  await test('tasso di risparmio: null se non ci sono entrate, non zero', () => {
    eq(K.savingsRate(excelTx, excelMeta, '2026-06'), null);
    assert(K.savingsRate(excelTx, excelMeta, '2026-02') != null);
  });

  await test('variazione mese su mese, e ratio null su base zero', () => {
    const feb = K.monthOverMonth(excelTx, excelMeta, '2026-02');
    eq(feb.delta, M.sumAmounts([2249.25, -2456.78]));
    eq(K.previousMonth('2026-01'), '2025-12');
    eq(K.monthOverMonth(excelTx, excelMeta, '2026-01').ratio, null); // dicembre 2025 vuoto
  });

  await test('la proiezione usa solo i mesi CONCLUSI', () => {
    // Ad agosto sono conclusi gen-lug: includere agosto, incompleto,
    // abbasserebbe la media e sottostimerebbe l'anno.
    const luglio = M.sumAmounts(['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07']
      .map((m) => K.monthTotal(excelTx, excelMeta, m)));
    eq(K.runRate(excelTx, excelMeta, 2026, NOW), Math.round((luglio / 7) * 12 * 100) / 100);
    eq(K.runRate(excelTx, excelMeta, 2026, new Date(2026, 0, 15)), null); // nessun mese concluso
  });

  await test('le Top 5 escludono i canoni: non sono spese fatte', () => {
    eq(K.topExpenses(excelTx, '2026-06'), [], 'giugno ha solo canoni');
    const gennaio = K.topExpenses(excelTx, '2026-01');
    assert(gennaio.every((t) => t.category !== 'spotify' && t.category !== 'vodafone'));
    assert(gennaio.length <= 5);
  });

  await test('la ripartizione somma al 100% ed e ordinata', () => {
    const rows = K.breakdown(excelTx, excelMeta, '2026-01');
    eq(M.sumAmounts(rows.map((r) => r.amount)), K.monthTotal(excelTx, excelMeta, '2026-01'));
    assert(Math.abs(rows.reduce((acc, r) => acc + r.share, 0) - 1) < 1e-9);
    for (let i = 1; i < rows.length; i++) assert(rows[i - 1].amount >= rows[i].amount, 'non ordinata');
  });

  await test('media giornaliera dai giorni trascorsi, non dai giorni delle spese', () => {
    eq(K.dailyAverage(excelTx, excelMeta, '2026-01', NOW),
       Math.round((2456.78 / 31) * 100) / 100);
  });

  // ===================== schermate =========================================
  suite('schermate');

  // Store finto con la forma che le schermate leggono davvero.
  const fakeApp = {
    year: 2026,
    refresh() {},
    store: {
      year: 2026,
      meta: excelMeta,
      transactions: excelTx,
      transactionsOf: (m) => excelTx.filter((t) => t.month === m),
      setIncome: async () => {},
      setRecurring: async () => {},
    },
  };

  await test('il Riepilogo si disegna e mostra il totale giusto', () => {
    const screen = createSummaryScreen(fakeApp);
    document.body.append(screen.node);
    screen.setMonth('2026-01');
    const text = screen.node.textContent;
    // In italiano i numeri di 4 cifre non si raggruppano, quelli di 5 si.
    assert(text.includes('2456,78'), `totale mancante nel rendering: ${text.slice(0, 200)}`);
    assert(text.includes('Risparmio'), 'manca il KPI Risparmio');
    assert(text.includes('Risparmio'), 'manca il KPI Risparmio');
    assert(text.includes('gennaio'), 'manca il periodo');
    screen.node.remove();
  });

  await test('un mese senza spese non esplode', () => {
    const screen = createSummaryScreen(fakeApp);
    document.body.append(screen.node);
    screen.setMonth('2026-12');
    assert(screen.node.textContent.length > 0);
    screen.node.remove();
  });

  await test('navigare fuori dall\'anno caricato lo dice invece di mostrare zeri', () => {
    const screen = createSummaryScreen(fakeApp);
    document.body.append(screen.node);
    screen.setMonth('2025-06');
    assert(screen.node.textContent.includes('non è caricato'), 'mostrerebbe zeri come se fossero dati');
    screen.node.remove();
  });

  await test('le Impostazioni si disegnano con entrate e canoni', () => {
    const sheet = createSettingsSheet(fakeApp);
    document.body.append(sheet.node);
    sheet.open();
    const text = sheet.node.textContent;
    for (const expected of ['Anno', 'Backup', 'Importa dati', 'Dispositivo']) {
      assert(text.includes(expected), `manca "${expected}"`);
    }
    // Entrate e canoni hanno ora un posto proprio: qui non devono piu esserci.
    assert(!text.includes('Stipendio'), 'le entrate sono ancora nelle impostazioni');
    assert(!text.includes('Canoni ricorrenti'), 'i canoni sono ancora nelle impostazioni');
    sheet.node.close();
    sheet.node.remove();
  });


  // ===================== zip ed export =====================================
  suite('export xlsx');

  // Lettore ZIP indipendente da zip.js: se scrittore e lettore condividessero
  // il codice, un errore di formato passerebbe inosservato. Qui si parte
  // dall'end-of-central-directory, come fa un lettore vero.
  function readZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('end of central directory non trovato');

    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const entries = new Map();
    const decoder = new TextDecoder();

    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== 0x02014B50) throw new Error(`central header ${i} corrotto`);
      const crc = view.getUint32(offset + 16, true);
      const size = view.getUint32(offset + 24, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));

      if (view.getUint32(localOffset, true) !== 0x04034B50) throw new Error(`local header di ${name} corrotto`);
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const data = bytes.subarray(dataStart, dataStart + size);

      entries.set(name, { data, crc, text: decoder.decode(data) });
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  const crc32 = (bytes) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c ^= bytes[i];
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  };

  const zipBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

  await test('lo ZIP è rileggibile e i CRC tornano', async () => {
    const blob = makeZip([
      { name: 'a.txt', data: 'ciao' },
      { name: 'dir/b.xml', data: '<x>àèì €</x>' },
      { name: 'vuoto.txt', data: '' },
    ]);
    const entries = readZip(await zipBytes(blob));
    eq([...entries.keys()], ['a.txt', 'dir/b.xml', 'vuoto.txt']);
    eq(entries.get('a.txt').text, 'ciao');
    eq(entries.get('dir/b.xml').text, '<x>àèì €</x>');
    eq(entries.get('vuoto.txt').text, '');
    for (const [name, entry] of entries) {
      eq(crc32(entry.data), entry.crc, `CRC di ${name}`);
    }
  });

  // Workbook di prova con i dati dell'Excel reale.
  const wbMeta = {
    categories: SEED_CATEGORIES,
    recurring: [
      { category: 'spotify', amount: 20.99, from: '2026-01', to: null },
      { category: 'palestra', amount: 30, from: '2026-05', to: null },
    ],
    income: [{ month: '2026-01', source: 'stipendio', amount: 1800 }],
  };
  const wbTx = [
    { id: 'A', month: '2026-01', category: 'viaggi', detail: 'autogrill', amount: 12.1, note: 'Ovindoli', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'B', month: '2026-01', category: 'caffe', detail: 'caffè & <co>', amount: 1.2, createdAt: '2026-01-02T00:00:00Z' },
  ];
  const wb = readZip(await zipBytes(buildWorkbook(wbTx, wbMeta, 2026)));

  await test('il pacchetto contiene tutte le parti che Excel si aspetta', () => {
    const names = [...wb.keys()];
    for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
                            'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) {
      assert(names.includes(required), `manca ${required}`);
    }
    // 13 fogli: il master + tutti e 12 i mesi, anche vuoti (anomalie E ed F).
    eq(names.filter((n) => n.startsWith('xl/worksheets/')).length, 13);
  });

  await test('i CRC di tutte le parti tornano', () => {
    for (const [name, entry] of wb) eq(crc32(entry.data), entry.crc, `CRC di ${name}`);
  });

  await test('fullCalcOnLoad attivo e 13 fogli dichiarati', () => {
    const workbook = wb.get('xl/workbook.xml').text;
    // Le formule sono scritte senza valore in cache: senza ricalcolo
    // all'apertura alcuni visualizzatori mostrerebbero 0.
    assert(workbook.includes('fullCalcOnLoad="1"'), 'manca fullCalcOnLoad');
    eq((workbook.match(/<sheet /g) ?? []).length, 13);
    assert(workbook.includes('name="Bilancio 2026"'));
    assert(workbook.includes('name="Spese gennaio"'));
    assert(workbook.includes('name="Spese dicembre"'));
  });

  await test('formule del master: range ampi e uniformi (anomalia C)', () => {
    const master = wb.get('xl/worksheets/sheet1.xml').text;
    // Nel file originale ogni mese aveva un limite diverso fissato a mano.
    assert(master.includes("SUMIF(&apos;Spese gennaio&apos;!$A$2:$A$500,$A2,&apos;Spese gennaio&apos;!$C$2:$C$500)"),
      'formula di gennaio inattesa');
    assert(!/\$A\$2:\$A\$(64|52|61|58|71)\b/.test(master), 'range hardcoded rimasti');
    // Un solo range per tutti e 12 i mesi × 19 categorie.
    eq((master.match(/\$A\$2:\$A\$500/g) ?? []).length, 19 * 12);
  });

  await test('il canone si somma ed è leggibile nella formula (D3)', () => {
    const master = wb.get('xl/worksheets/sheet1.xml').text;
    assert(master.includes('20.99+SUMIF'), 'Spotify senza canone additivo');
    // Palestra: niente canone ad aprile (colonna E), 30 da maggio (colonna F).
    assert(/<c r="F13"[^>]*><f>30\+SUMIF/.test(master), 'Palestra senza canone a maggio');
    assert(/<c r="E13"[^>]*><f>SUMIF/.test(master), 'Palestra non dovrebbe avere canone ad aprile');
  });

  await test('geometria del master identica all\'originale', () => {
    const master = wb.get('xl/worksheets/sheet1.xml').text;
    assert(master.includes('<f>SUM(B2:B20)</f>'), 'riga TOTALE spese non è la 21');
    assert(master.includes('<f>SUM(B26:B29)</f>'), 'riga TOTALE entrate non è la 30');
    assert(master.includes('<f>B30-B21</f>'), 'Risparmio non è entrate meno spese');
    assert(master.includes('>ENTRATE<'), 'manca la tabella ENTRATE');
    assert(master.includes('>BILANCIO<'), 'manca la tabella BILANCIO');
  });

  await test('fogli mensili: header uniforme, importi NUMERICI, XML escapato', () => {
    const gennaio = wb.get('xl/worksheets/sheet2.xml').text;
    // Header uguale su tutti i mesi (risolve l'anomalia B di aprile).
    assert(gennaio.includes('>Categoria<') && gennaio.includes('>Dettaglio<')
      && gennaio.includes('>Euro<') && gennaio.includes('>Nota<'), 'header non uniforme');
    // L'importo è un numero, non una stringa: è l'anomalia A resa impossibile.
    assert(/<c r="C2" s="1"><v>12\.1<\/v><\/c>/.test(gennaio), 'importo non numerico');
    assert(!gennaio.includes('t="inlineStr"><is><t xml:space="preserve">12.1'), 'importo salvato come testo');
    assert(gennaio.includes('caffè &amp; &lt;co&gt;'), 'XML non escapato');
    assert(gennaio.includes('>Ovindoli<'), 'nota persa');
    // Aprile senza transazioni: esiste comunque, col solo header.
    const aprile = wb.get('xl/worksheets/sheet5.xml').text;
    assert(aprile.includes('>Categoria<') && !aprile.includes('<row r="2">'), 'aprile non vuoto');
  });

  await test('le etichette con caratteri particolari restano identiche', () => {
    // La SUMIF confronta stringhe: se "Caffè" o "Mazda SH"
    // differiscono fra master e foglio mensile, il totale resta a zero.
    const master = wb.get('xl/worksheets/sheet1.xml').text;
    const gennaio = wb.get('xl/worksheets/sheet2.xml').text;
    assert(master.includes('>Caffè<'), 'etichetta Caffè alterata nel master');
    assert(gennaio.includes('>Caffè<'), 'etichetta Caffè alterata nel foglio mensile');
    assert(master.includes('>Mazda SH<'));
  });


  await test('i Movimenti elencano le spese del mese col totale', () => {
    const screen = createMovementsScreen(fakeApp);
    document.body.append(screen.node);
    screen.render();
    const text = screen.node.textContent;
    assert(text.includes('Esporta Excel'), 'manca il pulsante di export');
    assert(text.includes('movimenti') || text.includes('movimento'), 'manca il conteggio');
    screen.node.remove();
  });


  // ===================== import (fase 3) ===================================
  suite('import');

  await test('importa meta e mesi, poi rilegge tutto cifrato', async () => {
    const { store, repo, key, salt } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);

    await store.importMeta({
      schemaVersion: 1, year: 2026, updatedAt: '2026-01-01T00:00:00Z',
      categories: SEED_CATEGORIES,
      recurring: [{ category: 'spotify', amount: 20.99, from: '2026-01', to: null }],
      income: [{ month: '2026-01', source: 'stipendio', amount: 1800 }],
      noteSuggestions: ['Ovindoli', 'Madonna'],
    });
    await store.importMonth({
      schemaVersion: 1, month: '2026-01', updatedAt: '2026-01-01T00:00:00Z',
      transactions: [
        { id: 'X1', month: '2026-01', category: 'viaggi', detail: 'autogrill', amount: 12.1, note: 'Ovindoli', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'X2', month: '2026-01', category: 'caffe', detail: 'caffe', amount: 1.2, createdAt: '2026-01-01T00:00:00Z' },
      ],
    });

    // Un secondo dispositivo deve vedere esattamente le stesse cose.
    const other = new Store({ client: store.client, key, salt });
    const { meta, transactions } = await other.loadYear(2026);
    eq(transactions.length, 2);
    eq(M.sumAmounts(transactions.map((t) => t.amount)), 13.3);
    eq(meta.noteSuggestions, ['Ovindoli', 'Madonna']);
    eq(meta.income[0].amount, 1800);

    const raw = repo.files.get('data/2026/2026-01.json').text;
    assert(!raw.includes('autogrill'), 'i dati importati sono in chiaro su GitHub!');
  });

  await test('l\'import sostituisce il mese, non ci accoda', async () => {
    const { store } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    await store.addTransaction({ month: '2026-01', category: 'casa', detail: 'vecchia', amount: 99 });
    await store.importMonth({
      schemaVersion: 1, month: '2026-01', updatedAt: '2026-01-01T00:00:00Z',
      transactions: [{ id: 'N1', month: '2026-01', category: 'casa', detail: 'nuova', amount: 5, createdAt: '2026-01-01T00:00:00Z' }],
    });
    eq(store.transactionsOf('2026-01').map((t) => t.detail), ['nuova']);
  });

  await test('un file malformato viene rifiutato prima di scrivere', async () => {
    const { store } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    await throwsWith(() => store.importMonth({ schemaVersion: 99, month: '2026-01', transactions: [] }), FormatError);
    await throwsWith(() => store.importMonth({ schemaVersion: 1, month: '2026-01' }), FormatError);
  });


  await test('la griglia disegna 19 categorie + la tessera Canoni', () => {
    const screen = createEntryScreen(fakeApp);
    document.body.append(screen.node);
    screen.render();
    const tiles = screen.node.querySelectorAll('.cat-tile');
    eq(tiles.length, 20, 'la griglia 4x5 deve essere piena');
    eq(screen.node.querySelectorAll('.cat-tile.special').length, 1);
    assert([...tiles].at(-1).textContent.includes('Canoni'), 'la tessera Canoni deve essere l\'ultima');
    screen.node.remove();
  });

  await test('la tessera Canoni apre i canoni, non il foglio della spesa', () => {
    const screen = createEntryScreen(fakeApp);
    document.body.append(screen.node);
    screen.render();
    screen.node.querySelector('.cat-tile.special').click();
    const sheets = [...screen.node.querySelectorAll('dialog')];
    const aperto = sheets.find((d) => d.open);
    assert(aperto, 'nessun pannello aperto');
    assert(aperto.textContent.includes('Canoni ricorrenti'), 'ha aperto il pannello sbagliato');
    aperto.close();
    screen.node.remove();
  });

  await test('toccare sopra il pannello lo chiude', () => {
    const screen = createEntryScreen(fakeApp);
    document.body.append(screen.node);
    screen.render();
    screen.node.querySelector('.cat-tile').click();
    const dialog = screen.node.querySelector('dialog.sheet');
    assert(dialog.open, 'il pannello non si e aperto');
    // Il fondale e' il dialog stesso: un click su di lui, non sul contenuto.
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert(!dialog.open, 'toccare il fondale non chiude');
    screen.node.remove();
  });

  await test('il popup della nuova spesa si apre al tap sulla tessera', () => {
    const screen = createEntryScreen(fakeApp);
    document.body.append(screen.node);
    screen.render();
    const dialog = screen.node.querySelector('dialog.sheet');
    assert(dialog, 'il dialog non esiste nel DOM');
    assert(!dialog.open, 'il dialog risulta gia aperto');

    screen.node.querySelector('.cat-tile').click();

    assert(dialog.open, 'il tap sulla tessera non apre il popup');
    assert(dialog.querySelector('.keypad'), 'manca il tastierino');
    assert(dialog.textContent.includes('Registra'), 'manca il pulsante di conferma');
    dialog.close();
    screen.node.remove();
  });

  await test('il popup resta apribile dopo un cambio di schermata', () => {
    // render() stacca e riattacca la schermata: un dialog rimosso dal DOM
    // perde lo stato modale, e riaprirlo deve continuare a funzionare.
    const screen = createEntryScreen(fakeApp);
    const host = el('div');
    document.body.append(host);
    host.append(screen.node);
    screen.render();
    screen.node.querySelector('.cat-tile').click();
    const dialog = screen.node.querySelector('dialog.sheet');
    dialog.close();

    screen.node.remove();      // cambio tab
    host.append(screen.node);  // ritorno
    screen.render();
    screen.node.querySelector('.cat-tile').click();
    assert(dialog.open, 'dopo un cambio di schermata il popup non si riapre');
    dialog.close();
    host.remove();
  });


  // Le misure hanno senso solo con un viewport vero: in un pannello collassato
  // il guscio vale zero e qualunque geometria risulta sbagliata. Un test che
  // non puo' girare deve dirlo, non dichiarare rotto il codice.
  const viewportUsabile = window.innerHeight >= 300 && window.innerWidth >= 200;
  const saltaSenzaViewport = (nome) => {
    if (viewportUsabile) return false;
    results.push({
      suite: currentSuite, ok: true, info: true,
      name: `→ ${nome}: saltato, viewport ${window.innerWidth}×${window.innerHeight}`,
    });
    return true;
  };

  // Il CSS vero serve per misurare: questo bug era geometrico, non logico.
  const appCssLoaded = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '../css/app.css';
    link.onload = resolve;
    link.onerror = resolve;
    document.head.append(link);
  });

  await test('il popup è VISIBILE e ancorato in basso, non solo aperto', async () => {
    // Regressione: la UA impone `height: fit-content` sui dialog. Con tutti i
    // figli in position:absolute il dialog collassava a 0 e il pannello,
    // ancorato con bottom:0, finiva sopra il bordo dello schermo. `dialog.open`
    // era true lo stesso: da qui la misura invece del solo stato.
    if (saltaSenzaViewport('geometria del popup')) return;
    await appCssLoaded;
    const screen = createEntryScreen(fakeApp);
    const shell = el('div', { class: 'app' }, [
      el('header', { class: 'topbar' }),
      el('div', { class: 'screen-host' }, [screen.node]),
      el('nav', { class: 'tabbar' }),
    ]);
    document.body.append(shell);
    screen.render();
    screen.node.querySelector('.cat-tile').click();

    const dialog = screen.node.querySelector('dialog.sheet');
    const inner = dialog.querySelector('.sheet-inner');
    // L'animazione di risalita parte da translateY(100%): va neutralizzata,
    // altrimenti si misura il fotogramma iniziale.
    inner.style.animation = 'none';
    const box = inner.getBoundingClientRect();

    assert(dialog.getBoundingClientRect().height > 0, 'il dialog è collassato a zero');
    assert(box.height > 100, `pannello troppo basso: ${box.height}px`);
    assert(box.top >= -1, `il pannello esce dallo schermo in alto: top ${box.top}`);
    assert(Math.abs(box.bottom - window.innerHeight) < 2,
      `non ancorato in basso: bottom ${box.bottom} vs viewport ${window.innerHeight}`);

    dialog.close();
    shell.remove();
  });

  await test('anche le Impostazioni riempiono lo schermo', async () => {
    if (saltaSenzaViewport('geometria delle impostazioni')) return;
    await appCssLoaded;
    const sheet = createSettingsSheet(fakeApp);
    document.body.append(sheet.node);
    sheet.open();
    const inner = sheet.node.querySelector('.sheet-full-inner');
    inner.style.animation = 'none';
    const box = inner.getBoundingClientRect();
    assert(box.height > window.innerHeight / 2, `impostazioni alte ${box.height}px`);
    assert(box.top >= -1, `escono in alto: ${box.top}`);
    sheet.node.close();
    sheet.node.remove();
  });


  // ===================== PWA ===============================================
  suite('PWA');

  const manifest = await fetch('../manifest.webmanifest').then((r) => r.json());

  await test('il manifest ha i campi che servono per installarla', () => {
    eq(manifest.display, 'standalone');
    eq(manifest.name, 'PrjSpesa');
    assert(manifest.theme_color && manifest.background_color, 'mancano i colori');
    // start_url e scope RELATIVI: su GitHub Pages l'app non sta alla radice
    // del dominio, e un percorso assoluto romperebbe l'installazione — è
    // l'errore piu comune nelle PWA servite da sottocartella.
    eq(manifest.start_url, './');
    eq(manifest.scope, './');
  });

  await test('le icone dichiarate esistono e hanno le dimensioni giuste', async () => {
    assert(manifest.icons.length >= 2, 'servono almeno 192 e 512');
    for (const icon of manifest.icons) {
      const bytes = new Uint8Array(await fetch(`../${icon.src}`).then((r) => r.arrayBuffer()));
      assert(bytes.length > 0, `${icon.src} vuota`);
      // Firma PNG + dimensioni dall'header IHDR.
      eq([...bytes.slice(0, 4)], [0x89, 0x50, 0x4E, 0x47], `${icon.src} non e un PNG`);
      const view = new DataView(bytes.buffer);
      const declared = Number(icon.sizes.split('x')[0]);
      eq(view.getUint32(16), declared, `${icon.src}: larghezza`);
      eq(view.getUint32(20), declared, `${icon.src}: altezza`);
      assert(icon.purpose.includes('maskable'), `${icon.src} non e maskable`);
    }
  });

  await test('l\'icona che usa iOS esiste (il manifest non gli basta)', async () => {
    const response = await fetch('../icons/icon-180.png');
    assert(response.ok, 'apple-touch-icon mancante');
    const bytes = new Uint8Array(await response.arrayBuffer());
    eq(new DataView(bytes.buffer).getUint32(16), 180);
  });

  await test('lo zoom è disattivato: è un\'app, non un documento', async () => {
    // Due gesti diversi, due meccanismi diversi, e servono entrambi: il meta
    // viewport ferma la pinch (in standalone, l'unico posto in cui Safari lo
    // rispetta), touch-action ferma il doppio tocco anche in una scheda.
    const html = await fetch('../index.html').then((r) => r.text());
    const viewport = html.match(/name="viewport"\s+content="([^"]+)"/)?.[1] ?? '';
    assert(viewport.includes('user-scalable=no'), 'il viewport permette ancora lo zoom');
    assert(viewport.includes('viewport-fit=cover'), 'senza cover le safe-area tornano a zero');

    // Misurato, non cercato nel sorgente: quello che conta e' il valore
    // calcolato dal browser dopo tutta la cascata. Si guarda cosa CONCEDE e
    // cosa no, non la stringa esatta, che ogni motore serializza a modo suo.
    await appCssLoaded;
    const touch = getComputedStyle(document.body).touchAction;
    assert(touch.includes('pan-x') && touch.includes('pan-y'),
      `scorrimento bloccato: touch-action = ${touch}`);
    assert(!/auto|manipulation|pinch-zoom/.test(touch),
      `zoom ancora concesso: touch-action = ${touch}`);
  });

  await test('il service worker non mette MAI in cache i dati', async () => {
    // Verifica sul sorgente: il comportamento a runtime dipende dal ciclo di
    // vita del worker, ma la regola dev'essere sempre presente e prima di
    // qualunque scrittura in cache.
    const source = await fetch('../sw.js').then((r) => r.text());
    const bypass = source.indexOf("hostname === 'api.github.com'");
    const firstPut = source.indexOf('cache.put');
    assert(bypass > 0, 'manca il bypass per api.github.com');
    assert(bypass < firstPut, 'il bypass dei dati deve precedere ogni cache.put');
  });


  // ===================== multi-anno (fase 8) ===============================
  suite('multi-anno');

  await test('un anno chiuso rifiuta OGNI scrittura', async () => {
    const { store } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    const tx = await store.addTransaction({ month: '2026-03', category: 'casa', detail: 'x', amount: 10 });

    await store.setLocked(true);

    await throwsWith(() => store.addTransaction({ month: '2026-03', category: 'casa', detail: 'y', amount: 5 }), ValidationError);
    await throwsWith(() => store.updateTransaction(tx.id, { amount: 99 }), ValidationError);
    await throwsWith(() => store.deleteTransaction(tx.id), ValidationError);
    await throwsWith(() => store.setIncome('2026-03', 'stipendio', 100), ValidationError);
    await throwsWith(() => store.setRecurring([]), ValidationError);
    await throwsWith(() => store.importMonth({ schemaVersion: 1, month: '2026-03', transactions: [] }), ValidationError);

    // Il dato però resta leggibile.
    eq(store.transactions.length, 1);
  });

  await test('riaprendolo si torna a scrivere', async () => {
    const { store } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    await store.setLocked(true);
    await throwsWith(() => store.addTransaction({ month: '2026-03', category: 'casa', amount: 1 }), ValidationError);
    await store.setLocked(false);
    await store.addTransaction({ month: '2026-03', category: 'casa', detail: 'ok', amount: 1 });
    eq(store.transactions.length, 1);
  });

  await test('il blocco vive nei dati, quindi vale su ogni dispositivo', async () => {
    const { store, key, salt } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    await store.setLocked(true);

    const other = new Store({ client: store.client, key, salt });
    await other.loadYear(2026);
    eq(other.meta.locked, true);
    await throwsWith(() => other.addTransaction({ month: '2026-03', category: 'casa', amount: 1 }), ValidationError);
  });

  await test('sfogliare un anno inesistente NON lo crea', async () => {
    const { store, repo } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    const before = [...repo.files.keys()];

    eq(await store.loadYearIfExists(2024), false);
    eq([...repo.files.keys()], before, 'ha creato file per un anno solo sfogliato');
  });

  await test('rollover: il primo inserimento del 2027 crea l\'anno', async () => {
    const { store, repo, key, salt } = await freshStore();
    await store.ensureMeta(2026);
    await store.setRecurring([{ category: 'spotify', amount: 20.99, from: '2026-01', to: null }]);
    await store.loadYear(2026);

    // È quel che fa app.addTransaction quando il mese è di un altro anno.
    await store.ensureMeta(2027);
    await store.loadYear(2027);
    await store.addTransaction({ month: '2027-01', category: 'caffe', detail: 'primo', amount: 1.2 });

    assert(repo.files.has('data/2027/meta.json'), 'meta del 2027 non creato');
    assert(repo.files.has('data/2027/2027-01.json'), 'file mensile non creato');
    eq(store.meta.recurring.map((r) => r.from), ['2027-01'], 'i canoni non sono stati riportati');
    eq(await store.client.listYears('data'), [2027, 2026]);
  });


  // ===================== sicurezza della UI ================================
  suite('sicurezza UI');

  await test('un dettaglio ostile resta TESTO, non diventa markup', async () => {
    const ostile = '<img src=x onerror="window.__pwned=1">';
    const app2 = {
      year: 2026, refresh() {},
      store: {
        year: 2026, meta: excelMeta,
        transactions: [{ id: 'H1', month: '2026-01', category: 'casa', detail: ostile, amount: 5, note: ostile, createdAt: '2026-01-01T00:00:00Z' }],
        // Qualunque mese: la schermata parte da quello corrente, e un test
        // che non disegna nessuna riga passerebbe a vuoto.
        transactionsOf: () => [{ id: 'H1', month: '2026-01', category: 'casa', detail: ostile, amount: 5, note: ostile, createdAt: '2026-01-01T00:00:00Z' }],
      },
    };
    delete window.__pwned;
    const screen = createMovementsScreen(app2);
    document.body.append(screen.node);
    screen.render();
    await new Promise((r) => setTimeout(r, 60));

    eq(window.__pwned, undefined, 'il markup dell\'utente è stato eseguito');
    eq(screen.node.querySelectorAll('img').length, 0, 'un tag dell\'utente è finito nel DOM');
    assert(screen.node.textContent.includes('onerror'), 'il testo dovrebbe comparire come testo');
    screen.node.remove();
  });

  await test('un id categoria ostile non inietta markup', () => {
    // L'id arriva dai dati decifrati: una chiave ereditata come "constructor"
    // restituirebbe qualcosa che non è un'icona, e finirebbe in innerHTML.
    for (const id of ['constructor', '__proto__', 'toString', 'valueOf', 'inesistente']) {
      const svg = categoryIconFn(id);
      assert(svg.startsWith('<svg '), `id "${id}" ha prodotto: ${svg.slice(0, 60)}`);
      assert(svg.endsWith('</svg>'), `id "${id}" non chiude l'svg`);
      assert(!svg.includes('function'), `id "${id}" ha iniettato del codice`);
    }
    eq(hasCategoryIcon('constructor'), false);
    eq(hasCategoryIcon('caffe'), true);
  });

  await test('il CSP blocca le connessioni fuori da GitHub', async () => {
    const meta = await fetch('../index.html').then((r) => r.text());
    const csp = meta.match(/Content-Security-Policy"\s*\n?\s*content="([^"]+)"/)?.[1] ?? '';
    assert(csp.includes("default-src 'self'"), 'manca default-src');
    assert(csp.includes('connect-src') && csp.includes('https://api.github.com'),
      'connect-src deve limitare le connessioni all\'API dei dati');
    assert(!csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'"),
      'il CSP non deve permettere script inline: è ciò che protegge il token');
  });


  // ===================== import dalla UI ===================================
  suite('import dalla UI');

  const waitFor = async (check, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  await test('scegliere i file e premere Importa carica davvero', async () => {
    const { store } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);

    const sheet = createSettingsSheet({ year: 2026, store, refresh() {} });
    document.body.append(sheet.node);
    sheet.open();

    const input = sheet.node.querySelector('input[type=file]');
    assert(input, 'nessun selettore di file nella schermata');

    const metaFile = {
      schemaVersion: 1, year: 2026, updatedAt: '2026-01-01T00:00:00Z',
      categories: SEED_CATEGORIES, recurring: [], income: [], noteSuggestions: ['Ovindoli'],
    };
    const monthFile = {
      schemaVersion: 1, month: '2026-01', updatedAt: '2026-01-01T00:00:00Z',
      transactions: [
        { id: 'I1', month: '2026-01', category: 'caffe', detail: 'a', amount: 1.2, createdAt: '2026-01-01T00:00:00Z' },
        { id: 'I2', month: '2026-01', category: 'svago', detail: 'b', amount: 9, createdAt: '2026-01-01T00:00:00Z' },
      ],
    };
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(metaFile)], 'meta.json', { type: 'application/json' }));
    transfer.items.add(new File([JSON.stringify(monthFile)], '2026-01.json', { type: 'application/json' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
    eq(input.files.length, 2, 'i file non risultano selezionati');

    const button = [...sheet.node.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Importa');
    assert(button, 'nessun pulsante Importa');

    const realConfirm = window.confirm;
    window.confirm = () => true;
    let statusText = '';
    try {
      button.click();
      await waitFor(() => store.transactions.length > 0);
      statusText = sheet.node.querySelector('.status')?.textContent ?? '';
    } finally {
      window.confirm = realConfirm;
    }

    eq(store.transactions.length, 2, `nessuna transazione importata. Stato: "${statusText}"`);
    eq(M.sumAmounts(store.transactions.map((t) => t.amount)), 10.2);
    eq(store.meta.noteSuggestions, ['Ovindoli']);
    sheet.node.close();
    sheet.node.remove();
  });


  await test('la selezione dei file sopravvive a un ridisegno della schermata', async () => {
    // Regressione: leggendo input.files al momento del click, qualunque
    // ridisegno (per esempio dopo aver toccato un'entrata) sostituiva
    // l'elemento e la selezione spariva senza dirlo.
    const { store } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    const sheet = createSettingsSheet({ year: 2026, store, refresh() {} });
    document.body.append(sheet.node);
    sheet.open();

    const input = sheet.node.querySelector('input[type=file]');
    const transfer = new DataTransfer();
    transfer.items.add(new File(['{"schemaVersion":1,"month":"2026-02","transactions":[]}'], '2026-02.json'));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));

    const button = [...sheet.node.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Importa');
    eq(button.disabled, false, 'il pulsante resta disabilitato dopo la scelta');
    assert(sheet.node.textContent.includes('2026-02.json'), 'la schermata non conferma quali file hai scelto');
    sheet.node.close();
    sheet.node.remove();
  });

  await test('caricare un anno non spara 404 per i mesi inesistenti', async () => {
    const { store, repo } = await freshStore();
    await store.ensureMeta(2026);
    await store.loadYear(2026);
    await store.addTransaction({ month: '2026-03', category: 'casa', detail: 'x', amount: 1 });

    const before = repo.getCount ?? 0;
    repo.gets = [];
    const other = new Store({ client: store.client, key: store.key, salt: store.salt });
    await other.loadYear(2026);

    // Un solo mese esiste: non devono partire dodici letture.
    const monthReads = repo.gets.filter((p) => /\d{4}-\d{2}\.json$/.test(p));
    eq(monthReads.sort(), ['data/2026/2026-03.json'], `letture inattese: ${monthReads}`);
    eq(other.transactions.length, 1);
  });


  await test('la schermata Entrate elenca le 4 voci e i 12 mesi', () => {
    const screen = createIncomeScreen(fakeApp);
    document.body.append(screen.node);
    screen.render();
    const text = screen.node.textContent;
    for (const voce of ['Stipendio', 'Buoni Pasto', 'Checco', 'Altro']) {
      assert(text.includes(voce), `manca la voce ${voce}`);
    }
    assert(text.includes('gennaio') && text.includes('dicembre'), 'manca il riepilogo annuale');
    eq(screen.node.querySelectorAll('input[inputmode=decimal]').length, 4);
    screen.node.remove();
  });


  await test('ogni icona chiesta per nome esiste davvero', async () => {
    // Un nome sbagliato cade sul fallback e a schermo sembra una scelta di
    // design: e' cosi che l'intestazione dei Canoni si era ritrovata due X.
    const sorgenti = await Promise.all(['recurring', 'app', 'screen-entry', 'screen-summary',
      'screen-movements', 'screen-settings', 'screen-income', 'keypad']
      .map((m) => fetch(`../js/${m}.js`).then((r) => r.text())));
    const { uiIcon: ui } = await import('../js/icons.js');
    const fallback = ui('__inesistente__');
    const mancanti = [];
    for (const src of sorgenti) {
      for (const [, nome] of src.matchAll(/uiIcon\('([^']+)'\)/g)) {
        if (ui(nome) === fallback && nome !== 'close') mancanti.push(nome);
      }
    }
    eq([...new Set(mancanti)], [], 'icone chieste per nome ma inesistenti');
  });


  await test('le etichette seguono l\'app, non il file salvato', () => {
    // L'id e' la chiave e non si tocca; la label e' solo cio' che si legge.
    // Nessun punto dell'interfaccia rinomina una categoria, quindi
    // un'etichetta memorizzata e' sempre una copia di quella spedita con
    // l'app: se differisce, e' perche' l'app e' stata aggiornata.
    const salvate = [
      { id: 'manutenzione_mazda_sh', label: 'Manutenzione Mazda/SH', order: 14 },
      { id: 'caffe', label: 'Caffè', order: 15 },
      { id: 'una_mia_categoria', label: 'Una mia categoria', order: 20 },
    ];
    const allineate = M.syncCategoryLabels(salvate);
    eq(allineate[0].label, 'Mazda SH', 'etichetta non aggiornata');
    eq(allineate[0].id, 'manutenzione_mazda_sh', 'l\'id non deve cambiare mai');
    eq(allineate[0].order, 14, 'il resto del record resta');
    eq(allineate[1].label, 'Caffè');
    eq(allineate[2].label, 'Una mia categoria', 'le categorie non note vanno lasciate stare');
  });

  // ===================== costo reale =======================================
  suite('prestazioni');

  await test(`costo PBKDF2 reale (${PBKDF2_ITERATIONS.toLocaleString('it-IT')} iterazioni)`, async () => {
    const t0 = performance.now();
    await C.deriveKey('passphrase', C.randomBytes(16), PBKDF2_ITERATIONS);
    const ms = Math.round(performance.now() - t0);
    results.push({ suite: 'prestazioni', name: `→ derivazione: ${ms} ms`, ok: true, info: true });
    assert(ms < 10000, `troppo lento: ${ms} ms`);
  });

  return results;
}

// --- Output ------------------------------------------------------------------

const out = document.getElementById('out');
const summary = document.getElementById('summary');

run().then((res) => {
  const failed = res.filter((r) => !r.ok);
  const bySuite = new Map();
  for (const r of res) {
    if (!bySuite.has(r.suite)) bySuite.set(r.suite, []);
    bySuite.get(r.suite).push(r);
  }
  let html = '';
  for (const [name, tests] of bySuite) {
    html += `<h2>${name}</h2><ul>`;
    for (const t of tests) {
      const icon = t.info ? '·' : t.ok ? '✅' : '❌';
      const cls = t.ok ? 'ok' : 'ko';
      html += `<li class="${cls}">${icon} ${escapeHtml(t.name)}`;
      if (t.error) html += `<div class="err">${escapeHtml(t.error)}</div>`;
      html += '</li>';
    }
    html += '</ul>';
  }
  out.innerHTML = html;
  summary.textContent = failed.length === 0
    ? `✅ ${res.filter((r) => !r.info).length} test superati`
    : `❌ ${failed.length} test falliti su ${res.filter((r) => !r.info).length}`;
  summary.className = failed.length === 0 ? 'ok' : 'ko';

  // Per la lettura automatica da strumenti esterni.
  window.__selftest = { total: res.filter((r) => !r.info).length, failed, results: res };
  document.title = failed.length === 0 ? 'SELFTEST PASS' : `SELFTEST FAIL (${failed.length})`;
}).catch((err) => {
  summary.textContent = `💥 la suite è esplosa: ${err.name}: ${err.message}`;
  summary.className = 'ko';
  window.__selftest = { crashed: `${err.name}: ${err.message}`, stack: err.stack };
  document.title = 'SELFTEST CRASH';
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
