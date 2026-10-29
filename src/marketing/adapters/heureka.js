/**
 * Adaptér Heureka (Conversion measurement reports API,
 * https://api.heureka.group/v1/reports/conversions).
 *
 * Heureka je jediná placená platforma, kde report nese náklady s DPH
 * i bez DPH — do `cost` jde bez DPH jako všude, `cost_with_vat` navíc.
 * Imprese Heureka neposílá (CTR v přehledu zůstává „—“). Report funguje
 * jen s novým dvouskriptovým měřením konverzí (`ocm/sdk.js?version=2`),
 * které e-shop má.
 *
 * ## Jedno volání na den
 *
 * API bere jen `?date=YYYY-MM-DD` (bez stránkování), takže okno se
 * prochází po dnech (`vyctiDny`), mezi dny krátká prodleva a po každé
 * odpovědi se čtou hlavičky `RateLimit-*`, pokud přijdou: při vyčerpaném
 * limitu se počká `reset` sekund (nejvýš minutu), 429 s `Retry-After`
 * opakuje `sOpakovanim()`. Den bez dat vrací prázdné `conversions` a nedá
 * žádný řádek — to není chyba. Oficiální dokumentace
 * (https://api.heureka.group/v1/reports/docs, 29. 10. 2026) zná jen
 * hlavičku `x-heureka-api-key`, stavy 403 (klíč), 422 (datum) a 500
 * a limity ani `RateLimit-*` neuvádí; `x-hg-portal: heureka.cz` se posílá
 * navíc podle brány Heureka Group — neznámou hlavičku server ignoruje.
 *
 * ## Řádky
 *
 * Každý záznam je (den, zdroj kliku, pozice, satelit, karta produktu,
 * položka obchodu, kategorie) s `visits`, `orders`, `revenue`,
 * `costs_with_vat`, `costs_without_vat` (každé total / bidded / not_bidded
 * / free). Denní součet: clicks = Σ visits.total, cost = Σ costs_without_vat
 * .total, cost_with_vat = Σ costs_with_vat.total, conversions = Σ orders
 * .total, conversion_value = Σ revenue.total. Rozpad `segment_kind =
 * 'product'` (segment = ID položky + název) se nejdřív sečte přes zdroje
 * kliku a pak ořeže na 50 produktů s nejvyššími náklady na den.
 *
 * Konverze se připisují ke dni kliku s 30denním oknem → `prepisDni = 30`.
 * Den je pražský kalendářní den (dokumentace: „treated as a Europe/Prague
 * calendar day“). Klíč vzniká v administraci Heureky: Statistiky a reporty
 * → API měření konverzí; špatný klíč vrací 403, ne 401.
 */

import { ceskeDatum, prazskyCas, pridejDny } from '../../prazsky-cas.js';
import { fetchJson } from '../http.js';
import { vyctiDny } from '../obdobi.js';
import { AdapterError, sPrevodemChyb, zpravaOvereni } from './chyby.js';
import { cislo, datumZOdpovedi, kc, normalizujRadky, sectiSVarovanim, souctyPoDnech, topNaDen, TOP_SEGMENTU } from './spolecne.js';

export const platform = 'heureka';
export const popis = 'Heureka';
export const zapisujePlatformy = ['heureka'];
export const potrebujeTajemstvi = true;
export const popisExternalId = 'ID obchodu na Heurece (nepovinné, jen pro přehled — obchod určuje klíč API)';
export const popisParentId = '';
export const maxDniNaDotaz = 31;
export const prepisDni = 30;

export const API = 'https://api.heureka.group/v1/reports/conversions';
export const PORTAL = 'heureka.cz';
export const TOP_PRODUKTU = TOP_SEGMENTU;
export const PRODLEVA_MS = 200;
const MAX_PAUZA_MS = 60_000;

const spi = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function klicApi(tajemstvi) {
  const klic = String(tajemstvi ?? '').trim();
  if (!klic) throw new AdapterError('Heureka: chybí klíč API — uložte ho v nastavení e-shopu (administrace Heureky → Statistiky a reporty → API měření konverzí)', { permanent: true, platform });
  return klic;
}

function napoveda(chyba) {
  if (chyba.status === 401 || chyba.status === 403) {
    return 'Heureka klíč odmítla — zkontrolujte klíč z administrace (Statistiky a reporty → API měření konverzí) a že je typu Měření konverzí';
  }
  if (chyba.status === 429) return 'limit API vyčerpán, běh se zopakuje podle Retry-After';
  return '';
}

/**
 * Pauza v ms podle hlaviček `RateLimit-Remaining` / `RateLimit-Reset`
 * (nebo složené `RateLimit: limit=…, remaining=…, reset=…`): když zbývá 0
 * požadavků, počká se do resetu, nejvýš minutu. Jinak 0.
 */
export function pauzaZHlavicek(headers = {}) {
  let zbyva = headers['ratelimit-remaining'];
  let reset = headers['ratelimit-reset'];
  const slozena = String(headers.ratelimit ?? '');
  if (zbyva == null && slozena) zbyva = slozena.match(/remaining=(\d+)/)?.[1];
  if (reset == null && slozena) reset = slozena.match(/reset=(\d+)/)?.[1];
  if (zbyva == null || Number(zbyva) > 0) return 0;
  const sekundy = Number(reset);
  if (!Number.isFinite(sekundy) || sekundy <= 0) return 0;
  return Math.min(MAX_PAUZA_MS, sekundy * 1000);
}

/** Adresa reportu za den. */
export function urlReportu(den) {
  return `${API}?date=${encodeURIComponent(den)}`;
}

/** Záznamy z odpovědi (`conversions`, případně `data.conversions`). */
export function konverze(odpoved) {
  if (Array.isArray(odpoved?.conversions)) return odpoved.conversions;
  if (Array.isArray(odpoved?.data?.conversions)) return odpoved.data.conversions;
  if (Array.isArray(odpoved?.data)) return odpoved.data;
  return [];
}

/**
 * Odpověď (jedna nebo pole) → denní součty a top 50 produktů na den.
 * `ctx.den` doplní datum záznamům, které ho nenesou. Čistá funkce.
 */
export function parsuj(odpoved, ctx = {}) {
  const tela = Array.isArray(odpoved) ? odpoved : odpoved ? [odpoved] : [];
  const produkty = [];
  for (const telo of tela) {
    for (const k of konverze(telo)) {
      const date = datumZOdpovedi(k?.date) ?? datumZOdpovedi(ctx.den);
      if (!date) continue;
      const polozka = k?.shop_item ?? {};
      const segment = `${String(polozka.id ?? '').trim()} ${String(polozka.name ?? '').trim()}`.trim()
        || (k?.product_card_id != null ? `karta ${k.product_card_id}` : '(bez položky)');
      produkty.push({
        platform, date, segment_kind: 'product', segment,
        clicks: cislo(k?.visits?.total),
        cost: cislo(k?.costs_without_vat?.total),
        cost_with_vat: cislo(k?.costs_with_vat?.total),
        conversions: cislo(k?.orders?.total),
        conversion_value: cislo(k?.revenue?.total),
      });
    }
  }
  const soucty = souctyPoDnech(produkty, ctx);
  const top = topNaDen(sectiSVarovanim(produkty, ctx), ['cost', 'clicks', 'conversions'], TOP_PRODUKTU);
  return [...soucty, ...top];
}

async function stahniDen(den, klic, { fetchImpl, log, sleep }) {
  return sPrevodemChyb(() => fetchJson(urlReportu(den), {
    headers: { 'x-heureka-api-key': klic, 'x-hg-portal': PORTAL }, fetchImpl,
  }), { platform, nazev: `Heureka konverze ${den}`, log, sleep, napoveda });
}

/** Normalizované řádky Heureky za okno [from, to] — jedno volání na den. */
export async function fetchDaily({ from, to, tajemstvi, log, fetchImpl, sleep = spi } = {}) {
  const klic = klicApi(tajemstvi);
  const dny = vyctiDny(from, to);
  const radky = [];
  const varovani = [];
  for (const [i, den] of dny.entries()) {
    if (i > 0) await sleep(PRODLEVA_MS);
    const { json, headers } = await stahniDen(den, klic, { fetchImpl, log, sleep });
    radky.push(...parsuj(json, { from, to, den, varovani }));
    const pauza = pauzaZHlavicek(headers);
    if (pauza > 0) {
      log?.info?.({ den, pauzaMs: pauza }, `Heureka: limit API vyčerpán, čekám ${Math.round(pauza / 1000)} s`);
      await sleep(pauza);
    }
  }
  return normalizujRadky(radky, { from, to, platform, log, nazev: `Heureka ${from}–${to}`, varovani });
}

/** Stáhne včerejšek a ohlásí počet řádků. Nikdy nevyhodí. */
export async function overit({ tajemstvi, log, fetchImpl, sleep = spi, now = () => new Date() } = {}) {
  try {
    const klic = klicApi(tajemstvi);
    const vcera = pridejDny(prazskyCas(now()).datum, -1);
    const { json } = await stahniDen(vcera, klic, { fetchImpl, log, sleep });
    const zaznamy = konverze(json);
    const soucet = parsuj(json, { den: vcera }).find(r => r.segment_kind === '');
    const detail = soucet
      ? `: ${soucet.clicks} návštěv, ${soucet.conversions} objednávek, náklady ${kc(soucet.cost)} bez DPH`
      : ' (buď bez provozu, nebo report za včerejšek ještě není hotový)';
    return { ok: true, zprava: `Klíč platí; za ${ceskeDatum(vcera)} ${zaznamy.length} řádků konverzí${detail}`, radku: zaznamy.length };
  } catch (err) {
    return { ok: false, zprava: zpravaOvereni(err, { platform }) };
  }
}
