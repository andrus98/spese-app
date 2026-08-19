// Helper DOM minimi. Niente framework: l'app è piccola e senza build step.

/**
 * Crea un elemento. `text` passa da textContent, mai da innerHTML: dettaglio
 * e nota sono testo libero dell'utente e finiscono a schermo (F9.3).
 * `html` esiste solo per le icone, che sono costanti nostre.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const clear = (node) => { while (node.firstChild) node.firstChild.remove(); return node; };

const EUR = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const NUM = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatEur = (value) => EUR.format(value ?? 0);
export const formatNum = (value) => NUM.format(value ?? 0);

/**
 * Pulsante con icona e testo. Esiste per non comporre HTML a mano: il testo
 * passa da textContent, così un'etichetta che contenga `<` resta testo.
 */
export function iconButton(iconHtml, label, props = {}) {
  return el('button', { type: 'button', ...props }, [
    el('span', { class: 'btn-ico', html: iconHtml }),
    el('span', { text: label }),
  ]);
}

let toastTimer;
export function toast(message, kind = '') {
  document.querySelector('.toast')?.remove();
  const node = el('div', { class: `toast ${kind}`.trim(), role: 'status', text: message });
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), kind === 'ko' ? 4200 : 2200);
}

/** Messaggio d'errore leggibile, senza gergo HTTP. */
export function humanError(err) {
  const byKind = {
    unauthorized: 'Token non valido o scaduto. Rigeneralo nelle impostazioni.',
    rate_limit: 'Troppe richieste a GitHub. Riprova fra qualche minuto.',
    secondary: 'GitHub ha rallentato le scritture. Riprova fra poco.',
    network: 'Nessuna connessione. La spesa non è stata salvata.',
    conflict: 'Conflitto non risolto dopo tre tentativi. Riprova.',
    unprocessable: 'Scrittura rifiutata da GitHub.',
  };
  return byKind[err?.kind] ?? err?.message ?? 'Errore imprevisto';
}
