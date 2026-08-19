// Setup del dispositivo (F4.20). Si fa una volta per dispositivo.
//
// Ordine non negoziabile: il test di connessione precede la passphrase.
// Altrimenti un token sbagliato si manifesta come "passphrase errata", che
// manda a caccia del problema sbagliato.

import { el, toast } from './ui.js';
import { GitHubClient, isNotFound } from './github.js';
import { createKeyring, openKeyring, saveKey, requestPersistence } from './crypto.js';
import { WrongPassphraseError } from './errors.js';
import { LS_REPO, LS_TOKEN, KEYRING_PATH, PBKDF2_ITERATIONS } from './config.js';

export function createSetupScreen({ onReady }) {
  const node = el('section', { class: 'screen' });

  function renderStep1(prefill = {}) {
    const repoField = el('input', {
      class: 'field', type: 'text', placeholder: 'andrus98/spese-data',
      autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
      value: prefill.repo ?? localStorage.getItem(LS_REPO) ?? '',
    });
    const tokenField = el('input', {
      class: 'field', type: 'password', placeholder: 'github_pat_…',
      autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
    });
    const status = el('div', { class: 'status' });
    const next = el('button', { class: 'btn', type: 'button', text: 'Verifica e continua' });

    next.addEventListener('click', async () => {
      const repo = repoField.value.trim();
      const token = tokenField.value.trim();
      if (!repo || !token) { status.className = 'status ko'; status.textContent = 'Compila entrambi i campi.'; return; }

      next.disabled = true;
      status.className = 'status wait';
      status.textContent = 'Verifico l\'accesso al repo…';
      try {
        const client = GitHubClient.fromSlug(repo, token);
        const result = await client.testConnection();
        if (!result.ok) {
          status.className = 'status ko';
          status.textContent = result.message;
          return;
        }
        // Il token resta solo qui: mai nel codice, mai in un commit.
        localStorage.setItem(LS_REPO, `${client.owner}/${client.repo}`);
        localStorage.setItem(LS_TOKEN, token);
        renderStep2(client);
      } catch (err) {
        status.className = 'status ko';
        status.textContent = err.message;
      } finally {
        next.disabled = false;
      }
    });

    node.replaceChildren(el('div', { class: 'setup' }, [
      el('h2', { text: 'Collega il database' }),
      el('p', { text: 'I dati vivono cifrati in un repo privato su GitHub. Questo dispositivo ha bisogno di sapere quale, e di un token per leggerlo e scriverlo.' }),
      el('label', {}, ['Repository dati', repoField]),
      el('label', {}, ['Token GitHub (Contents: read and write)', tokenField]),
      status,
      next,
      el('p', { text: 'Il token resta in questo browser e non viene mai inviato altrove. Puoi revocarlo da GitHub in qualsiasi momento.' }),
    ]));
  }

  function renderStep2(client) {
    const passField = el('input', {
      class: 'field', type: 'password', placeholder: 'La tua passphrase',
      autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
    });
    const status = el('div', { class: 'status' });
    const confirm = el('button', { class: 'btn', type: 'button', text: 'Sblocca' });
    const intro = el('p', {});
    const warning = el('div', { class: 'warn' });

    let keyring = null;
    let firstDevice = false;

    (async () => {
      status.className = 'status wait';
      status.textContent = 'Controllo il database…';
      try {
        const { data } = await client.getJSON(KEYRING_PATH);
        keyring = data;
        firstDevice = false;
        intro.textContent = 'Il database esiste già. Inserisci la passphrase che hai usato sull\'altro dispositivo: se è sbagliata te lo dico subito, prima di scrivere qualsiasi cosa.';
        confirm.textContent = 'Sblocca';
        status.textContent = '';
      } catch (err) {
        if (!isNotFound(err)) {
          status.className = 'status ko';
          status.textContent = err.message;
          return;
        }
        firstDevice = true;
        intro.textContent = 'Database vuoto: stai configurando il primo dispositivo. La passphrase che scegli ora è l\'unica chiave dei tuoi dati.';
        confirm.textContent = 'Crea il database';
        status.textContent = '';
      }
      warning.textContent = firstDevice
        ? 'La passphrase non è recuperabile. Non viene salvata da nessuna parte: se la dimentichi, i dati restano cifrati per sempre. Salvala nel Portachiavi iCloud PRIMA di continuare.'
        : 'Se hai perso la passphrase non c\'è modo di recuperare i dati esistenti.';
    })();

    confirm.addEventListener('click', async () => {
      const passphrase = passField.value;
      if (passphrase.length < 8) {
        status.className = 'status ko';
        status.textContent = 'Almeno 8 caratteri.';
        return;
      }

      confirm.disabled = true;
      status.className = 'status wait';
      status.textContent = 'Derivo la chiave…';
      try {
        let key, salt, iterations;
        if (firstDevice) {
          const created = await createKeyring(passphrase, PBKDF2_ITERATIONS);
          await client.putFile(KEYRING_PATH, JSON.stringify(created.keyring, null, 2), { message: 'init keyring' });
          ({ key, salt } = created);
          iterations = PBKDF2_ITERATIONS;
        } else {
          ({ key, salt, iterations } = await openKeyring(keyring, passphrase));
        }

        await saveKey(key, salt, iterations);
        await requestPersistence();

        status.className = 'status ok';
        status.textContent = 'Fatto.';
        onReady({ client, key, salt });
      } catch (err) {
        status.className = 'status ko';
        status.textContent = err instanceof WrongPassphraseError
          ? 'Passphrase errata. Nessun dato è stato toccato.'
          : err.message;
      } finally {
        confirm.disabled = false;
      }
    });

    node.replaceChildren(el('div', { class: 'setup' }, [
      el('h2', { text: 'Passphrase' }),
      intro,
      warning,
      el('label', {}, ['Passphrase', passField]),
      status,
      confirm,
      el('button', {
        class: 'btn ghost', type: 'button', text: 'Indietro',
        onclick: () => renderStep1({ repo: `${client.owner}/${client.repo}` }),
      }),
    ]));
  }

  /** Storage evictato: repo e token ci sono ancora, manca solo la chiave. */
  function renderRelock(client) {
    toast('Chiave non più in memoria: reinserisci la passphrase');
    renderStep2(client);
  }

  return { node, renderStep1, renderStep2, renderRelock };
}
