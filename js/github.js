// Client della Contents API di GitHub.
//
// Due scelte non ovvie, entrambe dovute a come si comporta l'API:
//
// 1. Le letture usano Accept: application/vnd.github+json, non .raw. La
//    risposta .raw dà il contenuto ma NON lo sha, che è obbligatorio per la
//    PUT successiva: servirebbe una seconda richiesta a ogni scrittura.
//
// 2. Dopo una PUT si tiene lo sha restituito dalla risposta, senza rileggere.
//    Le risposte della Contents API passano da una CDN e una GET subito dopo
//    una PUT può restituire ancora la versione precedente.

import { toBase64, fromBase64 } from './crypto.js';
import { GitHubError, KIND } from './errors.js';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class GitHubClient {
  #queue = Promise.resolve();

  /**
   * @param {object} opts
   * @param {string} opts.owner
   * @param {string} opts.repo
   * @param {string} opts.token
   * @param {typeof fetch} [opts.fetchImpl] iniettabile per i test
   */
  constructor({ owner, repo, token, fetchImpl }) {
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
  }

  /** "owner/repo" → client. Accetta anche l'URL completo del repo. */
  static fromSlug(slug, token, fetchImpl) {
    const clean = String(slug).trim()
      .replace(/^https?:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
      .replace(/^\/+|\/+$/g, '');
    const [owner, repo] = clean.split('/');
    if (!owner || !repo) {
      throw new GitHubError(`Repo non valido: "${slug}" (atteso "owner/repo")`, { kind: KIND.UNKNOWN });
    }
    return new GitHubClient({ owner, repo, token, fetchImpl });
  }

  #url(path) {
    const clean = String(path).replace(/^\/+/, '');
    // Ogni segmento va codificato, ma le barre restano separatori.
    const encoded = clean.split('/').map(encodeURIComponent).join('/');
    return `${API}/repos/${this.owner}/${this.repo}/contents/${encoded}`;
  }

  #headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      ...extra,
    };
  }

  async #request(url, options, path) {
    let response;
    try {
      response = await this.fetchImpl(url, options);
    } catch (cause) {
      throw new GitHubError('Nessuna connessione a GitHub', { kind: KIND.NETWORK, path, cause });
    }
    if (response.ok) return response.json();
    throw await describeFailure(response, path);
  }

  /**
   * @returns {Promise<{text: string, sha: string}>}
   * @throws {GitHubError} kind NOT_FOUND se il file non esiste. Per un mese
   *   non ancora creato è normale; per il keyring al setup significa invece
   *   repo sbagliato o token senza permessi — la distinzione la fa il chiamante.
   */
  async getFile(path) {
    const body = await this.#request(this.#url(path), { headers: this.#headers() }, path);
    if (body.type !== 'file') {
      throw new GitHubError(`"${path}" non è un file (è ${body.type})`, { kind: KIND.UNKNOWN, path });
    }
    // Il base64 di GitHub contiene a capo: fromBase64 li ripulisce.
    return { text: decoder.decode(fromBase64(body.content)), sha: body.sha };
  }

  /** Come getFile, ma restituisce l'oggetto già parsato. */
  async getJSON(path) {
    const { text, sha } = await this.getFile(path);
    return { data: JSON.parse(text), sha };
  }

  /**
   * Scrive un file. Omettere `sha` significa "crealo": GitHub crea anche le
   * cartelle mancanti, ed è così che nascono da soli il file di un mese nuovo
   * e la cartella di un anno nuovo.
   *
   * Le scritture sono serializzate (vedi #enqueue): due inserimenti rapidi
   * sullo stesso file si conflittuerebbero a vicenda, e GitHub applica un
   * limite secondario alle richieste concorrenti che scrivono.
   *
   * @returns {Promise<{sha: string}>} lo sha nuovo, da usare per la scrittura seguente
   */
  putFile(path, text, { sha = null, message } = {}) {
    return this.#enqueue(async () => {
      const payload = { message: message ?? `sync ${path}`, content: toBase64(encoder.encode(text)) };
      if (sha) payload.sha = sha;
      const body = await this.#request(this.#url(path), {
        method: 'PUT',
        headers: this.#headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      }, path);
      return { sha: body.content.sha };
    });
  }

  async deleteFile(path, sha, message) {
    return this.#enqueue(() => this.#request(this.#url(path), {
      method: 'DELETE',
      headers: this.#headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message: message ?? `sync ${path}`, sha }),
    }, path));
  }

  /** @returns {Promise<Array<{name, path, type}>>} */
  async listDir(path) {
    const body = await this.#request(this.#url(path), { headers: this.#headers() }, path);
    if (!Array.isArray(body)) {
      throw new GitHubError(`"${path}" non è una cartella`, { kind: KIND.UNKNOWN, path });
    }
    return body.map(({ name, path: p, type }) => ({ name, path: p, type }));
  }

  /**
   * Anni disponibili in data/. Filtra su type === 'dir' perché in data/ vive
   * anche crypto.json (il keyring), che altrimenti comparirebbe come un anno.
   */
  async listYears(root = 'data') {
    let entries;
    try {
      entries = await this.listDir(root);
    } catch (err) {
      if (err.kind === KIND.NOT_FOUND) return []; // repo dati ancora vuoto
      throw err;
    }
    return entries
      .filter((e) => e.type === 'dir' && /^\d{4}$/.test(e.name))
      .map((e) => Number(e.name))
      .sort((a, b) => b - a);
  }

  /** Metadati del repo. Risponde anche se il repo è vuoto. */
  async getRepo() {
    return this.#request(`${API}/repos/${this.owner}/${this.repo}`, { headers: this.#headers() }, '');
  }

  /**
   * Verifica repo + token senza toccare i dati.
   *
   * Interroga l'endpoint del REPO, non quello dei contenuti: su un repo
   * appena creato, senza nemmeno un commit, `GET /contents/` risponde 404
   * anche con un token perfettamente valido. Usarlo per il test di
   * connessione bocciava proprio il caso del primo avvio.
   */
  async testConnection() {
    try {
      const repo = await this.getRepo();
      if (repo.permissions && repo.permissions.push === false) {
        return {
          ok: false,
          kind: KIND.UNAUTHORIZED,
          message: 'Il token può leggere ma non scrivere. Serve Contents: Read and write.',
        };
      }
      return { ok: true, empty: repo.size === 0, private: repo.private };
    } catch (err) {
      if (err.kind === KIND.NOT_FOUND) {
        // Un repo privato inesistente e uno a cui il token non ha accesso
        // rispondono allo stesso modo: GitHub non conferma l'esistenza.
        return {
          ok: false,
          kind: err.kind,
          message: 'Repo non trovato: controlla owner/nome, e che il token includa questo repo.',
        };
      }
      if (err.kind === KIND.UNAUTHORIZED) {
        return { ok: false, kind: err.kind, message: 'Token non valido o scaduto.' };
      }
      return { ok: false, kind: err.kind, message: err.message };
    }
  }

  /**
   * Serializza le scritture. La coda prosegue anche se un task fallisce,
   * altrimenti un solo errore bloccherebbe tutte le scritture successive.
   */
  #enqueue(task) {
    const run = this.#queue.then(() => task());
    this.#queue = run.then(() => {}, () => {});
    return run;
  }
}

/** Traduce una risposta HTTP fallita in un errore con un rimedio preciso. */
async function describeFailure(response, path) {
  const status = response.status;
  let detail;
  try {
    detail = (await response.json())?.message;
  } catch {
    detail = undefined;
  }

  if (status === 401) {
    return new GitHubError('Token non valido, scaduto o revocato', { status, kind: KIND.UNAUTHORIZED, path, detail });
  }
  if (status === 403) {
    // Il limite primario azzera x-ratelimit-remaining; quello secondario no.
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      return new GitHubError('Limite di richieste GitHub raggiunto', {
        status, kind: KIND.RATE_LIMIT, path, detail: reset ? new Date(reset).toISOString() : detail,
      });
    }
    const retryAfter = Number(response.headers.get('retry-after')) || null;
    return new GitHubError('GitHub ha rallentato le scritture, riprova tra poco', {
      status, kind: KIND.SECONDARY_LIMIT, path, detail: retryAfter ?? detail,
    });
  }
  if (status === 404) {
    return new GitHubError(`Non trovato: ${path}`, { status, kind: KIND.NOT_FOUND, path, detail });
  }
  if (status === 409) {
    return new GitHubError('Il file è cambiato nel frattempo', { status, kind: KIND.CONFLICT, path, detail });
  }
  if (status === 422) {
    // sha mancante su file esistente, o sha non corrispondente: è un bug nostro.
    return new GitHubError('Scrittura rifiutata: sha mancante o non corrispondente', {
      status, kind: KIND.UNPROCESSABLE, path, detail,
    });
  }
  return new GitHubError(`Errore GitHub ${status}`, { status, kind: KIND.UNKNOWN, path, detail });
}

/** Un 404 su un mese non ancora creato è normale, non un errore. */
export const isNotFound = (err) => err instanceof GitHubError && err.kind === KIND.NOT_FOUND;
export const isConflict = (err) => err instanceof GitHubError && err.kind === KIND.CONFLICT;
