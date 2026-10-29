/**
 * Rejstřík adaptérů marketingových platforem.
 *
 * Sync (plán D5) i nastavení e-shopu (D3) potřebují jediné místo, které
 * říká, jaké platformy existují, co od obsluhy chtějí (ID, nadřazené ID,
 * token) a kterým adaptérem se stahují. Všechny adaptéry mají stejný tvar
 * (viz níže), takže sync je volá bez `switch`: `ADAPTERS[source.platform]`.
 *
 * ## Tvar adaptéru (src/marketing/adapters/<platforma>.js)
 *
 *  - `platform`            klíč v marketing_sources.platform
 *  - `popis`               název pro nastavení
 *  - `zapisujePlatformy`   které hodnoty marketing_daily_stats.platform
 *                          zapisuje (sklik → ['sklik', 'zbozi'])
 *  - `potrebujeTajemstvi`  TRUE = nastavení ukáže pole tokenu
 *  - `popisExternalId`     popisek a nápověda pole external_id
 *  - `popisParentId`       popisek pole parent_external_id; '' = pole se neukazuje
 *  - `maxDniNaDotaz`       sync dělí okno na kusy nejvýš tolika dnů
 *  - `prepisDni`           kolik posledních dnů se každou noc přepisuje
 *  - `fetchDaily({ shop, source, from, to, tajemstvi, log, fetchImpl })`
 *                          → normalizované řádky (projdou normalizujRadek,
 *                          denní součet `segment_kind = ''` vždy, když
 *                          platforma pro den něco má); chyby AdapterError
 *  - `parsuj(odpoved, { from, to, varovani })`
 *                          čistá funkce odpověď → řádky (testy s fixturami)
 *  - `overit({ shop, source, tajemstvi, fetchImpl })`
 *                          → { ok, zprava, radku? }, nikdy nevyhodí
 *
 * `tajemstvi` je dešifrovaný token zdroje (../tajemstvi.js); u platformy
 * eshop tajemství pro `x-webhook-secret` podle `webhookSecretEshopu()`.
 * Volby `fetchImpl`, `googleJsonImpl`, `sleep`, `now` a `limit` jsou pro
 * testy, v provozu se nepředávají. Adaptéry Googlu (ga4, google_ads,
 * search_console, merchant) jdou přes `googleJson()` ze src/google-auth.js,
 * `fetchImpl` proto ignorují a testy jim podstrkují `googleJsonImpl`.
 *
 * ## Zboží.cz
 *
 * Vlastní adaptér nemá: statistiky Seznam Nákupů jsou od října 2026 jen ve
 * Skliku a zapisuje je adaptér sklik pod platformou `zbozi`. V seznamu pro
 * nastavení je proto `zbozi` jen jako vysvětlující řádek (`maAdapter:
 * false`), aby obsluha nehledala, kam zadat „klíč Zboží“.
 */

import * as eshop from './eshop.js';
import * as ga4 from './ga4.js';
import * as google_ads from './google_ads.js';
import * as heureka from './heureka.js';
import * as merchant from './merchant.js';
import * as meta from './meta.js';
import * as search_console from './search_console.js';
import * as sklik from './sklik.js';

export { AdapterError, adapterChyba, jeTrvalyStav } from './chyby.js';

export const ADAPTERS = { ga4, eshop, google_ads, search_console, merchant, sklik, heureka, meta };

function polozka(adapter) {
  return {
    platform: adapter.platform,
    popis: adapter.popis,
    potrebujeTajemstvi: adapter.potrebujeTajemstvi,
    popisExternalId: adapter.popisExternalId,
    popisParentId: adapter.popisParentId,
    zapisujePlatformy: adapter.zapisujePlatformy,
    maxDniNaDotaz: adapter.maxDniNaDotaz,
    prepisDni: adapter.prepisDni,
    maAdapter: true,
    poznamka: '',
  };
}

/** Platformy v pořadí pro nastavení (jako PLATFORMY v ../normalizace.js), zbozi jen jako vysvětlení. */
export const PLATFORMY_SEZNAM = [
  polozka(ga4),
  polozka(google_ads),
  polozka(search_console),
  polozka(merchant),
  polozka(sklik),
  {
    platform: 'zbozi',
    popis: 'Zboží.cz (Seznam Nákupy)',
    potrebujeTajemstvi: false,
    popisExternalId: '',
    popisParentId: '',
    zapisujePlatformy: [],
    maxDniNaDotaz: 0,
    prepisDni: 0,
    maAdapter: false,
    poznamka: 'Vlastní napojení se nezakládá: statistiky kampaní Zboží.cz (typ „zbozi“ ve Skliku) stahuje adaptér Sklik a ukládá je pod platformou zbozi.',
  },
  polozka(heureka),
  polozka(meta),
  polozka(eshop),
];

/** Adaptér pro platformu zdroje, nebo null (zbozi, neznámá). */
export function adapterPro(platform) {
  return Object.hasOwn(ADAPTERS, String(platform ?? '')) ? ADAPTERS[platform] : null;
}
