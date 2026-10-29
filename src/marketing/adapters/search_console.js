/**
 * Adaptér Google Search Console (Search Analytics API v3) — organické
 * vyhledávání Googlu.
 *
 * Jediný zdroj, který říká, na co se web ukazuje a kolik to přináší bez
 * placení: kliky, zobrazení a průměrná pozice po dnech, plus rozpad na
 * dotazy. Property je buď doménová (`sc-domain:toneracek.cz`) nebo URL
 * prefix (`https://toneracek.cz/`) — přesně tak, jak ji Search Console
 * vypisuje, jinak API vrátí 403, i když přístup je. Service account musí
 * být přidaný jako uživatel property (stačí omezený).
 *
 * ## Dva dotazy na okno
 *
 *  1. dimenze `date` (rowLimit 1000 — dní je nejvýš 31) → denní součet:
 *     clicks, impressions a `position_sum = position × impressions`, aby
 *     šla průměrná pozice za období spočítat správně váženě
 *     (position_sum / impressions, viz `organikaSearchConsole()` v ../kpi.js);
 *  2. dimenze `date` × `query` (rowLimit 25 000, stránkování `startRow`)
 *     → na každý den top 50 dotazů podle kliků (shoda: zobrazení), ostatní
 *     se neukládají — dlouhý ocas by byl tisíce řádků denně bez užitku.
 *     Anonymizované dotazy Google vůbec neposílá, součty jsou proto vyšší
 *     než součet dotazů; to je vlastnost dat, ne chyba.
 *
 * ## Zpoždění dat
 *
 * Search Console má data 2–3 dny pozadu a `dataState` necháváme výchozí
 * (jen definitivní). Chybějící poslední dny nejsou chyba — sync je doplní
 * dalším během, okno 14 dnů se přepisuje celé. Den je v pásmu PT (Google
 * ho pro Search Console nemění), rozdíl proti pražskému dni se netřeba
 * řešit, data se nesrovnávají s objednávkami po dnech.
 */

import { AdapterError, zpravaOvereni } from './chyby.js';
import { googleVolani, serviceAccountEmail } from './google.js';
import { cislo, datumZOdpovedi, normalizujRadky, sectiSVarovanim, souctyPoDnech, topNaDen, TOP_SEGMENTU } from './spolecne.js';

export const platform = 'search_console';
export const popis = 'Google Search Console';
export const zapisujePlatformy = ['search_console'];
export const potrebujeTajemstvi = false;
export const popisExternalId = 'Property přesně jako v Search Console: sc-domain:toneracek.cz nebo https://toneracek.cz/';
export const popisParentId = '';
export const maxDniNaDotaz = 31;
export const prepisDni = 14;

export const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const API = 'https://searchconsole.googleapis.com/webmasters/v3';
export const TOP_DOTAZU = TOP_SEGMENTU;
export const LIMIT_DNI = 1000;
export const LIMIT_DOTAZU = 25_000;
const MAX_STRANEK_DOTAZU = 4;

/** Property z napojení; prázdná nebo nesmyslná je trvalá chyba nastavení. */
export function siteUrl(source) {
  const s = String(source?.external_id ?? '').trim();
  if (!/^(sc-domain:[^\s/]+|https?:\/\/\S+)$/.test(s)) {
    throw new AdapterError(
      `Search Console: property musí být „sc-domain:doména“ nebo adresa s https:// a lomítkem na konci, ne „${s}“`,
      { permanent: true, platform },
    );
  }
  return s;
}

export function dotazDny(from, to) {
  return { startDate: from, endDate: to, dimensions: ['date'], rowLimit: LIMIT_DNI };
}

export function dotazDotazy(from, to, startRow = 0) {
  return { startDate: from, endDate: to, dimensions: ['date', 'query'], rowLimit: LIMIT_DOTAZU, startRow };
}

function radky(odpoved) {
  const stranky = Array.isArray(odpoved) ? odpoved : odpoved ? [odpoved] : [];
  return stranky.flatMap(s => (Array.isArray(s?.rows) ? s.rows : []));
}

/**
 * `{ dny, dotazy }` (každé odpověď nebo pole stránek searchAnalytics/query)
 * → denní součty a top 50 dotazů na den. Čistá funkce.
 */
export function parsuj(odpoved, ctx = {}) {
  const soucty = [];
  for (const r of radky(odpoved?.dny)) {
    const date = datumZOdpovedi(r?.keys?.[0]);
    if (!date) continue;
    const impressions = cislo(r.impressions);
    soucty.push({
      platform, date, segment_kind: '', segment: '',
      clicks: cislo(r.clicks), impressions,
      position_sum: cislo(r.position) * impressions,
    });
  }
  const dotazy = [];
  for (const r of radky(odpoved?.dotazy)) {
    const date = datumZOdpovedi(r?.keys?.[0]);
    if (!date) continue;
    const impressions = cislo(r.impressions);
    dotazy.push({
      platform, date, segment_kind: 'query', segment: String(r?.keys?.[1] ?? '').trim() || '(bez dotazu)',
      clicks: cislo(r.clicks), impressions,
      position_sum: cislo(r.position) * impressions,
    });
  }
  const dnySouctu = new Set(soucty.map(r => r.date));
  const dopocitane = souctyPoDnech(dotazy.filter(r => !dnySouctu.has(r.date)), ctx);
  if (dopocitane.length && Array.isArray(ctx.varovani)) {
    ctx.varovani.push(`Search Console: součet dne ${dopocitane.map(r => r.date).join(', ')} chybí, dopočítán z dotazů (anonymizované dotazy v něm nejsou)`);
  }
  return [...soucty, ...dopocitane, ...topNaDen(sectiSVarovanim(dotazy, ctx), ['clicks', 'impressions'], TOP_DOTAZU)];
}

async function dotaz(site, telo, { log, sleep, googleJsonImpl, nazev }) {
  return googleVolani(`${API}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST', body: telo, scopes: [SCOPE], platform, nazev, log, sleep, googleJsonImpl,
  });
}

/** Normalizované řádky Search Console za okno [from, to]. */
export async function fetchDaily({ source, from, to, log, sleep, googleJsonImpl } = {}) {
  const site = siteUrl(source);
  const dny = await dotaz(site, dotazDny(from, to), { log, sleep, googleJsonImpl, nazev: 'Search Console (dny)' });
  const dotazy = [];
  for (let strana = 0; strana < MAX_STRANEK_DOTAZU; strana++) {
    const odpoved = await dotaz(site, dotazDotazy(from, to, strana * LIMIT_DOTAZU), { log, sleep, googleJsonImpl, nazev: 'Search Console (dotazy)' });
    dotazy.push(odpoved);
    if ((odpoved?.rows?.length ?? 0) < LIMIT_DOTAZU) break;
  }
  const varovani = [];
  const vysledek = parsuj({ dny, dotazy }, { from, to, varovani });
  return normalizujRadky(vysledek, { from, to, platform, log, nazev: `Search Console ${from}–${to}`, varovani });
}

/** Je property mezi weby service accountu a s jakým oprávněním. Nikdy nevyhodí. */
export async function overit({ source, log, googleJsonImpl } = {}) {
  try {
    const site = siteUrl(source);
    const odpoved = await googleVolani(`${API}/sites`, { scopes: [SCOPE], platform, nazev: 'Search Console weby', log, googleJsonImpl, timeoutMs: 20_000 });
    const weby = Array.isArray(odpoved?.siteEntry) ? odpoved.siteEntry : [];
    const bezLomitka = (u) => String(u ?? '').replace(/\/$/, '');
    const web = weby.find(w => bezLomitka(w?.siteUrl) === bezLomitka(site));
    if (!web) {
      const email = serviceAccountEmail() || 'service accountu';
      const seznam = weby.length ? ` Účet vidí: ${weby.map(w => w.siteUrl).join(', ')}.` : ' Účet nevidí žádný web.';
      return { ok: false, zprava: `Search Console: property ${site} není mezi weby service accountu.${seznam} Přidejte ${email} v Search Console → Nastavení → Uživatelé a oprávnění.` };
    }
    if (web.permissionLevel === 'siteUnverifiedUser') {
      return { ok: false, zprava: `Search Console: property ${site} je neověřená (siteUnverifiedUser) — ověřte vlastnictví webu v Search Console` };
    }
    return { ok: true, zprava: `Property ${site}, oprávnění ${web.permissionLevel || 'neznámé'}` };
  } catch (err) {
    return { ok: false, zprava: zpravaOvereni(err, { platform }) };
  }
}
