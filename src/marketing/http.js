/**
 * HTTP pro marketingové adaptéry: JSON s timeoutem a opakování po přechodné
 * chybě.
 *
 * Noční sync volá osm různých API (Google, Seznam, Heureka, Meta, vlastní
 * e-shop). Každé z nich občas vrátí 429 nebo 5xx, spadne spojení nebo se
 * odpověď táhne minuty. Kdyby si každý adaptér řešil timeout a retry po
 * svém, chovaly by se pokaždé jinak a jeden zaseklý hovor by zdržel celou
 * noc (vzor src/packeta.js:34-44 — `AbortSignal.timeout`, bez něj fetch
 * čeká neomezeně).
 *
 * ## Co se opakuje a co ne
 *
 * Opakuje se jen to, co má `retryable === true`: 429, 5xx, síťová chyba,
 * timeout. 400/401/403 se opakováním nespraví (špatný token, chybějící
 * právo) — ty sync označí jako trvalou chybu a čeká na obsluhu (plán D5).
 * Prodleva roste 2 s, 4 s, 8 s… a `Retry-After` z odpovědi ji může jen
 * prodloužit, nikdy zkrátit; strop 60 s, ať se běh nezasekne na hodinu
 * kvůli jedné hlavičce. Heureka i Sklik `Retry-After` při 429 posílají.
 *
 * ## Timeout platí i pro tělo odpovědi
 *
 * `AbortSignal.timeout` ruší i čtení těla: odpověď 200, která se zasekne
 * uprostřed JSONu (nebo spojení, které server uprostřed těla resetuje), je
 * stejná přechodná chyba jako timeout před hlavičkami. Kdyby se místo toho
 * vrátilo prázdné tělo, vypadal by zaseklý report jako prázdný report —
 * sync by smazal celé okno, nic nevložil a skončil „hotovo“ s nulou řádků,
 * bez opakování a bez alertu. Jen u chybového stavu (≥ 400) je tělo pouhý
 * úryvek do hlášky a chyba čtení se spolkne: stav sám říká, co se stalo,
 * a nesmí se ztratit v chybě čtení.
 *
 * ## Tajemství nejdou do chybové hlášky
 *
 * Meta nese token v query stringu (`access_token=…`) a text chyby končí
 * v `marketing_sync_runs.error` i v logu. Do hlášky jde proto jen adresa
 * bez query.
 */

export class HttpError extends Error {
  constructor(message, { status = 0, retryable = false, body = null, retryAfterMs = null, url = '', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
    this.url = url;
  }
}

/** Adresa bez query stringu a bez přihlašovacích údajů — jen pro hlášky a log. */
export function adresaProLog(url) {
  try {
    const u = new URL(String(url));
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url ?? '').split('?')[0];
  }
}

/**
 * Hlavička `Retry-After` v milisekundách: buď počet sekund, nebo HTTP datum.
 * Null, když chybí nebo je nesmyslná.
 */
export function retryAfterMs(hodnota, now = Date.now()) {
  const s = String(hodnota ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const okamzik = Date.parse(s);
  if (Number.isNaN(okamzik)) return null;
  return Math.max(0, okamzik - now);
}

/** Hlavičky odpovědi jako obyčejný objekt s malými názvy — z `Headers` i z plain objektu falešného fetche. */
function hlavickyJakoObjekt(headers) {
  const vysledek = {};
  if (!headers) return vysledek;
  const polozky = typeof headers.entries === 'function' ? headers.entries() : Object.entries(headers);
  for (const [nazev, hodnota] of polozky) vysledek[String(nazev).toLowerCase()] = String(hodnota);
  return vysledek;
}

function jeSuroveTelo(body) {
  return typeof body === 'string' || body instanceof URLSearchParams || body instanceof Uint8Array
    || (typeof FormData !== 'undefined' && body instanceof FormData)
    || (typeof Blob !== 'undefined' && body instanceof Blob);
}

/**
 * `fetch` s timeoutem, který vrátí `{ status, ok, json, text, headers }`
 * a pro stav ≥ 400 vyhodí `HttpError`. Objektové `body` se pošle jako JSON.
 * `json` je null, když odpověď není JSON (HTML chybová stránka proxy).
 * Síťová chyba a timeout — před hlavičkami i uprostřed čtení těla — jsou
 * `HttpError{ status: 0, retryable: true }`.
 *
 * `fetchImpl` a `now` jsou tu kvůli testům.
 */
export async function fetchJson(url, {
  method = 'GET', headers = {}, body, timeoutMs = 30_000, fetchImpl = globalThis.fetch, now = Date.now,
} = {}) {
  const h = new Headers(headers);
  if (!h.has('accept')) h.set('accept', 'application/json');
  let telo = body;
  if (body != null && !jeSuroveTelo(body)) {
    telo = JSON.stringify(body);
    if (!h.has('content-type')) h.set('content-type', 'application/json');
  }

  const adresa = adresaProLog(url);
  /** Timeout nebo pád spojení jako přechodná HttpError — tatáž hláška před hlavičkami i uprostřed těla. */
  const prechodnaChyba = (err) => {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const popis = timeout ? `odpověď nepřišla do ${timeoutMs / 1000} s` : `síťová chyba: ${err?.message ?? err}`;
    return new HttpError(`${method} ${adresa}: ${popis}`, { status: 0, retryable: true, url: adresa, cause: err });
  };

  let res;
  try {
    res = await fetchImpl(url, { method, headers: h, body: telo, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw prechodnaChyba(err);
  }

  const status = Number(res.status) || 0;
  let text = '';
  if (typeof res.text === 'function') {
    try {
      text = String((await res.text()) ?? '');
    } catch (err) {
      // U úspěšného stavu je tělo celý report a přerušené čtení znamená, že
      // report nemáme (viz hlavička). U chybového stavu je jen úryvek do hlášky.
      if (status < 400) throw prechodnaChyba(err);
    }
  }
  let json = null;
  if (text.trim()) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  const odpovedHlavicky = hlavickyJakoObjekt(res.headers);

  if (status >= 400) {
    const uryvek = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new HttpError(`${method} ${adresa}: HTTP ${status}${uryvek ? ` — ${uryvek}` : ''}`, {
      status,
      retryable: status === 429 || status >= 500,
      body: json ?? text,
      retryAfterMs: retryAfterMs(odpovedHlavicky['retry-after'], now()),
      url: adresa,
    });
  }

  return { status, ok: res.ok ?? (status >= 200 && status < 300), json, text, headers: odpovedHlavicky };
}

/** Nejdelší prodleva mezi pokusy, i kdyby `Retry-After` chtělo víc. */
export const MAX_PRODLEVA_MS = 60_000;

const spi = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Zavolá `fn(pokus)` a při chybě s `retryable === true` to zkusí znovu —
 * celkem nejvýš `pokusy`×. Prodleva před i-tým opakováním je
 * `max(prodlevaMs · 2^(i−1), err.retryAfterMs)`, nejvýš MAX_PRODLEVA_MS.
 * Každé opakování zapíše `log.warn`; poslední chyba se vyhodí dál.
 * `sleep` je injektovatelný, aby testy neběžely vteřiny.
 */
export async function sOpakovanim(fn, { pokusy = 3, prodlevaMs = 2000, log, nazev = 'volání', sleep = spi } = {}) {
  let posledni;
  for (let pokus = 1; pokus <= pokusy; pokus++) {
    try {
      return await fn(pokus);
    } catch (err) {
      posledni = err;
      if (err?.retryable !== true || pokus >= pokusy) throw err;
      const prodleva = Math.min(MAX_PRODLEVA_MS, Math.max(prodlevaMs * 2 ** (pokus - 1), err.retryAfterMs || 0));
      log?.warn?.({ err, nazev, pokus, prodlevaMs: prodleva },
        `${nazev}: pokus ${pokus} z ${pokusy} selhal (${err?.message ?? err}), další za ${Math.round(prodleva / 1000)} s`);
      await sleep(prodleva);
    }
  }
  throw posledni;
}
