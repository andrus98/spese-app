// Tastierino nostro, non quello di iOS.
//
// Motivo: il tastierino numerico di iOS non ha il tasto Invio, e la tastiera
// di sistema coprirebbe il pulsante di conferma costringendo a scorrere.
// Con un tastierino nostro il tasto di conferma sta sempre dove sta il
// pollice, non c'è zoom sul focus e non serve un campo di testo focalizzabile.
//
// La macchina a stati è separata dal DOM: è la parte che va verificata.

import { el } from './ui.js';
import { uiIcon } from './icons.js';

export const MAX_INTEGER_DIGITS = 6; // 999.999 € basta e avanza
export const MAX_DECIMALS = 2;

/**
 * Riduttore puro dell'importo digitato.
 * @param {string} state cifre digitate, es. "12,5" ("" = vuoto)
 * @param {string} key '0'-'9' | ',' | 'back' | 'clear'
 * @returns {string} nuovo stato
 */
export function keypadReduce(state, key) {
  if (key === 'clear') return '';
  if (key === 'back') return state.slice(0, -1);

  if (key === ',') {
    if (state.includes(',')) return state;      // un solo separatore
    return state === '' ? '0,' : `${state},`;   // ",50" non è digitabile: diventa "0,50"
  }

  if (!/^[0-9]$/.test(key)) return state;

  const [whole, decimals] = state.split(',');
  if (state.includes(',')) {
    if ((decimals ?? '').length >= MAX_DECIMALS) return state;
    return state + key;
  }
  if (whole === '0') return key;                // niente zeri iniziali: "0" + "5" = "5"
  if (whole.length >= MAX_INTEGER_DIGITS) return state;
  return state + key;
}

/** Valore numerico di uno stato, o null se non è un importo valido. */
export function keypadValue(state) {
  if (!state || state === '0' || state === '0,') return null;
  const value = Number(state.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Testo da mostrare a schermo mentre si digita. */
export function keypadDisplay(state) {
  if (state === '') return '0,00';
  const [whole, decimals] = state.split(',');
  const grouped = Number(whole || 0).toLocaleString('it-IT');
  return state.includes(',') ? `${grouped},${decimals ?? ''}` : grouped;
}

/**
 * Componente. `onChange(state)` a ogni tasto, `onConfirm()` sul tasto verde.
 * @returns {{node: HTMLElement, get: () => string, reset: () => void, attachHardwareKeyboard: (target: HTMLElement) => void}}
 */
export function createKeypad({ onChange, onConfirm, confirmLabel = 'Registra' }) {
  let state = '';

  const emit = () => onChange?.(state);
  const press = (key) => {
    const next = keypadReduce(state, key);
    if (next === state) return;
    state = next;
    emit();
  };

  const makeKey = (label, key, opts = {}) => el('button', {
    class: 'key',
    type: 'button',
    'aria-label': opts.aria ?? label,
    // pointerdown invece di click: la risposta al tocco è immediata, e su
    // iOS il click arriva con un ritardo percepibile dopo il tocco.
    onpointerdown: (event) => { event.preventDefault(); press(key); },
    ...(opts.html ? { html: opts.html } : { text: label }),
  });

  const keys = el('div', { class: 'keypad' }, [
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => makeKey(digit, digit)),
    makeKey(',', ',', { aria: 'virgola' }),
    makeKey('0', '0'),
    makeKey('', 'back', { aria: 'cancella', html: uiIcon('backspace') }),
  ]);

  const confirmBtn = el('button', {
    class: 'confirm', type: 'button', disabled: true, text: confirmLabel,
    onclick: () => onConfirm?.(),
  });

  const node = el('div', { class: 'panel' }, [keys, confirmBtn]);

  /** Su Mac la tastiera fisica deve funzionare, Invio incluso. */
  const attachHardwareKeyboard = (target) => {
    target.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const { key } = event;
      if (/^[0-9]$/.test(key)) press(key);
      else if (key === ',' || key === '.') press(',');
      else if (key === 'Backspace') press('back');
      else if (key === 'Enter') { if (!confirmBtn.disabled) onConfirm?.(); }
      else return;
      event.preventDefault();
    });
  };

  return {
    node,
    confirmBtn,
    get: () => state,
    reset: () => { state = ''; emit(); },
    /** Precarica un importo esistente, per la correzione di un movimento. */
    set: (value) => {
      state = String(value ?? '').replace('.', ',');
      emit();
    },
    setBusy: (busy) => {
      confirmBtn.classList.toggle('busy', busy);
      confirmBtn.disabled = busy || keypadValue(state) == null;
      confirmBtn.textContent = busy ? 'Salvataggio…' : confirmLabel;
    },
    syncConfirm: () => { confirmBtn.disabled = keypadValue(state) == null; },
    attachHardwareKeyboard,
  };
}
