/**
 * Minimalistická čtečka XLSX bez externích závislostí.
 *
 * XLSX je ZIP archiv s XML uvnitř. Rozbalíme přes vestavěné zlib
 * (inflateRawSync) a XML přečteme regexem — pro exporty z POHODY
 * (ploché tabulky, jeden list) to plně stačí a ušetří to závislost
 * na balíčku `xlsx`, který má známé CVE.
 *
 *   readSheet('/cesta/soubor.xlsx')  →  [{ 'Číslo': '221100015', ... }, …]
 *
 * Buňky s datem vrací jako Excel sériové číslo (dny od 30.12.1899) —
 * na datum je převede excelDate() v importním skriptu.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

// ── ZIP ───────────────────────────────────────────────────────

/** Rozbalí ZIP do mapy { 'cesta/v/archivu.xml': Buffer }. */
function unzip(buf) {
  // End of Central Directory — hledáme od konce (max. 64 kB komentář)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Neplatný XLSX: nenalezen ZIP End of Central Directory');

  const entries = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const files = {};

  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method   = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen  = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const cmtLen   = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name     = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    // Lokální hlavička má vlastní délky name/extra — datový offset se počítá z ní
    const lNameLen  = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff   = localOff + 30 + lNameLen + lExtraLen;
    const raw       = buf.subarray(dataOff, dataOff + compSize);

    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    ptr += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}

// ── XML ───────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Text ze všech <t> uvnitř úseku (rich text má <t> několik). */
function collectText(xml) {
  let out = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) {
    out += decodeXml(m[1] ?? '');
  }
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => collectText(m[1]));
}

/** "BC12" → 54 (0-based index sloupce) */
function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Najde cestu k prvnímu listu podle workbook.xml + rels. */
function firstSheetPath(files) {
  const wb = files['xl/workbook.xml']?.toString('utf8');
  const rels = files['xl/_rels/workbook.xml.rels']?.toString('utf8');
  if (wb && rels) {
    const sheet = wb.match(/<sheet\b[^>]*\/?>/);
    const rid = sheet?.[0].match(/r:id="([^"]+)"/)?.[1];
    if (rid) {
      const rel = rels.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*>`))?.[0];
      const target = rel?.match(/Target="([^"]+)"/)?.[1];
      if (target) {
        const path = target.startsWith('/') ? target.slice(1)
                   : target.startsWith('xl/') ? target
                   : `xl/${target}`;
        if (files[path]) return path;
      }
    }
  }
  if (files['xl/worksheets/sheet1.xml']) return 'xl/worksheets/sheet1.xml';
  const any = Object.keys(files).find(k => /^xl\/worksheets\/.*\.xml$/.test(k));
  if (!any) throw new Error('Neplatný XLSX: nenalezen žádný list');
  return any;
}

// ── Veřejné API ───────────────────────────────────────────────

/**
 * Načte první list sešitu jako pole objektů; klíče = hlavičky z 1. řádku.
 * Prázdné buňky mají hodnotu null. Řádky bez jediné hodnoty se vynechají.
 */
export function readSheet(file) {
  const files  = unzip(fs.readFileSync(file));
  const shared = parseSharedStrings(files['xl/sharedStrings.xml']?.toString('utf8'));
  const xml    = files[firstSheetPath(files)].toString('utf8');

  const rows = [];
  for (const rowM of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    const cells = [];
    for (const cM of (rowM[1] ?? '').matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cM[1];
      const body  = cM[2] ?? '';
      const ref   = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const type  = attrs.match(/\bt="([^"]+)"/)?.[1] ?? 'n';
      const i     = ref ? colIndex(ref) : cells.length;

      let value = null;
      if (type === 's') {
        const idx = parseInt(collectValue(body), 10);
        value = shared[idx] ?? null;
      } else if (type === 'inlineStr') {
        value = collectText(body) || null;
      } else if (type === 'str' || type === 'e') {
        value = decodeXml(collectValue(body)) || null;
      } else if (type === 'b') {
        const v = collectValue(body);
        value = v === '' ? null : v === '1';
      } else {
        const v = collectValue(body);
        value = v === '' ? null : Number(v);
        if (Number.isNaN(value)) value = decodeXml(v);
      }
      cells[i] = value;
    }
    rows.push(cells);
  }

  if (!rows.length) return [];
  const header = rows[0].map(h => (h == null ? '' : String(h).trim()));

  const out = [];
  for (const cells of rows.slice(1)) {
    if (!cells.some(v => v != null && v !== '')) continue;
    const obj = {};
    for (let i = 0; i < header.length; i++) {
      if (header[i]) obj[header[i]] = cells[i] ?? null;
    }
    out.push(obj);
  }
  return out;
}

/** Obsah <v> uvnitř buňky. */
function collectValue(body) {
  const m = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
  return m ? m[1] : '';
}
