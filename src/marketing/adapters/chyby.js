/**
 * Chyby adaptérů marketingových platforem a jejich třídění na trvalé
 * a přechodné.
 *
 * Sync (plán D5) se podle jediného příznaku rozhoduje, co s neúspěšným
 * během: `permanent` = špatný token, chybějící oprávnění, neexistující ID —
 * opakovat nemá smysl, zdroj čeká na obsluhu a jde alert; všechno ostatní
 * (429, 5xx, síť, timeout) dostane backoff 10/20/30 minut. Každý adaptér
 * přitom volá jiné API s jinou třídou chyb (HttpError z ../http.js,
 * GoogleApiError z ../../google-auth.js, TajemstviError při chybějícím
 * šifrovacím klíči), takže se tu všechny převádějí na jeden tvar —
 * AdapterError { permanent, status } — a sync nemusí znát nic jiného
 * (`jeTrvalaChyba()` v ../sync-pravidla.js čte právě `permanent` a `status`).
 *
 * ## Co je trvalé
 *
 * HTTP 4xx kromě 429 (kvóta) a 408 (timeout na straně serveru): 400 je
 * chybný dotaz nebo ID, 401 neplatný token, 403 chybějící právo, 404
 * neexistující objekt. Chybějící šifrovací klíč (TajemstviError) také —
 * bez něj token nejde přečíst a příští pokus dopadne stejně. Chyba bez
 * HTTP stavu (síť, timeout, neznámá výjimka) trvalá není: nevíme, a šest
 * pokusů s backoffem je levnější než zbytečně zastavený zdroj, který čeká
 * na člověka.
 *
 * `retryable` na AdapterError je obrácený `permanent`, aby se AdapterError
 * dal poslat i do `sOpakovanim()` z ../http.js, které čte právě ten příznak.
 *
 * ## Nápověda k chybě
 *
 * Text chyby končí v `marketing_sync_runs.error` a v nastavení u tlačítka
 * „Ověřit připojení“. Holé „HTTP 401“ obsluze neřekne, co udělat, proto
 * adaptéry přes `napoveda` doplňují, kde se token bere a co zkontrolovat.
 * Tajemství do textu nikdy nejde (HttpError má adresu bez query stringu,
 * viz ../http.js).
 */

import { sOpakovanim } from '../http.js';

export class AdapterError extends Error {
  constructor(message, { permanent = false, status, platform = '', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AdapterError';
    /** TRUE = opakování nepomůže (token, oprávnění, ID); sync čeká na obsluhu. */
    this.permanent = permanent === true;
    /** HTTP stav odpovědi, undefined bez odpovědi (síť, timeout, chyba konfigurace). */
    this.status = Number(status) > 0 ? Number(status) : undefined;
    /** Pro `sOpakovanim()`: smí se zkusit znovu, právě když chyba není trvalá. */
    this.retryable = !this.permanent;
    this.platform = platform;
  }
}

/** HTTP stav, který se opakováním nespraví: 4xx kromě 429 (kvóta) a 408 (timeout serveru). */
export function jeTrvalyStav(status) {
  const s = Number(status);
  return s >= 400 && s < 500 && s !== 429 && s !== 408;
}

/**
 * Libovolná chyba → AdapterError. HttpError i GoogleApiError nesou `status`
 * a `retryable`, podle nich se rozhodne `permanent`; TajemstviError je
 * trvalá (bez klíče token nejde přečíst); chyba bez stavu trvalá není.
 * `kontext` jde před hlášku („Sklik token: …“); `napoveda(err)` smí vrátit
 * text, který se přidá za ni.
 */
export function adapterChyba(err, { platform = '', kontext = '', napoveda } = {}) {
  let chyba;
  if (err instanceof AdapterError) {
    chyba = err;
    if (platform && !chyba.platform) chyba.platform = platform;
  } else {
    const status = Number(err?.status) || 0;
    let permanent = false;
    if (err?.name === 'TajemstviError') permanent = true;
    else if (status > 0) permanent = jeTrvalyStav(status) && err?.retryable !== true;
    const text = String(err?.message ?? err ?? 'neznámá chyba');
    chyba = new AdapterError(kontext ? `${kontext}: ${text}` : text, { permanent, status, platform, cause: err });
  }
  const dovetek = typeof napoveda === 'function' ? String(napoveda(chyba) ?? '').trim() : '';
  if (dovetek && !chyba.message.includes(dovetek)) chyba.message = `${chyba.message} — ${dovetek}`;
  return chyba;
}

/**
 * Zavolá `fn` přes `sOpakovanim()` (přechodné chyby se opakují, prodleva
 * roste, `Retry-After` se respektuje) a konečnou chybu převede na
 * AdapterError. `sleep` a `pokusy` jsou tu kvůli testům a přejdou dál.
 */
export async function sPrevodemChyb(fn, { platform = '', nazev = 'volání', log, sleep, pokusy, prodlevaMs, napoveda } = {}) {
  try {
    return await sOpakovanim(fn, { nazev, log, sleep, pokusy, prodlevaMs });
  } catch (err) {
    throw adapterChyba(err, { platform, kontext: nazev, napoveda });
  }
}

/** Text pro `overit()`: hláška chyby, u přechodné s dovětkem, že má smysl to zkusit znovu. */
export function zpravaOvereni(err, { platform = '' } = {}) {
  const chyba = adapterChyba(err, { platform });
  return chyba.permanent ? chyba.message : `${chyba.message} (přechodná chyba — zkuste to za chvíli znovu)`;
}
