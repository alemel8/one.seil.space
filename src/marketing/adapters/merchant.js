/**
 * Adaptér Google Merchant Center (Merchant API v1: reports + issueresolution).
 *
 * Merchant říká dvě věci, které nikde jinde nejsou: kolik kliků a zobrazení
 * dostal feed (zvlášť bezplatné záznamy ORGANIC a reklamy Nákupů ADS)
 * a kolik položek feedu je schválených a zamítnutých — zamítnuté položky
 * jsou první, co se kontroluje, když Nákupy nepřinášejí. Náklady Merchant
 * nemá (ty jsou v Google Ads), konverze jen u bezplatných záznamů, proto
 * se neukládají.
 *
 *  - `reports:search` s MCQL nad `product_performance_view` po dnech
 *    a `marketing_method` → řádky `segment_kind = 'channel'` se segmentem
 *    ORGANIC / ADS a denní součet (kliky, zobrazení); stránkuje se přes
 *    `pageToken`, 1 000 řádků na stránku;
 *  - `aggregateProductStatuses` → schválené (`activeCount`) a zamítnuté
 *    (`disapprovedCount`) položky; sečtou se záznamy s kontextem
 *    SHOPPING_ADS (když žádný není, všechny) a zapíší se na POSLEDNÍ den
 *    okna — API vrací jen dnešní stav, historii nemá, a přepis okna ho
 *    každou noc posune. Stahuje se jen pro okno, které sahá aspoň
 *    k včerejšku: historické kusy prvního běhu (400 dní po 31 dnech) by
 *    jinak dostaly dnešní stav na konec každého kusu a přehled za minulý
 *    měsíc by ukazoval dnešní počty jako loňské.
 *
 * Datum v reportu chodí jako objekt { year, month, day } (google.type.Date);
 * `datumZOdpovedi()` bere i řetězec, kdyby ho API někdy vracelo tak.
 * Den je v pásmu účtu Merchant Center (`overit()` ho vypisuje).
 *
 * Scope `content` je jediný, který Merchant API má (read-only neexistuje) —
 * klíč service accountu je proto potřeba chránit stejně jako token s právem
 * zápisu. Před prvním voláním je nutná jednorázová registrace Cloud
 * projektu u účtu (`developerRegistration:registerGcp`), viz
 * docs/marketing-platformy.md.
 */

import { prazskyCas, pridejDny } from '../../prazsky-cas.js';
import { prazdneMetriky } from '../normalizace.js';
import { AdapterError, zpravaOvereni } from './chyby.js';
import { googleVolani } from './google.js';
import { cislo, datumZOdpovedi, jenCislice, normalizujRadky, sectiSVarovanim, souctyPoDnech } from './spolecne.js';

export const platform = 'merchant';
export const popis = 'Google Merchant Center';
export const zapisujePlatformy = ['merchant'];
export const potrebujeTajemstvi = false;
export const popisExternalId = 'Číslo účtu Merchant Center (ID účtu vpravo nahoře)';
export const popisParentId = '';
export const maxDniNaDotaz = 31;
export const prepisDni = 14;

export const SCOPE = 'https://www.googleapis.com/auth/content';
export const API = 'https://merchantapi.googleapis.com';
export const PAGE_SIZE = 1000;
const MAX_STRANEK = 50;

/** Číslo účtu z napojení; jiný tvar je trvalá chyba nastavení. */
export function accountId(source) {
  const id = jenCislice(source?.external_id);
  if (!id) {
    throw new AdapterError(
      `Merchant Center: číslo účtu musí být číslo, ne „${String(source?.external_id ?? '').trim()}“ — je vpravo nahoře v Merchant Center`,
      { permanent: true, platform },
    );
  }
  return id;
}

/** MCQL za okno — přesně podle plánu D9. */
export function dotazVykonu(from, to) {
  return `SELECT date, marketing_method, clicks, impressions, click_through_rate FROM product_performance_view WHERE date BETWEEN '${from}' AND '${to}'`;
}

function vysledky(odpoved) {
  const stranky = Array.isArray(odpoved) ? odpoved : odpoved ? [odpoved] : [];
  return stranky.flatMap(s => (Array.isArray(s?.results) ? s.results : []));
}

/**
 * Stav položek z `aggregateProductStatuses`: `{ approved, disapproved,
 * kontext }` ze záznamů SHOPPING_ADS (jinak ze všech), nebo null bez záznamů.
 */
export function stavPolozek(odpoved) {
  const stranky = Array.isArray(odpoved) ? odpoved : odpoved ? [odpoved] : [];
  const zaznamy = stranky.flatMap(s => (Array.isArray(s?.aggregateProductStatuses) ? s.aggregateProductStatuses : []));
  if (!zaznamy.length) return null;
  const nakupy = zaznamy.filter(z => z?.reportingContext === 'SHOPPING_ADS');
  const pouzite = nakupy.length ? nakupy : zaznamy;
  const secti = (klic) => pouzite.reduce((s, z) => s + (Number(cislo(z?.stats?.[klic])) || 0), 0);
  return { approved: secti('activeCount'), disapproved: secti('disapprovedCount'), kontext: nakupy.length ? 'SHOPPING_ADS' : 'vše' };
}

/**
 * `{ vykony, stavy }` (vykony = odpověď nebo stránky reports:search, stavy =
 * odpověď aggregateProductStatuses) → denní součty, kanály ORGANIC/ADS
 * a stav položek na poslední den okna (`ctx.to`, jinak poslední den s daty).
 */
export function parsuj(odpoved, ctx = {}) {
  const kanaly = [];
  for (const r of vysledky(odpoved?.vykony)) {
    const v = r?.productPerformanceView ?? r;
    const date = datumZOdpovedi(v?.date);
    if (!date) continue;
    kanaly.push({
      platform, date, segment_kind: 'channel', segment: String(v?.marketingMethod ?? '').trim() || 'UNKNOWN',
      clicks: cislo(v?.clicks), impressions: cislo(v?.impressions),
    });
  }
  const soucty = souctyPoDnech(kanaly, ctx);
  const stav = stavPolozek(odpoved?.stavy);
  if (stav) {
    const den = datumZOdpovedi(ctx.to) ?? soucty.map(r => r.date).sort().at(-1);
    if (den) {
      let radek = soucty.find(r => r.date === den);
      if (!radek) {
        radek = { platform, date: den, segment_kind: '', segment: '', ...prazdneMetriky() };
        soucty.push(radek);
      }
      radek.approved_items = stav.approved;
      radek.disapproved_items = stav.disapproved;
    }
  }
  return [...soucty, ...sectiSVarovanim(kanaly, ctx)];
}

/** Normalizované řádky Merchant Center za okno [from, to]; stav položek jen pro okno sahající k včerejšku (viz hlavička). `now` jen pro testy. */
export async function fetchDaily({ source, from, to, log, sleep, googleJsonImpl, now = () => new Date() } = {}) {
  const id = accountId(source);
  const vykony = [];
  let pageToken;
  for (let i = 0; i < MAX_STRANEK; i++) {
    const odpoved = await googleVolani(`${API}/reports/v1/accounts/${id}/reports:search`, {
      method: 'POST', body: { query: dotazVykonu(from, to), pageSize: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) },
      scopes: [SCOPE], platform, nazev: 'Merchant reports:search', log, sleep, googleJsonImpl,
    });
    vykony.push(odpoved);
    pageToken = odpoved?.nextPageToken;
    if (!pageToken) break;
  }
  const stavy = [];
  const vcera = pridejDny(prazskyCas(now()).datum, -1);
  if (to >= vcera) {
    pageToken = undefined;
    for (let i = 0; i < MAX_STRANEK; i++) {
      const odpoved = await googleVolani(`${API}/issueresolution/v1/accounts/${id}/aggregateProductStatuses`, {
        params: { pageSize: 100, pageToken }, scopes: [SCOPE], platform, nazev: 'Merchant aggregateProductStatuses', log, sleep, googleJsonImpl,
      });
      stavy.push(odpoved);
      pageToken = odpoved?.nextPageToken;
      if (!pageToken) break;
    }
  } else {
    log?.info?.({ from, to, vcera }, `Merchant: okno ${from}–${to} nekončí včerejškem, dnešní stav položek se k němu nepřipisuje`);
  }
  const varovani = [];
  const radky = parsuj({ vykony, stavy }, { from, to, varovani });
  return normalizujRadky(radky, { from, to, platform, log, nazev: `Merchant ${from}–${to}`, varovani });
}

/** Účet přes Accounts API: název a pásmo. Nikdy nevyhodí. */
export async function overit({ source, log, googleJsonImpl } = {}) {
  try {
    const id = accountId(source);
    const u = await googleVolani(`${API}/accounts/v1/accounts/${id}`, { scopes: [SCOPE], platform, nazev: 'Merchant účet', log, googleJsonImpl, timeoutMs: 20_000 });
    const nazev = u?.accountName ? ` (${u.accountName})` : '';
    return { ok: true, zprava: `Účet ${u?.accountId ?? id}${nazev}, pásmo ${u?.timeZone?.id || 'neznámé'}` };
  } catch (err) {
    return { ok: false, zprava: zpravaOvereni(err, { platform }) };
  }
}
