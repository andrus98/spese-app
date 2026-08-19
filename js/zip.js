// Scrittore ZIP minimo, metodo "store" (nessuna compressione).
//
// Serve solo a impacchettare un .xlsx, che è uno ZIP di file XML. Senza
// compressione il file è più grande ma il codice non ha dipendenze e non ha
// nulla da sbagliare: Excel, Numbers e openpyxl leggono gli archivi store
// esattamente come quelli deflate.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Data/ora in formato MS-DOS, come vuole lo ZIP. */
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1F) << 11)
    | ((date.getMinutes() & 0x3F) << 5)
    | ((date.getSeconds() / 2) & 0x1F);
  const day = (((date.getFullYear() - 1980) & 0x7F) << 9)
    | (((date.getMonth() + 1) & 0x0F) << 5)
    | (date.getDate() & 0x1F);
  return { time, day };
}

/**
 * @param {Array<{name: string, data: string|Uint8Array}>} entries
 * @returns {Blob} archivio ZIP
 */
export function makeZip(entries, date = new Date()) {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(date);

  const prepared = entries.map((entry) => {
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    return { name: encoder.encode(entry.name), data, crc: crc32(data) };
  });

  const LOCAL_HEADER = 30;
  const CENTRAL_HEADER = 46;
  const EOCD = 22;

  const localSize = prepared.reduce((acc, e) => acc + LOCAL_HEADER + e.name.length + e.data.length, 0);
  const centralSize = prepared.reduce((acc, e) => acc + CENTRAL_HEADER + e.name.length, 0);

  const out = new Uint8Array(localSize + centralSize + EOCD);
  const view = new DataView(out.buffer);
  let offset = 0;

  const u16 = (value) => { view.setUint16(offset, value, true); offset += 2; };
  const u32 = (value) => { view.setUint32(offset, value, true); offset += 4; };
  const raw = (bytes) => { out.set(bytes, offset); offset += bytes.length; };

  // Bit 11 = nomi in UTF-8.
  const FLAGS = 0x0800;

  const offsets = [];
  for (const entry of prepared) {
    offsets.push(offset);
    u32(0x04034B50);          // firma local file header
    u16(20);                  // versione minima
    u16(FLAGS);
    u16(0);                   // metodo: store
    u16(time); u16(day);
    u32(entry.crc);
    u32(entry.data.length);   // compressa = non compressa
    u32(entry.data.length);
    u16(entry.name.length);
    u16(0);                   // extra
    raw(entry.name);
    raw(entry.data);
  }

  const centralStart = offset;
  prepared.forEach((entry, index) => {
    u32(0x02014B50);          // firma central directory
    u16(20); u16(20);
    u16(FLAGS);
    u16(0);
    u16(time); u16(day);
    u32(entry.crc);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(entry.name.length);
    u16(0); u16(0);           // extra, commento
    u16(0);                   // disco
    u16(0); u32(0);           // attributi interni ed esterni
    u32(offsets[index]);
    raw(entry.name);
  });

  u32(0x06054B50);            // firma end of central directory
  u16(0); u16(0);
  u16(prepared.length);
  u16(prepared.length);
  u32(offset - centralStart);
  u32(centralStart);
  u16(0);

  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
