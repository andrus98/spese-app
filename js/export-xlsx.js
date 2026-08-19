// Generazione del file Excel (fase 6).
//
// Nessuna libreria: un .xlsx è uno ZIP di XML e qui ne serve UNO solo, di
// struttura nota. Scriverlo direttamente evita una dipendenza da CDN (che il
// CSP bloccherebbe) e ~900 KB vendorizzati in un repo pubblico.
//
// Le formule sono in stile A1 (D14): `$A2` invece di
// `Tabella2[[#This Row],[TIPO SPESA]]`. Sono funzionalmente identiche — si
// perde solo la formattazione "tabella" di Excel, che è estetica.
//
// Nel file le formule si scrivono SEMPRE in forma canonica en-US: separatore
// di argomenti la virgola, separatore decimale il punto. Excel le mostra poi
// secondo la lingua del sistema.

import { makeZip } from './zip.js';
import { MONTH_NAMES_IT, monthsOfYear, recurringFor, sortTransactions } from './model.js';
import { INCOME_SOURCES } from './config.js';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

// Range ampio e uniforme su tutti i mesi (risolve l'anomalia C: nel file
// originale ogni mese aveva un limite diverso fissato a mano).
const DATA_LAST_ROW = 500;

const S_DEFAULT = 0;
const S_NUMBER = 1; // 0.00
const S_BOLD = 2;

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function colLetter(index) {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const textCell = (ref, value, style = S_DEFAULT) =>
  `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;

const numberCell = (ref, value, style = S_NUMBER) =>
  `<c r="${ref}" s="${style}"><v>${Number(value)}</v></c>`;

// Nessun valore in cache: le formule vengono calcolate all'apertura grazie a
// fullCalcOnLoad. Senza, alcuni visualizzatori mostrerebbero 0.
const formulaCell = (ref, formula, style = S_NUMBER) =>
  `<c r="${ref}" s="${style}"><f>${escapeXml(formula)}</f></c>`;

const row = (index, cells) => `<row r="${index}">${cells.filter(Boolean).join('')}</row>`;

const sheetXml = (rows) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<worksheet xmlns="${MAIN_NS}"><sheetData>${rows.join('')}</sheetData></worksheet>`;

// --- Fogli mensili ----------------------------------------------------------

/**
 * Header uniforme su tutti e 12 i mesi (risolve l'anomalia B: aprile aveva
 * `Categoria | Euro | Dettaglio`). Nessuna colonna data: sotto D11 il giorno
 * non esiste. Righe ordinate per inserimento.
 */
function monthSheet(transactions, categories, month) {
  const labelOf = new Map(categories.map((c) => [c.id, c.label]));
  const rows = [row(1, [
    textCell('A1', 'Categoria', S_BOLD),
    textCell('B1', 'Dettaglio', S_BOLD),
    textCell('C1', 'Euro', S_BOLD),
    textCell('D1', 'Nota', S_BOLD),
  ])];

  sortTransactions(transactions.filter((t) => t.month === month)).forEach((tx, index) => {
    const r = index + 2;
    rows.push(row(r, [
      textCell(`A${r}`, labelOf.get(tx.category) ?? tx.category),
      textCell(`B${r}`, tx.detail ?? ''),
      numberCell(`C${r}`, tx.amount),         // sempre NUMERO (anomalia A)
      tx.note ? textCell(`D${r}`, tx.note) : null,
    ]));
  });

  return sheetXml(rows);
}

// --- Foglio master ----------------------------------------------------------

const MONTH_HEADERS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

function masterSheet(meta, year) {
  const categories = meta.categories;
  const months = monthsOfYear(year);
  const rows = [];

  const headerRow = (index, first) => row(index, [
    textCell(`A${index}`, first, S_BOLD),
    ...MONTH_HEADERS.map((h, i) => textCell(`${colLetter(i + 2)}${index}`, h, S_BOLD)),
    textCell(`N${index}`, 'TOTALE ANNO', S_BOLD),
  ]);

  // --- SPESE: righe 1-21 ---
  rows.push(headerRow(1, 'TIPO SPESA'));

  categories.forEach((category, index) => {
    const r = index + 2;
    const cells = [textCell(`A${r}`, category.label)];

    months.forEach((month, m) => {
      const col = colLetter(m + 2);
      const sheetName = `Spese ${MONTH_NAMES_IT[m]}`;
      const sumif = `SUMIF('${sheetName}'!$A$2:$A$${DATA_LAST_ROW},$A${r},'${sheetName}'!$C$2:$C$${DATA_LAST_ROW})`;
      const canone = recurringFor(meta, category.id, month);
      // Il canone resta un numero leggibile nella formula: il file è
      // ispezionabile e modificabile a mano anche senza l'app (D3).
      cells.push(formulaCell(`${col}${r}`, canone > 0 ? `${canone}+${sumif}` : sumif));
    });

    cells.push(formulaCell(`N${r}`, `SUM(B${r}:M${r})`));
    rows.push(row(r, cells));
  });

  const totalRow = categories.length + 2; // 21 con 19 categorie
  rows.push(row(totalRow, [
    textCell(`A${totalRow}`, 'TOTALE', S_BOLD),
    ...MONTH_HEADERS.map((_, i) => {
      const col = colLetter(i + 2);
      return formulaCell(`${col}${totalRow}`, `SUM(${col}2:${col}${totalRow - 1})`);
    }),
    formulaCell(`N${totalRow}`, `SUM(B${totalRow}:M${totalRow})`),
  ]));

  // --- ENTRATE: righe 25-30 ---
  const incomeHeader = 25;
  rows.push(headerRow(incomeHeader, 'ENTRATE'));

  INCOME_SOURCES.forEach((source, index) => {
    const r = incomeHeader + 1 + index;
    const cells = [textCell(`A${r}`, source.label)];
    months.forEach((month, m) => {
      const entry = (meta.income ?? []).find((e) => e.month === month && e.source === source.id);
      if (entry) cells.push(numberCell(`${colLetter(m + 2)}${r}`, entry.amount));
    });
    cells.push(formulaCell(`N${r}`, `SUM(B${r}:M${r})`));
    rows.push(row(r, cells));
  });

  const incomeTotal = incomeHeader + 1 + INCOME_SOURCES.length; // 30
  rows.push(row(incomeTotal, [
    textCell(`A${incomeTotal}`, 'TOTALE', S_BOLD),
    ...MONTH_HEADERS.map((_, i) => {
      const col = colLetter(i + 2);
      return formulaCell(`${col}${incomeTotal}`, `SUM(${col}${incomeHeader + 1}:${col}${incomeTotal - 1})`);
    }),
    formulaCell(`N${incomeTotal}`, `SUM(B${incomeTotal}:M${incomeTotal})`),
  ]));

  // --- BILANCIO: righe 33-34 ---
  const balanceHeader = 33;
  rows.push(headerRow(balanceHeader, 'BILANCIO'));

  const savingsRow = balanceHeader + 1; // 34
  rows.push(row(savingsRow, [
    textCell(`A${savingsRow}`, 'Risparmio'),
    ...MONTH_HEADERS.map((_, i) => {
      const col = colLetter(i + 2);
      return formulaCell(`${col}${savingsRow}`, `${col}${incomeTotal}-${col}${totalRow}`);
    }),
    formulaCell(`N${savingsRow}`, `SUM(B${savingsRow}:M${savingsRow})`),
  ]));

  return sheetXml(rows);
}

// --- Parti fisse del pacchetto ---------------------------------------------

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${MAIN_NS}">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * Costruisce il workbook completo.
 * @returns {Blob} file .xlsx pronto da scaricare
 */
export function buildWorkbook(transactions, meta, year) {
  const sheets = [
    { name: `Bilancio ${year}`, xml: masterSheet(meta, year) },
    ...monthsOfYear(year).map((month, index) => ({
      name: `Spese ${MONTH_NAMES_IT[index]}`,
      // Tutti e 12 i mesi, anche vuoti (risolve le anomalie E ed F).
      xml: monthSheet(transactions, meta.categories, month),
    })),
  ];

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL_NS}">
<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">
<sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<calcPr calcId="0" fullCalcOnLoad="1"/>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL_NS}">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>
</Relationships>`;

  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: STYLES },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheet.xml })),
  ]);
}

/** Genera e consegna il file al sistema. */
export function downloadWorkbook(transactions, meta, year) {
  const blob = buildWorkbook(transactions, meta, year);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Spese_${year}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
}
