// Ukládání příloh k dokladům (účtenky, přijaté faktury).
//
// Fotka z mobilu má běžně 4–12 MB, což je pro archiv dokladů zbytečné —
// paragon je čitelný i po zmenšení na ~2400 px delší strany. Zmenšení dělá
// primárně prohlížeč (public/js/doklad-foto.js), aby se velký soubor vůbec
// nemusel nahrávat; tady je druhá pojistka pro soubory, které přijdou odjinud
// (Google Disk, API, starší prohlížeč bez canvasu).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export const MEDIA_DIR = path.join(projectRoot, 'data/media');

// Cílová velikost archivované přílohy — nad ní se obrázek zmenšuje.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// Tvrdý strop uploadu (shodný s limitem @fastify/multipart v server.js).
// PDF nemá smysl přepočítávat, je to už komprimovaný formát: vícestránkový
// sken od účetní přes 5 MB radši uložíme, než abychom ho odmítli.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Pod touto hranicí nechává bezztrátové formáty (sken, screenshot) tak, jak jsou
const KEEP_AS_IS_BYTES = 1.5 * 1024 * 1024;

// Postupné zhoršování, dokud se obrázek nevejde pod strop. První stupeň je
// zvolený tak, aby účtenka zůstala čitelná i po vytisknutí.
const QUALITY_LADDER = [
  { edge: 2400, quality: 78 },
  { edge: 2000, quality: 70 },
  { edge: 1600, quality: 62 },
  { edge: 1400, quality: 50 },
];

// sharp je nepovinná závislost — když v runtime chybí (jiná platforma, ruční
// instalace bez native modulů), ukládáme soubor tak, jak přišel.
let sharpPromise = null;
async function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = import('sharp').then(m => m.default).catch(() => null);
  }
  return sharpPromise;
}

export function isSupportedMime(mime) {
  return mime === 'application/pdf' || (typeof mime === 'string' && mime.startsWith('image/'));
}

export function extForMime(mime) {
  if (mime === 'application/pdf') return '.pdf';
  if (mime === 'image/png')  return '.png';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

export function mimeForFile(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.pdf')  return 'application/pdf';
  if (ext === '.png')  return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

// Zmenší obrázek pod strop. Vrací původní buffer, pokud sharp není k dispozici
// nebo se obrázek nepodařilo dekódovat (neznámý formát, poškozený soubor).
export async function compressImage(buf, mime, { maxBytes = MAX_ATTACHMENT_BYTES, log } = {}) {
  const sharp = await loadSharp();
  if (!sharp) {
    log?.warn('sharp není k dispozici — příloha se ukládá bez zmenšení');
    return { buf, mime, compressed: false };
  }

  // Malý sken nebo screenshot v bezztrátovém formátu necháváme být — převod
  // do JPEGu by u drobného písma jen přidal artefakty a nic neušetřil.
  if (buf.length <= KEEP_AS_IS_BYTES && (mime === 'image/png' || mime === 'image/webp')) {
    return { buf, mime, compressed: false };
  }

  try {
    let best = null;
    for (const step of QUALITY_LADDER) {
      const out = await sharp(buf, { failOn: 'none' })
        .rotate()                                  // srovná podle EXIF orientace z mobilu
        .resize({ width: step.edge, height: step.edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: step.quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
        .toBuffer();
      best = out;
      if (out.length <= maxBytes) break;
    }
    if (!best) return { buf, mime, compressed: false };

    // Zmenšenina nesmí být větší než originál (drobné/už zkomprimované fotky)
    if (best.length >= buf.length && buf.length <= maxBytes) {
      return { buf, mime, compressed: false };
    }
    return { buf: best, mime: 'image/jpeg', compressed: true };
  } catch (err) {
    log?.warn({ err }, 'Zmenšení obrázku selhalo — ukládám originál');
    return { buf, mime, compressed: false };
  }
}

// Uloží přílohu do data/media a vrátí metadata pro zápis do DB.
// baseName slouží jen k orientaci v adresáři, unikátnost drží časové razítko.
export async function saveAttachment(buf, mime, baseName, { log } = {}) {
  if (!buf || buf.length === 0) throw new Error('Nahraný soubor je prázdný.');
  if (!isSupportedMime(mime)) throw new Error('Podporujeme jen PDF nebo obrázek (JPG, PNG, HEIC z fotoaparátu).');

  let finalBuf = buf;
  let finalMime = mime;

  if (mime.startsWith('image/')) {
    const result = await compressImage(buf, mime, { log });
    finalBuf = result.buf;
    finalMime = result.mime;
  }

  if (finalBuf.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Soubor má ${formatBytes(finalBuf.length)}, maximum je ${formatBytes(MAX_UPLOAD_BYTES)}. ` +
      'Zkuste sken v nižším rozlišení.'
    );
  }

  if (finalMime.startsWith('image/') && finalBuf.length > MAX_ATTACHMENT_BYTES) {
    // Sem se dostaneme jen bez sharpu — jinak žebřík kvality obrázek srazí níž
    throw new Error(
      `Fotku se nepodařilo zmenšit pod ${formatBytes(MAX_ATTACHMENT_BYTES)} (má ${formatBytes(finalBuf.length)}). ` +
      'Vyfoťte doklad znovu v nižším rozlišení.'
    );
  }

  if (finalBuf.length > MAX_ATTACHMENT_BYTES) {
    log?.warn({ size: finalBuf.length }, `Příloha přesahuje ${formatBytes(MAX_ATTACHMENT_BYTES)}, ukládám v původní velikosti`);
  }

  if (!existsSync(MEDIA_DIR)) await mkdir(MEDIA_DIR, { recursive: true });

  const safeBase = String(baseName || 'doklad').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'doklad';
  const filename = `${safeBase}_${Date.now()}${extForMime(finalMime)}`;
  await writeFile(path.join(MEDIA_DIR, filename), finalBuf);

  return { filename, mime: finalMime, size: finalBuf.length, originalSize: buf.length };
}

// Smaže soubor přílohy. Chybějící soubor není chyba — záznam v DB může
// přežít ruční úklid adresáře.
export async function deleteAttachment(filename) {
  if (!filename) return;
  const name = path.basename(String(filename));
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return;
  await unlink(path.join(MEDIA_DIR, name)).catch(() => {});
}

// Chybí soubor, na který se záznam v DB odkazuje? Stane se to, když se
// data/media ztratí (chybějící persistent volume) nebo někdo uklidí adresář —
// v systému pak zůstane doklad, který nejde otevřít. Views to potřebují vědět,
// aby místo rozbité miniatury ukázaly, že doklad chybí.
export function attachmentMissing(filename) {
  if (!filename) return false;
  return !existsSync(path.join(MEDIA_DIR, path.basename(String(filename))));
}

// Označí řádky pro šablonu. Je to jeden stat na řádek nad lokálním adresářem,
// takže na stránce s 25 doklady je to zanedbatelné.
export function markMissingAttachments(rows) {
  for (const row of rows) {
    if (row && row.attachment_path) row.attachment_missing = attachmentMissing(row.attachment_path);
  }
  return rows;
}

// Ohlásí, kolik příloh evidovaných v DB chybí na disku. Typicky to znamená,
// že data/media nepřežilo deploy — bez persistent volume žije v zapisovatelné
// vrstvě kontejneru a každý build ho smaže. Bez téhle hlášky se na to přijde
// až ve chvíli, kdy někdo doklad hledá.
export async function checkAttachments(sql, log) {
  const rows = await sql`
    SELECT attachment_path FROM receipts            WHERE attachment_path IS NOT NULL
    UNION ALL
    SELECT attachment_path FROM accounting_invoices WHERE attachment_path IS NOT NULL
    UNION ALL
    SELECT photo AS attachment_path FROM users      WHERE photo IS NOT NULL
  `;
  if (rows.length === 0) return { total: 0, missing: 0 };

  const missing = rows.filter(r => !existsSync(path.join(MEDIA_DIR, path.basename(r.attachment_path))));
  if (missing.length === 0) {
    log?.info(`[přílohy] ${rows.length} souborů v ${MEDIA_DIR} — vše na místě`);
  } else if (missing.length === rows.length) {
    log?.error(
      `[přílohy] CHYBÍ VŠECH ${rows.length} souborů v ${MEDIA_DIR}. ` +
      'Adresář zjevně nepřežil deploy — připoj persistent volume na /app/data (viz docs/nasazeni.md).'
    );
  } else {
    log?.warn(`[přílohy] chybí ${missing.length} z ${rows.length} souborů v ${MEDIA_DIR}: ${missing.slice(0, 5).map(m => m.attachment_path).join(', ')}`);
  }
  return { total: rows.length, missing: missing.length };
}
