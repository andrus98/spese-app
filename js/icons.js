// Icone SVG inline (D16). Un unico stile a tratto, 24×24, `currentColor`:
// nessuna CDN (il CSP la bloccherebbe) e nessun file binario da versionare.

const WRAP = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" `
  + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

/** Le 19 categorie. Chiave = id in meta.categories[].id */
const CATEGORY = {
  bollette: '<path d="M13 3 6 13.5h5l-1 7.5 7-10.5h-5z"/>',

  alimenti: '<path d="M3.5 4h2l2.3 10.3a1.6 1.6 0 0 0 1.6 1.2h7.4a1.6 1.6 0 0 0 1.6-1.2L20 8H6.2"/>'
    + '<circle cx="10" cy="19.4" r="1.3"/><circle cx="17" cy="19.4" r="1.3"/>',

  spese_mediche: '<rect x="3.5" y="7.5" width="17" height="12.5" rx="2.5"/>'
    + '<path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5"/>'
    + '<path d="M12 11.2v5M9.5 13.7h5"/>',

  casa: '<path d="M3.8 10.4 12 3.8l8.2 6.6"/><path d="M6 9.6V19a1.2 1.2 0 0 0 1.2 1.2h9.6A1.2 1.2 0 0 0 18 19V9.6"/>',

  shopping: '<path d="M5.4 7.8h13.2l-1 11.4a1.6 1.6 0 0 1-1.6 1.4H8a1.6 1.6 0 0 1-1.6-1.4z"/>'
    + '<path d="M9 7.8V6.4a3 3 0 0 1 6 0v1.4"/>',

  pasti_fuori: '<path d="M6.8 3.5v6a2.6 2.6 0 0 0 5.2 0v-6"/><path d="M9.4 12.1v8.4"/>'
    + '<path d="M17.6 20.5V3.5c-1.8.6-3 2.7-3 5.2s1.2 3.9 3 4.1"/>',

  spotify: '<path d="M9.2 17.8V6.4l9.6-1.9v11.2"/>'
    + '<ellipse cx="6.7" cy="17.9" rx="2.5" ry="2.1"/><ellipse cx="16.3" cy="15.8" rx="2.5" ry="2.1"/>',

  dazn: '<rect x="2.8" y="4.8" width="18.4" height="13" rx="2.6"/>'
    + '<path d="M10.4 9.4 15 11.3l-4.6 2z"/><path d="M8.5 20.6h7"/>',

  benzina: '<path d="M5 20.6V6.2A1.7 1.7 0 0 1 6.7 4.5h5.6A1.7 1.7 0 0 1 14 6.2v14.4"/>'
    + '<path d="M3.4 20.6h12.2"/><path d="M7 8.4h5"/>'
    + '<path d="M14 10.8h2.6a1.6 1.6 0 0 1 1.6 1.6v3.4a1.6 1.6 0 0 0 3.2 0V9.2l-2.5-2.6"/>',

  svago: '<path d="M3.8 8.6A1.6 1.6 0 0 1 5.4 7h13.2A1.6 1.6 0 0 1 20.2 8.6v1.9a2 2 0 0 0 0 3.9v1.9a1.6 1.6 0 0 1-1.6 1.6H5.4a1.6 1.6 0 0 1-1.6-1.6v-1.9a2 2 0 0 0 0-3.9z"/>'
    + '<path d="M13.6 7.4v2M13.6 11.2v1.6M13.6 14.6v2.2"/>',

  viaggi: '<path d="M10.5 4.2a1.5 1.5 0 0 1 3 0v4.6l7 4.1v2l-7-2v4.2l2.2 1.6v1.4L12 19.4l-3.7.7v-1.4l2.2-1.6v-4.2l-7 2v-2l7-4.1z"/>',

  palestra: '<path d="M3.8 9.6v4.8M7.2 7.4v9.2M16.8 7.4v9.2M20.2 9.6v4.8M7.2 12h9.6"/>',

  vodafone: '<path d="M4.6 19.4v-3.2M9.6 19.4v-6.6M14.4 19.4V8.4M19.4 19.4V4.6"/>',

  manutenzione_mazda_sh: '<path d="M15.4 4.4a5.1 5.1 0 0 0-6.3 6.4L4 16.3v3.8h3.8l5.1-5.2a5.1 5.1 0 0 0 6.4-6.3l-2.9 2.9-2.6-.7-.7-2.6z"/>',

  caffe: '<path d="M4.4 8.8h12v5.8a4.2 4.2 0 0 1-4.2 4.2H8.6a4.2 4.2 0 0 1-4.2-4.2z"/>'
    + '<path d="M16.4 10.4h1.8a2.3 2.3 0 0 1 0 4.6h-1.8"/>'
    + '<path d="M7.4 3.6v1.8M10.4 3.6v1.8M13.4 3.6v1.8"/>'
    + '<path d="M3.4 21h14"/>',

  investimenti: '<path d="M3.6 19.6h16.8"/><path d="M5.4 15.6 10 9.8l3.4 3.4 5.6-6.8"/>'
    + '<path d="M19 11.2V6.4h-4.6"/>',

  // Il segno delle tabaccherie italiane: una T bianca su fondo scuro.
  tabacchi: '<rect x="4" y="4" width="16" height="16" rx="3.4"/><path d="M8.4 9.2h7.2M12 9.2v6.4"/>',

  barbiere: '<circle cx="6.4" cy="17.6" r="2.3"/><circle cx="6.4" cy="6.4" r="2.3"/>'
    + '<path d="M8.2 8 19 18.8M19 5.2 8.2 16"/>',

  // Non è una categoria di spesa: è la scorciatoia ai canoni ricorrenti.
  canoni: '<path d="M20.2 11a8.2 8.2 0 0 0-14-4.4L3.8 9"/><path d="M3.8 4.4V9h4.6"/>'
    + '<path d="M3.8 13a8.2 8.2 0 0 0 14 4.4l2.4-2.4"/><path d="M20.2 19.6V15h-4.6"/>',

  altro: '<circle cx="5.8" cy="12" r="1.5" fill="currentColor" stroke="none"/>'
    + '<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>'
    + '<circle cx="18.2" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
};

/** Icone dell'interfaccia. */
const UI = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/>'
    + '<rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  chart: '<path d="M4 20.2h16"/><path d="M7 17V10M12 17V5.5M17 17v-4.5"/>',
  list: '<path d="M4 6.5h16M4 12h16M4 17.5h11"/>',
  income: '<path d="M12 20.2V4.6"/><path d="M6.4 10.2 12 4.6l5.6 5.6"/>'
    + '<path d="M4 20.2h16"/>',
  gear: '<circle cx="12" cy="12" r="3.1"/>'
    + '<path d="M19.1 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.6 1v.3a1.9 1.9 0 1 1-3.7 0v-.1a1.5 1.5 0 0 0-2.7-1l-.1.1a1.9 1.9 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1-2.6h-.3a1.9 1.9 0 1 1 0-3.7h.1a1.5 1.5 0 0 0 1-2.7l-.1-.1a1.9 1.9 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.3a1.9 1.9 0 1 1 3.7 0v.1a1.5 1.5 0 0 0 2.6 1l.1-.1a1.9 1.9 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0 1 2.6h.3a1.9 1.9 0 1 1 0 3.7h-.1a1.5 1.5 0 0 0-1.4.9z"/>',
  close: '<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>',
  backspace: '<path d="M9.2 5.5h9.3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9.2L3 12z"/>'
    + '<path d="M11.8 9.6 16.4 14.4M16.4 9.6 11.8 14.4"/>',
  calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17"/>'
    + '<path d="M8 3.5v4M16 3.5v4"/>',
  tag: '<path d="M4 11.2V5.5A1.5 1.5 0 0 1 5.5 4h5.7a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8l-5.2 5.2a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 4 11.2z"/>'
    + '<circle cx="8.4" cy="8.4" r="1.3" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
  chevronLeft: '<path d="M14.5 5 7.5 12l7 7"/>',
  chevronRight: '<path d="M9.5 5l7 7-7 7"/>',
  download: '<path d="M12 3.8v11.4"/><path d="M7.6 11l4.4 4.4 4.4-4.4"/>'
    + '<path d="M4.5 16.5v1.8a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1.8"/>',
  trash: '<path d="M4.5 6.8h15"/><path d="M9.5 6.8V5.2a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5v1.6"/>'
    + '<path d="M6.6 6.8 7.5 19a1.6 1.6 0 0 0 1.6 1.5h5.8A1.6 1.6 0 0 0 16.5 19l.9-12.2"/>'
    + '<path d="M10.4 10.4v6M13.6 10.4v6"/>',
};

// Object.hasOwn e non `in`: l'id arriva dai dati decifrati, e una chiave
// ereditata come "constructor" o "toString" restituirebbe un valore che non
// è un'icona — che poi finisce in innerHTML.
const pick = (table, key, fallback) =>
  (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : fallback);

export const categoryIcon = (id) => WRAP(pick(CATEGORY, id, CATEGORY.altro));
export const uiIcon = (name) => WRAP(pick(UI, name, UI.close));
export const hasCategoryIcon = (id) => typeof id === 'string' && Object.hasOwn(CATEGORY, id);
