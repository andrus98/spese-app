// Impostazioni (D15). Dietro l'ingranaggio, così la nav bar resta a tre voci.
//
// Contiene le quattro cose che non hanno posto nelle tre schermate ma senza
// cui il resto non torna: entrate (il KPI Risparmio ne dipende), canoni
// ricorrenti, export JSON e stato del dispositivo.

import { el, clear, toast, humanError, iconButton } from './ui.js';
import { uiIcon } from './icons.js';
import { clearKey } from './crypto.js';
import { LS_REPO, LS_TOKEN, APP_VERSION } from './config.js';

export function createSettingsSheet(app) {

  const body = el('div', { class: 'settings-body' });
  const dialog = el('dialog', { class: 'sheet full' }, [
    el('div', { class: 'sheet-full-inner' }, [
      el('div', { class: 'sheet-head' }, [
        el('span', { class: 'name', text: 'Impostazioni' }),
        el('button', {
          class: 'icon-btn close', type: 'button', 'aria-label': 'Chiudi',
          html: uiIcon('close'), onclick: () => dialog.close(),
        }),
      ]),
      body,
    ]),
  ]);

  function render() {
    clear(body);
    if (!app.store?.meta) {
      body.append(el('div', { class: 'empty-state', text: 'Dati non ancora caricati.' }));
      return;
    }
    body.append(yearBlock(), exportBlock(), importBlock(), updateBlock(), deviceBlock());
  }

  // --- Anno: chiusura in sola lettura (F8.3) -------------------------------

  function yearBlock() {
    const locked = Boolean(app.store.meta.locked);
    return block(`Anno ${app.store.year}`, [
      el('p', {
        class: 'hint',
        text: locked
          ? 'Anno chiuso: nessuna scrittura è possibile finché non lo riapri. Il blocco vive nei dati, quindi vale anche sull\'altro dispositivo.'
          : 'Chiudendo l\'anno lo rendi di sola lettura: utile quando è concluso, per non correggerlo per sbaglio mentre lo consulti.',
      }),
      el('button', {
        class: `btn ghost compact${locked ? '' : ' danger'}`,
        type: 'button',
        text: locked ? `Riapri il ${app.store.year}` : `Chiudi il ${app.store.year}`,
        onclick: async () => {
          const question = locked
            ? `Riaprire il ${app.store.year}? Tornera' modificabile su tutti i dispositivi.`
            : `Chiudere il ${app.store.year}?\n\nDiventa di sola lettura su tutti i dispositivi: nessuna spesa potra' essere aggiunta, corretta o cancellata finche' non lo riapri.`;
          if (!confirm(question)) return;
          try {
            await app.store.setLocked(!locked);
            app.refresh();
            render();
            toast(locked ? 'Anno riaperto' : 'Anno chiuso in sola lettura');
          } catch (err) { toast(humanError(err), 'ko'); }
        },
      }),
    ]);
  }

  // Entrate e canoni non stanno piu qui: le entrate hanno una voce propria
  // nella nav bar, i canoni una tessera nella griglia delle spese. Erano
  // sepolti fra le opzioni pur essendo dati che si consultano spesso.

  // --- Export JSON in chiaro ----------------------------------------------

  function exportBlock() {
    return block('Backup', [
      el('p', { class: 'hint', text: 'Export in chiaro di tutto l\'anno: è la garanzia di poter leggere i dati anche senza questa app. Il file NON è cifrato, quindi non lasciarlo in giro.' }),
      iconButton(uiIcon('download'), `Esporta JSON ${app.store.year}`, {
        class: 'btn ghost',
        onclick: () => {
          const payload = {
            exportedAt: new Date().toISOString(),
            year: app.store.year,
            meta: app.store.meta,
            transactions: app.store.transactions,
          };
          const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
          const link = el('a', { href: url, download: `spese-${app.store.year}.json` });
          link.click();
          URL.revokeObjectURL(url);
          toast('JSON esportato');
        },
      }),
    ]);
  }

  // --- Import una tantum (fase 3) -----------------------------------------

  function importBlock() {
    const status = el('div', { class: 'status' });
    const chosen = el('div', { class: 'hint' });
    const button = el('button', { class: 'btn ghost', type: 'button', text: 'Importa', disabled: true });

    // La selezione vive qui, non dentro l'input: qualunque ridisegno della
    // schermata sostituirebbe l'elemento e la farebbe sparire in silenzio.
    let selected = [];

    const input = el('input', {
      class: 'field', type: 'file', accept: '.json,application/json', multiple: true,
    });
    input.addEventListener('change', () => {
      selected = [...input.files];
      button.disabled = selected.length === 0;
      chosen.textContent = selected.length
        ? `Scelti: ${selected.map((f) => f.name).join(', ')}`
        : '';
      status.textContent = '';
    });

    const run = async () => {
      const files = selected;
      if (!files.length) { status.className = 'status ko'; status.textContent = 'Scegli i file.'; return; }

      // Legge e valida TUTTO prima di scrivere qualsiasi cosa: un file
      // malformato non deve lasciare l'anno mezzo importato.
      let meta = null;
      const months = [];
      try {
        for (const file of files) {
          const parsed = JSON.parse(await file.text());
          if (parsed.month) months.push(parsed);
          else if (parsed.categories) meta = parsed;
          else throw new Error(`${file.name}: non è né un mese né un meta.json`);
        }
      } catch (err) {
        status.className = 'status ko';
        status.textContent = err.message;
        return;
      }

      const count = months.reduce((acc, m) => acc + m.transactions.length, 0);
      const target = meta?.year ?? app.store.year;
      if (target !== app.store.year) {
        status.className = 'status ko';
        status.textContent = `I file sono del ${target}, ma è caricato il ${app.store.year}.`;
        return;
      }
      if (!confirm(`Importare ${count} transazioni in ${months.length} mesi${meta ? ' e sostituire meta.json' : ''}?\n\nI mesi coinvolti vengono SOSTITUITI.`)) return;

      status.className = 'status wait';
      try {
        // meta per primo: i mesi si appoggiano alle sue categorie.
        if (meta) {
          status.textContent = 'Carico meta.json…';
          await app.store.importMeta(meta);
        }
        for (const [index, monthFile] of months.entries()) {
          status.textContent = `Carico ${monthFile.month}… (${index + 1}/${months.length})`;
          await app.store.importMonth(monthFile);
        }
        await app.store.loadYear(app.store.year);
        app.refresh();
        render();
        status.className = 'status ok';
        status.textContent = `Importate ${count} transazioni.`;
        toast(`${count} transazioni importate`);
      } catch (err) {
        status.className = 'status ko';
        status.textContent = humanError(err);
      }
    };

    button.addEventListener('click', run);

    return block('Importa dati', [
      el('p', { class: 'hint', text: 'Operazione una tantum: carica i JSON prodotti da migrate.py (meta.json e i file mensili, tutti insieme). I file vengono cifrati QUI, con la tua chiave, e poi caricati — la passphrase non lascia il dispositivo.' }),
      input,
      chosen,
      button,
      status,
    ]);
  }

  // --- Aggiornamento forzato -----------------------------------------------

  function updateBlock() {
    const status = el('div', { class: 'status' });
    const button = iconButton(uiIcon('refresh'), 'Aggiorna l\'app', {
      class: 'btn ghost',
      onclick: async () => {
        button.disabled = true;
        status.className = 'status wait';
        try {
          await hardRefresh((text) => { status.textContent = text; });
        } catch (err) {
          button.disabled = false;
          status.className = 'status ko';
          status.textContent = `${humanError(err)} Niente è stato toccato: riprova quando c'è rete.`;
        }
      },
    });

    return block('Aggiornamento', [
      el('p', {
        class: 'hint',
        text: 'Sull\'iPhone l\'app resta quella salvata finché il sistema non decide di ricontrollare da solo: questo pulsante la costringe a riscaricare tutto adesso. Token, chiave e passphrase non vengono toccati — si butta via solo il codice.',
      }),
      button,
      status,
    ]);
  }

  // --- Dispositivo ---------------------------------------------------------

  function deviceBlock() {
    const repo = localStorage.getItem(LS_REPO) ?? '—';
    return block('Dispositivo', [
      el('div', { class: 'line' }, [el('span', { class: 'line-label', text: 'Repo dati' }), el('span', { class: 'line-value', text: repo })]),
      el('div', { class: 'line' }, [el('span', { class: 'line-label', text: 'Token' }), el('span', { class: 'line-value', text: localStorage.getItem(LS_TOKEN) ? 'presente' : 'assente' })]),
      el('div', { class: 'line' }, [el('span', { class: 'line-label', text: 'Chiave' }), el('span', { class: 'line-value', text: app.store ? 'in memoria' : 'assente' })]),
      el('div', { class: 'line' }, [el('span', { class: 'line-label', text: 'Versione' }), el('span', { class: 'line-value', text: APP_VERSION })]),
      el('p', { class: 'hint', text: 'Cancella token e chiave da questo dispositivo. I dati su GitHub restano intatti: per rientrare servono repo, token e passphrase.' }),
      el('button', {
        class: 'btn ghost danger', type: 'button', text: 'Dimentica questo dispositivo',
        onclick: async () => {
          if (!confirm('Cancellare token e chiave da questo dispositivo?')) return;
          localStorage.removeItem(LS_REPO);
          localStorage.removeItem(LS_TOKEN);
          await clearKey();
          location.reload();
        },
      }),
    ]);
  }

  return {
    node: dialog,
    open: () => { render(); dialog.showModal(); },
  };
}

const block = (title, children) => el('div', { class: 'block' }, [
  el('div', { class: 'block-title', text: title }),
  el('div', { class: 'block-body stack' }, children),
]);

// --- Aggiornamento forzato ---------------------------------------------------

/**
 * Gli URL da riscaricare per aggiornare l'app: il documento più tutto ciò che
 * questa pagina ha caricato dalla propria origine.
 *
 * Si ricava dal timing delle risorse invece di essere un elenco scritto a
 * mano perché un elenco a mano si dimentica il modulo aggiunto il mese dopo,
 * e si dimentica in silenzio: l'app si aggiornerebbe a metà.
 *
 * Le richieste a GitHub restano fuori: hanno un'altra origine, e i dati non
 * si mettono in cache da nessuna parte.
 */
export function assetsToRevalidate(entries, origin, href) {
  const urls = new Set([String(href).split('#')[0]]);
  for (const entry of entries ?? []) {
    const name = String(entry?.name ?? '');
    if (name.startsWith(`${origin}/`)) urls.add(name.split('#')[0]);
  }
  return [...urls];
}

/**
 * Aggiornamento forzato. Tre passaggi, in quest'ordine per un motivo:
 *
 * 1. riscarica dalla rete, saltando la cache HTTP (`cache: 'reload'`, che
 *    oltre a saltarla la AGGIORNA);
 * 2. solo se il punto 1 è riuscito, butta via service worker e cache;
 * 3. ricarica.
 *
 * Se si cancellasse prima e la rete cadesse dopo, resteremmo senza la copia
 * vecchia e senza quella nuova. Così un fallimento lascia tutto com'era.
 *
 * Credenziali: intatte. Token e repo stanno in localStorage, la chiave AES in
 * IndexedDB; nessuno dei due è toccato da `unregister()` o da `caches.delete()`,
 * che vivono in un altro archivio. Al riavvio la chiave si rilegge da lì e non
 * viene richiesta la passphrase.
 */
async function hardRefresh(report) {
  report('Scarico la versione nuova…');
  const urls = assetsToRevalidate(
    performance.getEntriesByType('resource'), location.origin, location.href,
  );
  let responses;
  try {
    responses = await Promise.all(urls.map((url) => fetch(url, { cache: 'reload' })));
  } catch {
    // Una fetch che non parte lancia un TypeError con dentro "Failed to
    // fetch": vero, e inutile da leggere sul telefono.
    throw new Error('Nessuna connessione.');
  }
  const failed = responses.find((response) => !response.ok);
  if (failed) throw new Error(`${new URL(failed.url).pathname} non scaricabile (HTTP ${failed.status}).`);

  report('Butto via la copia vecchia…');
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
  if ('caches' in self) {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
  }

  report('Riavvio…');
  location.reload();
}
