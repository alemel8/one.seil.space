/**
 * Volání Google API z adaptérů (GA4, Google Ads, Search Console, Merchant).
 *
 * Všechny čtyři jedou přes týž service account (src/google-auth.js) — tady
 * se k `googleJson()` přidá to, co adaptéry potřebují stejně: kontrola, že
 * je klíč v env vůbec nastavený (jinak by každé volání padalo na obecné
 * chybě přihlášení a sync by ji marně opakoval), opakování přechodných
 * chyb přes `sOpakovanim()` (GoogleApiError nese `retryable`: 429, 5xx
 * a síť ano, 400/401/403/404 ne) a převod na AdapterError.
 *
 * `googleJsonImpl` je kvůli testům: googleJson sahá na globální fetch
 * a podepisuje JWT privátním klíčem, takže se místo něj podstrčí funkce,
 * která vrací připravené odpovědi — test přitom vidí přesně URL, scope,
 * hlavičky a tělo, které by šly Googlu. V provozu se nepředává.
 */

import { googleJson, isConfigured, serviceAccountEmail } from '../../google-auth.js';
import { AdapterError, sPrevodemChyb } from './chyby.js';

export { serviceAccountEmail };

/**
 * JSON volání Google API s tokenem service accountu a opakováním
 * přechodných chyb. Chyby jsou AdapterError; chybějící
 * GOOGLE_SERVICE_ACCOUNT_JSON je trvalá chyba s návodem.
 */
export async function googleVolani(url, {
  scopes, method = 'GET', body, params, headers, timeoutMs = 60_000,
  platform = '', nazev = 'Google API', log, sleep, pokusy, googleJsonImpl = googleJson,
} = {}) {
  if (!isConfigured()) {
    throw new AdapterError(
      `${nazev}: GOOGLE_SERVICE_ACCOUNT_JSON není nastavena — bez service accountu Googlu nejde číst GA4, Google Ads, Search Console ani Merchant Center (postup v docs/marketing-platformy.md)`,
      { permanent: true, platform },
    );
  }
  return sPrevodemChyb(() => googleJsonImpl(url, { scopes, method, body, params, headers, timeoutMs }), { platform, nazev, log, sleep, pokusy });
}
