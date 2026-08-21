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
import { createHash } from 'node:crypto';
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

// Co smí přijít z formuláře jako doklad. Úmyslně úzké: z těchhle typů umí
// Claude vytěžit údaje a obrázky jdou zmenšit. Rozšiřovat to není dobrý nápad,
// protože doklady leží v adresáři, ze kterého se servírují i profilové fotky.
export function isSupportedMime(mime) {
  return mime === 'application/pdf' || (typeof mime === 'string' && mime.startsWith('image/'));
}

// Archivní typy — nedají se vytěžit ani zmenšit, jen se ukládají. Potřebuje je
// import z Airtable: v mzdových balíčcích jsou XML pro e-podání ČSSZ, mezi
// smluvními dokumenty DOCX a u úkolů XLSX i ZIP. Do formulářů dokladů se
// nepouštějí — tam má být sken, ne tabulka.
export const ARCHIVE_MIMES = new Set([
  'application/xml',
  'text/xml',
  'text/csv',
  'text/plain',
  'application/zip',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export function isArchivableMime(mime) {
  return isSupportedMime(mime) || ARCHIVE_MIMES.has(mime);
}

const EXT_BY_MIME = new Map([
  ['application/pdf', '.pdf'],
  ['image/png',  '.png'],
  ['image/webp', '.webp'],
  ['image/gif',  '.gif'],
  ['image/heic', '.heic'],
  ['application/xml', '.xml'],
  ['text/xml',        '.xml'],
  ['text/csv',        '.csv'],
  ['text/plain',      '.txt'],
  ['application/zip', '.zip'],
  ['application/msword', '.doc'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document',   '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         '.xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
]);

export function extForMime(mime) {
  return EXT_BY_MIME.get(mime) ?? '.jpg';
}

const MIME_BY_EXT = new Map([...EXT_BY_MIME].map(([mime, ext]) => [ext, mime]).concat([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
]));

// Pozor: fallback je octet-stream, ne obrázek. Z téhle funkce staví
// documents.js hlavičku Content-Type — kdyby neznámá přípona spadla na
// image/jpeg, prohlížeč by se snažil vykreslit ZIP jako fotku.
export function mimeForFile(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return MIME_BY_EXT.get(ext) ?? 'application/octet-stream';
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
export async function saveAttachment(buf, mime, baseName, { log, archive = false } = {}) {
  if (!buf || buf.length === 0) throw new Error('Nahraný soubor je prázdný.');
  if (archive ? !isArchivableMime(mime) : !isSupportedMime(mime)) {
    throw new Error(archive
      ? `Typ souboru ${mime || '?'} neumíme uložit.`
      : 'Podporujeme jen PDF nebo obrázek (JPG, PNG, HEIC z fotoaparátu).');
  }

  let finalBuf = buf;
  let finalMime = mime;

  // Archivní soubor se ukládá tak, jak přišel. Je to důkazní materiál
  // (výplatní páska, e-podání na ČSSZ) — přeukládat ho nemá smysl a u XML
  // ani nejde.
  if (!archive && mime.startsWith('image/')) {
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

  // Tahle hláška dává smysl jen tam, kde jsme se zmenšit opravdu pokusili.
  // V archivním režimu se úmyslně nekomprimuje, takže velký obrázek není chyba —
  // spadne níž mezi ostatní velké soubory a jen se zaloguje.
  if (!archive && finalMime.startsWith('image/') && finalBuf.length > MAX_ATTACHMENT_BYTES) {
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
  const ext = extForMime(finalMime);

  // Unikátnost drží časové razítko, jenže při hromadném importu se do jedné
  // milisekundy vejde víc souborů. Zápis s příznakem 'wx' proto raději selže,
  // než by přepsal cizí doklad — kolize se vyřeší přidáním pořadí a nikdy
  // neskončí tím, že dva záznamy v DB ukazují na stejný soubor.
  for (let poradi = 0; ; poradi++) {
    const filename = `${safeBase}_${Date.now()}${poradi ? `-${poradi}` : ''}${ext}`;
    try {
      await writeFile(path.join(MEDIA_DIR, filename), finalBuf, { flag: 'wx' });
      return { filename, mime: finalMime, size: finalBuf.length, originalSize: buf.length };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (poradi >= 50) throw new Error('Nepodařilo se najít volný název souboru pro přílohu.');
    }
  }
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

// ── Přílohy navázané na záznam ────────────────────────────────
// Tabulka attachments drží vlastníka „výlučným obloukem": vyplněný je právě
// jeden z pěti sloupců. Tady je jediné místo, kde se překládá název entity
// na sloupec — routy ani šablony to vědět nemusí.

export const ATTACHMENT_OWNERS = Object.freeze({
  work_report:  'work_report_id',
  payroll_run:  'payroll_run_id',
  payroll_item: 'payroll_item_id',
  document:     'document_id',
  task:         'task_id',
});

function ownerColumn(owner) {
  const col = ATTACHMENT_OWNERS[owner];
  if (!col) throw new Error(`Neznámý vlastník přílohy: ${owner}`);
  return col;
}

/** Přílohy jednoho záznamu, v pořadí, v jakém se mají zobrazit. */
export async function loadAttachments(sql, owner, ownerId) {
  const col = ownerColumn(owner);
  const rows = await sql`
    SELECT id, path, original_name, mime, size, category, sort_order, created_at
      FROM attachments
     WHERE ${sql(col)} = ${ownerId}
     ORDER BY sort_order, id
  `;
  return markMissingFiles(rows);
}

/**
 * Uloží soubor a naváže ho na záznam. Pořadí je záměrné: nejdřív na disk,
 * pak do databáze. Osiřelý soubor nikoho nebolí, ale řádek bez souboru je
 * doklad, který nejde otevřít.
 */
export async function addAttachment(sql, owner, ownerId, { buf, mime, originalName, category = '', baseName = 'priloha', uploadedBy = null, airtableId = null, archive = true, log } = {}) {
  const col = ownerColumn(owner);
  const saved = await saveAttachment(buf, mime, baseName, { log, archive });
  const sha = createHash('sha256').update(buf).digest('hex');

  const [row] = await sql`
    INSERT INTO attachments
      (path, original_name, mime, size, sha256, category, sort_order,
       ${sql(col)}, airtable_id, uploaded_by)
    VALUES (
      ${saved.filename}, ${String(originalName || saved.filename)}, ${saved.mime},
      ${saved.size}, ${sha}, ${category},
      COALESCE((SELECT MAX(sort_order) + 1 FROM attachments WHERE ${sql(col)} = ${ownerId}), 0),
      ${ownerId}, ${airtableId}, ${uploadedBy}
    )
    RETURNING id, path, original_name, mime, size, category, sort_order
  `;
  return row;
}

/** Smaže přílohu i její soubor. Soubor až po úspěšném zápisu do DB. */
export async function removeAttachment(sql, id) {
  const [row] = await sql`DELETE FROM attachments WHERE id = ${id} RETURNING path`;
  if (row) await deleteAttachment(row.path);
  return Boolean(row);
}

/** Označí řádky příloh, kterým chybí soubor na disku (sloupec path). */
export function markMissingFiles(rows) {
  for (const row of rows) {
    if (row && row.path) row.missing = attachmentMissing(row.path);
  }
  return rows;
}

// Ohlásí, kolik příloh evidovaných v DB chybí na disku. Typicky to znamená,
// že data/media nepřežilo deploy — bez persistent volume žije v zapisovatelné
// vrstvě kontejneru a každý build ho smaže. Bez téhle hlášky se na to přijde
// až ve chvíli, kdy někdo doklad hledá.
export async function checkAttachments(sql, log) {
  // Zdroje drží pohled attachment_files (migrace 028). Kdyby se seznam
  // tabulek psal tady, na každou další entitu by se dřív nebo později
  // zapomnělo a její přílohy by z kontroly tiše vypadly.
  const rows = await sql`SELECT path AS attachment_path FROM attachment_files`;
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
