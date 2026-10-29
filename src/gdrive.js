// Klient Google Drive API v3 přes service account (JWT).
//
// Nastavení:
//   GOOGLE_SERVICE_ACCOUNT_JSON — obsah JSON klíče service accountu (celý JSON
//   v jedné env proměnné). Složku na Disku je potřeba nasdílet e-mailu
//   service accountu (client_email) s právem Čtenář.
//
// Přihlášení (JWT → access token) je od sekce Marketing společné
// v src/google-auth.js: tentýž service account čte i GA4, Search Console
// a Merchant, každý se svým scope. Volání Disku a texty chyb tu zůstávají,
// jak byly.

import { accessToken } from './google-auth.js';

export { isConfigured, serviceAccountEmail } from './google-auth.js';

const API   = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

async function api(pathname, params = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken([SCOPE])}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 404) throw new Error('Složka nebo soubor na Google Disku nenalezen — je nasdílený service accountu?');
    throw new Error(`Google Drive API ${res.status}: ${detail.slice(0, 300)}`);
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
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken([SCOPE])}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Stažení souboru z Google Disku selhalo (${res.status}): ${detail.slice(0, 200)}`);
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
function monthOfFolder(name) {
  const n = normalize(name);
  const byNumber = n.match(/^(\d{1,2})\b/);
  if (byNumber) {
    const m = parseInt(byNumber[1], 10);
    if (m >= 1 && m <= 12) return m;
  }
  const idx = MONTH_NAMES.findIndex(m => n.includes(m));
  return idx >= 0 ? idx + 1 : null;
}

// Projde strukturu <root>/<rok>/<měsíc>/<Přijaté faktury> a vrátí nalezené doklady.
// Když je zadaný jen rok, projdou se všechny měsíce; jinak jen ten jeden.
export async function findReceivedInvoices({ rootFolderId, year, month = null }) {
  const yearStr = String(year);
  const yearFolder = (await listChildren(rootFolderId))
    .find(f => f.mimeType === FOLDER_MIME && normalize(f.name).includes(yearStr));
  if (!yearFolder) {
    throw new Error(`Ve sdílené složce není podsložka pro rok ${yearStr}.`);
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
