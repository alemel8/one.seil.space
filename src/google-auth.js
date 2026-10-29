/**
 * Service account Googlu: přihlášení (JWT → access token) a volání JSON API.
 *
 * Zobecnění toho, co mělo src/gdrive.js jen pro Google Disk. Tentýž klíč
 * z env GOOGLE_SERVICE_ACCOUNT_JSON slouží i sekci Marketing (GA4 Data
 * API, Google Ads, Search Console, Merchant), jen s jinými scope. Token se
 * proto drží zvlášť pro každou sadu scope (klíč cache = seřazené scope):
 * token pro Disk nepustí do GA4 a naopak, a jedna sada si nepřepisuje
 * token druhé.
 *
 * Bez knihovny: podpis RS256 přes node:crypto, přenos přes fetch
 * s AbortSignal.timeout (vzor src/packeta.js). Bez timeoutu čeká fetch
 * minuty a noční sync by na jednom zaseklém volání stál celý.
 *
 * Chyby se vracejí jako GoogleApiError { status, retryable }: 429, 5xx
 * a síťová chyba se smí zkusit znovu (sync má backoff), 400/401/403/404 ne.
 * U 403 text říká operátorovi, co udělat — přidat e-mail service accountu
 * jako čtenáře — protože to je zdaleka nejčastější příčina.
 *
 * Nastavení: GOOGLE_SERVICE_ACCOUNT_JSON = celý obsah JSON klíče service
 * accountu v jedné env proměnné (escapovaná \n v privátním klíči se
 * přeloží). E-mail účtu (client_email) se přidává jako čtenář tam, odkud
 * má číst: složka na Disku, vlastnost GA4, web v Search Console, účet
 * Merchant Center, účet Google Ads.
 */

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Jak dlouho před vypršením se token bere jako prošlý (síť, hodiny Googlu). */
const REZERVA_MS = 60_000;

/** Token na sadu scope: klíč = seřazené scope spojené mezerou → { token, expiresAt }. */
const tokeny = new Map();

export class GoogleApiError extends Error {
  constructor(message, { status = 0, retryable = false, detail = '' } = {}) {
    super(message);
    this.name = 'GoogleApiError';
    /** HTTP stav odpovědi, 0 = odpověď nepřišla (síť, timeout). */
    this.status = status;
    /** TRUE = má smysl to zkusit znovu později (429, 5xx, síť). */
    this.retryable = retryable;
    /** Začátek těla chybové odpovědi pro log, do 500 znaků. */
    this.detail = detail;
  }
}

export function isConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

function credentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON není nastavena.');
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON není platný JSON.');
  }
  if (!json.client_email || !json.private_key) {
    throw new Error('V GOOGLE_SERVICE_ACCOUNT_JSON chybí client_email nebo private_key.');
  }
  // Klíč se do env proměnných často vkládá s escapovanými novými řádky
  return { email: json.client_email, key: json.private_key.replace(/\\n/g, '\n') };
}

export function serviceAccountEmail() {
  try { return credentials().email; } catch { return null; }
}

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Scope jako seřazené pole bez duplicit; prázdné = chyba programátora, ne nastavení. */
function seznamScope(scopes) {
  const pole = [...new Set((Array.isArray(scopes) ? scopes : [scopes]).map((s) => String(s ?? '').trim()).filter(Boolean))].sort();
  if (!pole.length) throw new Error('accessToken(): chybí scope.');
  return pole;
}

function jeOpakovatelny(status) {
  return status === 429 || status >= 500;
}

function popisSitoveChyby(err, timeoutMs) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `vypršel čas (${Math.round(timeoutMs / 1000)} s)`;
  return err?.cause?.message || err?.message || 'síťová chyba';
}

/** Zahodí tokeny v paměti — po změně klíče v env nebo v testech. */
export function vymazTokeny() {
  tokeny.clear();
}

/**
 * Access token service accountu pro danou sadu scope (řetězec nebo pole).
 * Z cache, dokud platí s rezervou; jinak nový JWT podepsaný privátním
 * klíčem a výměna na oauth2.googleapis.com.
 */
export async function accessToken(scopes, { timeoutMs = 20_000 } = {}) {
  const klic = seznamScope(scopes).join(' ');
  const ulozeny = tokeny.get(klic);
  if (ulozeny && ulozeny.expiresAt > Date.now() + REZERVA_MS) return ulozeny.token;

  const { email, key } = credentials();
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: email, scope: klic, aud: TOKEN_URL,
    iat: now, exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new GoogleApiError(`Přihlášení service accountu Googlu neproběhlo: ${popisSitoveChyby(err, timeoutMs)}`,
      { retryable: true, detail: String(err?.message ?? '').slice(0, 500) });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GoogleApiError(`Google odmítl přihlášení service accountu: ${body.error_description || body.error || res.status}`,
      { status: res.status, retryable: jeOpakovatelny(res.status), detail: JSON.stringify(body).slice(0, 500) });
  }

  tokeny.set(klic, { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 });
  return body.access_token;
}

function zpravaChyby(status, host, detail) {
  if (status === 403) {
    const email = serviceAccountEmail() || 'service accountu';
    return `Google API (${host}) odmítlo přístup (403). Přidejte e-mail ${email} jako čtenáře tam, odkud má číst `
      + '(GA4: Správa přístupu k vlastnosti, Search Console: Uživatelé, Merchant Center: Lidé a přístup, '
      + `Google Ads: Přístup a zabezpečení, Disk: Sdílet), a zkontrolujte, že je příslušné API v Google Cloud zapnuté. ${detail}`.trim();
  }
  if (status === 401) return `Google API (${host}) nepřijalo token (401): ${detail}`.trim();
  if (status === 404) return `Google API (${host}) nenašlo požadovaný objekt (404), zkontrolujte ID: ${detail}`.trim();
  if (status === 429) return `Google API (${host}) hlásí vyčerpanou kvótu (429), zkusí se znovu později: ${detail}`.trim();
  if (status >= 500) return `Google API (${host}) má výpadek (${status}), zkusí se znovu později: ${detail}`.trim();
  return `Google API (${host}) vrátilo ${status}: ${detail}`.trim();
}

/**
 * JSON volání Google API s tokenem service accountu:
 *
 *   googleJson('https://analyticsdata.googleapis.com/v1beta/properties/1:runReport',
 *     { scopes: ['https://www.googleapis.com/auth/analytics.readonly'], method: 'POST', body: { … } })
 *
 * `params` jde do query stringu (null a undefined se vynechají), `body` se
 * posílá jako JSON. Vrací rozparsovanou odpověď (204 → null). Chyba HTTP
 * i sítě je GoogleApiError, stejně tak 2xx s nečitelným tělem (HTML místo
 * JSON od proxy nebo z hrany Googlu — k opakování); po 401 se token dané
 * sady scope zahodí, ať si příští volání vezme nový.
 */
export async function googleJson(url, { scopes, params = {}, method = 'GET', body, headers = {}, timeoutMs = 30_000 } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  const token = await accessToken(scopes);

  let res;
  try {
    res = await fetch(u, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new GoogleApiError(`Google API (${u.host}) neodpovědělo: ${popisSitoveChyby(err, timeoutMs)}`,
      { retryable: true, detail: String(err?.message ?? '').slice(0, 500) });
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 500);
    if (res.status === 401) tokeny.delete(seznamScope(scopes).join(' '));
    throw new GoogleApiError(zpravaChyby(res.status, u.host, detail),
      { status: res.status, retryable: jeOpakovatelny(res.status), detail });
  }
  if (res.status === 204) return null;
  // Tělo jako text a parsování zvlášť: 2xx s HTML místo JSON má být
  // GoogleApiError s retryable (a začátkem těla v detailu pro log), ne holý
  // SyntaxError, který by sync bral jako neznámou chybu a zdroj by uzavřel.
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new GoogleApiError(`Google API (${u.host}) vrátilo nečitelnou odpověď (${res.status}): ${err.message}`,
      { status: res.status, retryable: true, detail: text.slice(0, 500) });
  }
}
