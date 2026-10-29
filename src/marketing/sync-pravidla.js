/**
 * Rozhodovací pravidla nočního syncu marketingových statistik (plán D5).
 *
 * Čisté funkce bez databáze — worker (`src/marketing/sync.js`) jen čte stav
 * z `marketing_sync_runs` a `marketing_sources`, předá ho sem a udělá, co
 * dostane. Obnova po pádu, backoff i okno dat se tak dají otestovat bez
 * Postgresu, stejně jako `rozhodniBeh()` ranní expedice
 * (src/expedice.js:200-224), jejíž tvar se tu drží.
 *
 * ## Proč se přepisuje 14 dní zpět
 *
 * GA4 i Google Ads restatují 24–48 h a atribuci konverzí dopočítávají
 * až 12 dní; Sklik připisuje konverze 30 dní ke dni kliku. Běžné okno je
 * proto `[dnes − 14, dnes − 1]` a zápis každý den přepíše celé okno znovu
 * (DELETE + INSERT v jedné transakci). Včerejšek je poslední den — dnešek
 * je neúplný a zbytečně by ukazoval poloviční čísla.
 *
 * ## První běh
 *
 * Zdroj bez `last_ok_at` ještě nikdy nedoběhl: stáhne historii od `since`,
 * nejvýš však 400 dní zpět (kvóty: Heureka po dnech, Sklik 5 req/s), po
 * kusech `maxDniNaDotaz` adaptéru. Bez `since` (sloupec je v migraci 042
 * nullable) se bere celých 400 dní — tak to říká plán D5 a tak to čeká
 * obsluha, která zdroj napojí a chce vidět historii; kdo ji nechce, nastaví
 * `since` na den napojení. Historie se tahá jen do prvního úspěšného běhu,
 * potom už jen běžné okno — pozdější změna `since` zpětně nic nestáhne.
 *
 * ## Chyby
 *
 * `permanent` (400/401/403 — špatný token, chybějící právo) se neopakuje
 * a čeká na obsluhu; přechodné (timeout, 429, 5xx) dostanou lineární
 * backoff 10/20/30… minut od zápisu chyby (`finished_at`), nejvýš 6 pokusů.
 * Běh visící v `probiha` déle než 30 minut spadl i s procesem a označí se
 * jako chyba, aby se mohl zopakovat. Restart aplikace (redeploy) je
 * nejčastější oprava chyb z prostředí (chybějící GOOGLE_SERVICE_ACCOUNT_JSON
 * nebo MARKETING_SECRETS_KEY): každý dnešní neúspěšný běh zapsaný před
 * startem procesu (`procesOd`) proto dostane jeden pokus navíc, ať byl
 * trvalý, nebo měl vyčerpané pokusy — bez toho by po redeployi čekal na
 * ruční spuštění až do druhého dne.
 *
 * Meze oken procházejí `jenDatum()`: `rozdelOkno()` na neplatné datum vrátí
 * [], místo aby se řetězcové porovnání točilo do přetečení Date.
 */

import { jenDatum, pridejDny } from '../prazsky-cas.js';

export const KONSTANTY = Object.freeze({
  /** Hodina pražského času, od které noční sync smí běžet. */
  prvniHodina: 5,
  /** Běh v „probiha“ starší než tolik minut spadl i s procesem. */
  zaseknutyMin: 30,
  /** Kolikrát se po přechodné chybě zkusí znovu, než si řekne o obsluhu. */
  maxPokusu: 6,
  /** Lineární backoff: pokus × tolik minut. */
  krokBackoffMin: 10,
  /** Kolik dní zpět se při každém běhu přepisuje. */
  prepisDni: 14,
  /** Strop historie při prvním běhu zdroje. */
  prvniBehMaxDni: 400,
});

/** HTTP stavy, které se opakováním nespraví — token, oprávnění, chybný dotaz. */
export const TRVALE_HTTP = [400, 401, 403];

/** Sync smí začít od páté ráno pražského času; víkend ani svátek nevadí, data jsou za včerejšek. */
export function jeVOkneSyncu({ hodina }) {
  return Number(hodina) >= KONSTANTY.prvniHodina;
}

/** Chyba, po které nemá smysl opakovat: adaptér ji označil `permanent`, nebo má trvalý HTTP stav. */
export function jeTrvalaChyba(err) {
  return err?.permanent === true || TRVALE_HTTP.includes(Number(err?.status));
}

/**
 * Co dělat s dnešním automatickým během zdroje. `dnesni` je řádek
 * `marketing_sync_runs` (kind='auto', run_date=dnes) nebo null; čte se
 * z něj `status`, `attempt`, `permanent`, `started_at` a `finished_at`
 * (sync.js při zápisu chyby nastaví `finished_at = NOW()`, jako oznacChybu
 * v expedici — bez něj se backoff měří od startu). `procesOd` je start
 * běžícího procesu (Date nebo ISO řetězec): chyba zapsaná před ním dostane
 * jeden pokus navíc; bez něj (testy čistých pravidel) se restart nebere v úvahu.
 * Vrací `{ akce: 'zalozit'|'nic'|'opakovat'|'oznacit-chybu', duvod }`.
 */
export function rozhodniBehSyncu({ dnesni, now = new Date(), bezi = false, procesOd = null }) {
  if (!dnesni) return { akce: 'zalozit', duvod: 'dnes ještě neběželo' };
  if (dnesni.status === 'hotovo') return { akce: 'nic', duvod: 'dnes už doběhlo' };

  const zacatek = new Date(dnesni.started_at).getTime();

  if (dnesni.status === 'probiha') {
    if (bezi) return { akce: 'nic', duvod: 'běh právě probíhá v tomhle procesu' };
    if (now.getTime() - zacatek < KONSTANTY.zaseknutyMin * 60_000) return { akce: 'nic', duvod: 'běh probíhá' };
    return { akce: 'oznacit-chybu', duvod: 'Běh přerušen restartem serveru' };
  }

  if (dnesni.status === 'chyba') {
    // Backoff se počítá od chvíle, kdy se chyba zapsala — běh po kusech mohl
    // trvat dvacet minut a od startu by se opakoval skoro hned.
    const chybaOd = dnesni.finished_at ? new Date(dnesni.finished_at).getTime() : zacatek;
    // Chyba starší než start procesu: aplikace se mezitím restartovala
    // (typicky redeploy s doplněným klíčem v env) — jeden pokus navíc má
    // přednost před trvalostí i vyčerpanými pokusy.
    const startProcesu = procesOd ? new Date(procesOd).getTime() : NaN;
    if (Number.isFinite(startProcesu) && chybaOd < startProcesu) return { akce: 'opakovat', duvod: 'nový start aplikace po chybě' };
    if (dnesni.permanent) return { akce: 'nic', duvod: 'trvalá chyba (token, oprávnění), čeká se na obsluhu' };
    const pokus = Number(dnesni.attempt) || 1;
    if (pokus >= KONSTANTY.maxPokusu) return { akce: 'nic', duvod: 'vyčerpané pokusy, čeká se na obsluhu' };
    if (now.getTime() - chybaOd < pokus * KONSTANTY.krokBackoffMin * 60_000) {
      return { akce: 'nic', duvod: 'čeká se na další pokus' };
    }
    return { akce: 'opakovat', duvod: `pokus ${pokus + 1}` };
  }

  return { akce: 'nic', duvod: `neznámý stav ${dnesni.status}` };
}

/**
 * Okno dat `{ od, do }` pro běh zdroje: běžně `[dnes − prepisDni, dnes − 1]`;
 * první běh (bez `last_ok_at`) `prvniBehMaxDni` zpět, nebo od `since`, když
 * je pozdější. `since` nikdy nepodleze ani běžné okno — před napojením
 * data nejsou. Když je `od` po `do` (since je dnes), je okno prázdné
 * a `rozdelOkno` vrátí []. `since` i `last_ok_at` chodí z DB jako Date
 * nebo řetězec.
 */
export function oknoSyncu({ zdroj, dnes, prepisDni = KONSTANTY.prepisDni }) {
  const do_ = pridejDny(dnes, -1);
  const since = jenDatum(zdroj?.since);
  const prvniBeh = zdroj?.last_ok_at == null;
  let od = pridejDny(dnes, -(prvniBeh ? KONSTANTY.prvniBehMaxDni : prepisDni));
  if (since && since > od) od = since;
  return { od, do: do_ };
}

/**
 * `[od, do]` po kusech nejvýš `maxDni` dní (včetně obou krajů) — Google
 * Ads i GA4 snesou 31 dní na dotaz, Heureka jeden den. Prázdné okno
 * i neplatná mez → [].
 */
export function rozdelOkno(od, do_, maxDni) {
  const zacatekOkna = jenDatum(od);
  const konecOkna = jenDatum(do_);
  if (!zacatekOkna || !konecOkna) return [];
  const krok = Math.max(1, Math.floor(Number(maxDni)) || 1);
  const kusy = [];
  for (let zacatek = zacatekOkna; zacatek <= konecOkna; zacatek = pridejDny(zacatek, krok)) {
    const konec = pridejDny(zacatek, krok - 1);
    kusy.push({ od: zacatek, do: konec < konecOkna ? konec : konecOkna });
  }
  return kusy;
}

/**
 * Má se poslat upozornění na vysoké PNO? Jen když je práh nastavený, PNO
 * spočítané (null = bez tržeb) a útrata aspoň `minNaklady` — pár korun
 * první den měsíce by jinak křičelo stovky procent.
 */
export function rozhodniAlertPno({ pno, prah, naklady, minNaklady = 500 }) {
  const p = Number(prah);
  if (!(p > 0)) return false;
  if (pno == null || !Number.isFinite(Number(pno))) return false;
  if (!(Number(naklady) >= minNaklady)) return false;
  return Number(pno) > p;
}
