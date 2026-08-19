// Errori tipizzati. Servono a distinguere i casi che hanno rimedi diversi:
// un 404 su un mese è normale, un 404 sul keyring significa repo sbagliato.

export class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.cause = options.cause;
    this.detail = options.detail;
  }
}

/** La passphrase non apre il keyring. */
export class WrongPassphraseError extends AppError {}

/** Busta cifrata con un salt diverso da quello del keyring, o manomessa. */
export class DecryptError extends AppError {}

/** Formato di file non riconosciuto (schemaVersion o format inatteso). */
export class FormatError extends AppError {}

/** Input dell'utente non valido (importo, mese, categoria). */
export class ValidationError extends AppError {}

/** Errore proveniente dall'API GitHub, con lo stato HTTP e una causa. */
export class GitHubError extends AppError {
  constructor(message, { status, kind, path, cause, detail } = {}) {
    super(message, { cause, detail });
    this.status = status;
    this.kind = kind; // vedi KIND
    this.path = path;
  }
}

// Tassonomia degli errori GitHub. Ogni voce ha un rimedio diverso, quindi
// vanno tenuti distinti invece di collassarli in "errore di rete".
export const KIND = {
  UNAUTHORIZED: 'unauthorized',   // 401 — token scaduto o revocato
  RATE_LIMIT: 'rate_limit',       // 403 con x-ratelimit-remaining: 0
  SECONDARY_LIMIT: 'secondary',   // 403 senza quell'header
  NOT_FOUND: 'not_found',         // 404 — può essere normale (mese nuovo)
  CONFLICT: 'conflict',           // 409 — sha obsoleto
  UNPROCESSABLE: 'unprocessable', // 422 — sha mancante/errato: bug nostro
  NETWORK: 'network',             // fetch fallita, offline
  UNKNOWN: 'unknown',
};
