// Klient Google Drive API v3 přes service account (JWT).
//
// Nastavení:
//   GOOGLE_SERVICE_ACCOUNT_JSON – obsah JSON klíče service accountu (celý JSON
//   v jedné env proměnné). Složku na Disku je potřeba nasdílet e-mailu
//   service accountu (client_email) s právem Čtenář.
//
// Přihlášení (JWT → access token) je od sekce Marketing společné
// v src/google-auth.js: tentýž service account čte i GA4, Search Console
// a Merchant, každý se svým scope. Volání Disku zůstává tady, české texty chyb
// skládá popisChybyDisku().

import { accessToken } from './google-auth.js';

export { isConfigured, serviceAccountEmail } from './google-auth.js';

const API   = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/** Kód chyby findReceivedInvoices, když složka roku neexistuje (typicky 1. ledna). */
export const ROK_CHYBI = 'GDRIVE_ROK_CHYBI';

// Do pole v nastavení se snadno vloží celá adresa složky místo jejího ID.
export function idSlozky(hodnota) {
  const text = String(hodnota || '').trim();
  return text.match(/\/folders\/([\w-]+)/)?.[1] || text;
}

// ── Chyby Disku ───────────────────────────────────────────────

const ZAPNUTI_API = 'https://console.developers.google.com/apis/api/drive.googleapis.com/overview';
const KONZOLE_GOOGLE = /https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"'<>\\]*[^\s"'<>\\.,;:)]/;
const RADA_NASDILET = 'Nasdílejte složku účtu služby s právem Čtenář.';
const DELKA_TEXTU = 200;

// Tělo chybové odpovědi Googlu na důvod, text a adresu. Text uložený starší verzí
// v gdrive_posledni_chyba je useknutý JSON, proto i čtení bez JSON.parse.
function rozeberOdpoved(telo) {
  const text = String(telo ?? '');
  let json;
  try { json = JSON.parse(text); } catch { /* useknutý JSON nebo jiný formát, níž */ }

  if (json !== undefined) {
    const chyba = json?.error && typeof json.error === 'object' ? json.error : {};
    const pole = (v) => (Array.isArray(v) ? v : []);
    const vlastnosti = pole(chyba.details).map(d => d?.metadata).filter(Boolean);
    return {
      zprava: [chyba.message, json?.error_description, json?.error].find(v => typeof v === 'string') ?? '',
      duvody: [...pole(chyba.errors), ...pole(chyba.details)].map(x => x?.reason).filter(v => typeof v === 'string'),
      aktivace: vlastnosti.map(m => m.activationUrl).find(v => typeof v === 'string') ?? '',
      projekt: vlastnosti.map(m => /\d+/.exec(String(m.consumer ?? m.containerInfo ?? ''))?.[0]).find(Boolean) ?? '',
    };
  }

  const zacatek = text.trimStart()[0];
  return {
    // HTML stránka proxy ani rozbitý JSON nepatří do hlášky, krátký prostý text ano.
    zprava: /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text)?.[1] ?? (['<', '{', '['].includes(zacatek) ? '' : text),
    duvody: [...text.matchAll(/"reason"\s*:\s*"(\w+)"/g)].map(m => m[1]),
    aktivace: /"activationUrl"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? '',
    projekt: '',
  };
}

function adresaZapnutiApi({ zprava, aktivace, projekt }) {
  // Odkaz na stránce smí vést jen do konzole Googlu, ať je v odpovědi cokoli.
  const zOdpovedi = KONZOLE_GOOGLE.exec(aktivace)?.[0] ?? KONZOLE_GOOGLE.exec(zprava)?.[0];
  if (zOdpovedi) return zOdpovedi;
  const cislo = projekt || /project[ =](\d+)/.exec(zprava)?.[1];
  return cislo ? `${ZAPNUTI_API}?project=${cislo}` : ZAPNUTI_API;
}

/**
 * Česká hláška z chybové odpovědi Disku, text pro stránku i pro
 * company_settings.gdrive_posledni_chyba.
 *   status   HTTP kód odpovědi
 *   telo     tělo odpovědi, typicky JSON { error: { message, errors, details } }
 *   predpona začátek hlášky u chyb, ke kterým není rada: kód a krátký text od Googlu
 */
export function popisChybyDisku(status, telo, predpona = `Google Drive API ${status}`) {
  const odpoved = rozeberOdpoved(telo);
  const { zprava, duvody } = odpoved;
  if (status === 403 && (duvody.includes('accessNotConfigured') || duvody.includes('SERVICE_DISABLED')
      || zprava.includes('has not been used in project'))) {
    return `Google Drive API není v projektu Google Cloud zapnuté. Zapněte ji na ${adresaZapnutiApi(odpoved)} a za pár minut to zkuste znovu.`;
  }
  if (status === 404) return `Google Disk složku nebo soubor nenašel (404). ${RADA_NASDILET}`;
  // 403 hlásí i vyčerpaný limit, tam by rada o nasdílení poslala člověka špatným směrem.
  const limit = [...duvody, zprava].some(t => /rate ?limit|limit ?exceeded|quota/i.test(t));
  if (status === 403 && !limit) return `Google Disk odmítl přístup ke složce (403). ${RADA_NASDILET}`;

  const kratky = zprava.replace(/\s+/g, ' ').trim();
  if (!kratky) return `${predpona}.`;
  return `${predpona}: ${kratky.length > DELKA_TEXTU ? `${kratky.slice(0, DELKA_TEXTU - 1).trimEnd()}…` : kratky}`;
}

/** Chyba, u které pomůže nasdílet složku účtu služby (ne vypnuté API, ne limit). */
export function jeChybaPristupu(text) {
  return String(text ?? '').endsWith(RADA_NASDILET);
}

/** Uložený text chyby ke zobrazení: starší verze ukládala surovou odpověď Googlu. */
export function citelnaChyba(text) {
  const ulozeno = String(text ?? '');
  const surova = /^Google Drive API (\d{3}): ([^]*)$/.exec(ulozeno);
  return surova ? popisChybyDisku(Number(surova[1]), surova[2]) : ulozeno;
}

async function api(pathname, params = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${await accessToken([SCOPE])}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Člověk dostane českou hlášku, celá odpověď zůstane pro log (detail).
    throw Object.assign(new Error(popisChybyDisku(res.status, detail)), { status: res.status, detail: detail.slice(0, 500) });
  }
  return res.json();
}

// Vypíše obsah složky (podsložky i soubory)
export async function listChildren(folderId) {
  const out = [];
  let pageToken;
  do {
    const page = await api('/files', {
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink)',
      pageSize: '1000',
      orderBy: 'name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...(page.files || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export async function getFile(fileId) {
  return api(`/files/${fileId}`, {
    fields: 'id, name, mimeType, size, modifiedTime, webViewLink',
    supportsAllDrives: 'true',
  });
}

export async function downloadFile(fileId) {
  const url = new URL(`${API}/files/${fileId}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${await accessToken([SCOPE])}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const text = popisChybyDisku(res.status, detail, `Stažení souboru z Google Disku selhalo (${res.status})`);
    throw Object.assign(new Error(text), { status: res.status, detail: detail.slice(0, 500) });
  }
  return Buffer.from(await res.arrayBuffer());
}

// ── Hledání složek podle názvu ────────────────────────────────

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function normalize(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

const MONTH_NAMES = [
  'leden', 'unor', 'brezen', 'duben', 'kveten', 'cerven',
  'cervenec', 'srpen', 'zari', 'rijen', 'listopad', 'prosinec',
];

// Složka měsíce se jmenuje např. „7. Červenec“, „07 - červenec“ nebo „Červenec“
export function monthOfFolder(name) {
  const n = normalize(name);
  const byNumber = n.match(/^(\d{1,2})\b/);
  if (byNumber) {
    const m = parseInt(byNumber[1], 10);
    if (m >= 1 && m <= 12) return m;
  }
  // „cervenec“ obsahuje i „cerven“, proto se hledá od konce seznamu
  const idx = MONTH_NAMES.findLastIndex(m => n.includes(m));
  return idx >= 0 ? idx + 1 : null;
}

// Projde strukturu <root>/<rok>/<měsíc>/<Přijaté faktury> a vrátí nalezené doklady.
// Když je zadaný jen rok, projdou se všechny měsíce; jinak jen ten jeden.
export async function findReceivedInvoices({ rootFolderId, year, month = null }) {
  const yearStr = String(year);
  const yearFolder = (await listChildren(rootFolderId))
    .find(f => f.mimeType === FOLDER_MIME && normalize(f.name).includes(yearStr));
  if (!yearFolder) {
    throw Object.assign(new Error(`Ve sdílené složce není podsložka pro rok ${yearStr}.`), { code: ROK_CHYBI });
  }

  const monthFolders = (await listChildren(yearFolder.id))
    .filter(f => f.mimeType === FOLDER_MIME)
    .map(f => ({ ...f, month: monthOfFolder(f.name) }))
    .filter(f => f.month && (month === null || f.month === month))
    .sort((a, b) => a.month - b.month);

  const files = [];
  for (const mf of monthFolders) {
    const target = (await listChildren(mf.id))
      .find(f => f.mimeType === FOLDER_MIME && normalize(f.name).includes('prijate'));
    if (!target) continue;

    for (const file of await listChildren(target.id)) {
      if (file.mimeType === FOLDER_MIME) continue;
      if (file.mimeType !== 'application/pdf' && !file.mimeType.startsWith('image/')) continue;
      files.push({ ...file, folderPath: `${yearFolder.name} / ${mf.name} / ${target.name}`, month: mf.month });
    }
  }
  return files;
}
