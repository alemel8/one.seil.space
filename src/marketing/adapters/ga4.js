/**
 * Adaptér Google Analytics 4 (Data API v1beta) pro sekci Marketing.
 *
 * GA4 je jediná platforma, která vidí trychtýř návštěvy (relace → zobrazení
 * produktu → košík → pokladna → nákup) a zdroj návštěv po kanálech; náklady
 * nemá a tržby z ní jsou jen pro porovnání — bez souhlasu s analytikou
 * nákup nevidí (hlavička ../kpi.js). Stahují se dva reporty:
 *
 *  A. součty po dnech: dimenze `date`, metriky sessions, totalUsers,
 *     newUsers, engagementRate, itemsViewed, addToCarts, checkouts,
 *     ecommercePurchases, purchaseRevenue → řádek `segment_kind = ''`
 *     (newUsers a engagementRate se stahují podle plánu D9, do tabulky
 *     zatím nejdou — nemají sloupec);
 *  B. kanály: dimenze `date` × `sessionSourceMedium`, metriky sessions,
 *     totalUsers, ecommercePurchases, purchaseRevenue → `segment_kind =
 *     'channel'`, segment doslova „google / cpc“, jak ho GA4 vrací; na
 *     kanál Seilu ho překládá `kanalZeSegmentuGa4()` v ../kpi.js. Rozpad
 *     po kampaních (sessionCampaignName) se v první verzi nestahuje.
 *
 * Dva runReporty místo batchRunReports: stránkují se každý zvlášť
 * (limit/offset platí na jeden report) a kvóta tokenů je stejná. Volají se
 * za sebou, ne souběžně — GA4 povoluje 10 souběžných požadavků na property
 * a noční sync může běžet pro víc e-shopů.
 *
 * ## Datum a pásmo
 *
 * Dimenze `date` chodí jako YYYYMMDD v pásmu property (u Toneráčku
 * Europe/Prague; `overit()` pásmo vypisuje, ať se dá zkontrolovat). Data
 * jsou definitivní po 24–48 h, atribuce klíčových událostí se mění až
 * 12 dní → `prepisDni = 14`.
 *
 * ## Součet je povinný
 *
 * Když má den řádky kanálů, ale v reportu A chybí (GA4 prahuje a vzorkuje,
 * nemělo by se to stát), součet se dopočítá z kanálů, aby KPI o den
 * nepřišlo — trychtýř (view_item…) v něm pak chybí, relace a nákupy ne,
 * a běh to ohlásí varováním.
 */

import { AdapterError, zpravaOvereni } from './chyby.js';
import { googleVolani } from './google.js';
import { cislo, datumZOdpovedi, jenCislice, normalizujRadky, souctyPoDnech } from './spolecne.js';

export const platform = 'ga4';
export const popis = 'Google Analytics 4';
export const zapisujePlatformy = ['ga4'];
export const potrebujeTajemstvi = false;
export const popisExternalId = 'ID property (číslo, ne G-…)';
export const popisParentId = '';
export const maxDniNaDotaz = 31;
export const prepisDni = 14;

export const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
export const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
export const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';

/** Strop řádků na jeden runReport (maximum API); víc se stránkuje přes offset. */
export const LIMIT_RADKU = 250_000;
const MAX_STRANEK = 20;

export const METRIKY_SOUCTU = [
  'sessions', 'totalUsers', 'newUsers', 'engagementRate',
  'itemsViewed', 'addToCarts', 'checkouts', 'ecommercePurchases', 'purchaseRevenue',
];
export const METRIKY_KANALU = ['sessions', 'totalUsers', 'ecommercePurchases', 'purchaseRevenue'];

/** ID property z napojení; G-… (ID streamu) ani text neprojdou — API by vrátilo 400 a sync by hlásil trvalou chybu bez vysvětlení. */
export function propertyId(source) {
  const id = jenCislice(source?.external_id);
  if (!id) {
    throw new AdapterError(
      `GA4: ID property musí být číslo (např. 318467224), ne „${String(source?.external_id ?? '').trim()}“ — G-… je ID datového streamu, property je v GA4 → Správa → Nastavení vlastnosti`,
      { permanent: true, platform },
    );
  }
  return id;
}

/** Tělo reportu A (součty po dnech). */
export function dotazSoucty(from, to, offset = 0) {
  return {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: 'date' }],
    metrics: METRIKY_SOUCTU.map(name => ({ name })),
    limit: LIMIT_RADKU,
    offset,
    keepEmptyRows: false,
    returnPropertyQuota: true,
  };
}

/** Tělo reportu B (den × zdroj / médium). */
export function dotazKanaly(from, to, offset = 0) {
  return {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: 'date' }, { name: 'sessionSourceMedium' }],
    metrics: METRIKY_KANALU.map(name => ({ name })),
    limit: LIMIT_RADKU,
    offset,
    keepEmptyRows: false,
    returnPropertyQuota: true,
  };
}

/**
 * Řádky runReportu (jedné odpovědi nebo pole stránek) jako
 * `{ dimenze: { date: '20261005', … }, metriky: { sessions: '142', … } }`
 * — podle názvů v hlavičkách, ne podle pořadí, ať změna pořadí metrik
 * nepřehodí sloupce.
 */
export function radkyReportu(odpoved) {
  const stranky = Array.isArray(odpoved) ? odpoved : odpoved ? [odpoved] : [];
  const vysledek = [];
  for (const s of stranky) {
    const dim = (s?.dimensionHeaders ?? []).map(h => h?.name);
    const met = (s?.metricHeaders ?? []).map(h => h?.name);
    for (const r of s?.rows ?? []) {
      const dimenze = {};
      const metriky = {};
      dim.forEach((n, i) => { dimenze[n] = r?.dimensionValues?.[i]?.value; });
      met.forEach((n, i) => { metriky[n] = r?.metricValues?.[i]?.value; });
      vysledek.push({ dimenze, metriky });
    }
  }
  return vysledek;
}

/**
 * `{ soucty, kanaly }` (každé odpověď runReportu nebo pole stránek) →
 * řádky: denní součet z reportu A, kanály z reportu B, chybějící součty
 * dopočítané z kanálů (viz hlavička). Čistá funkce; `ctx.varovani` sbírá
 * varování ze součtů.
 */
export function parsuj(odpoved, ctx = {}) {
  const soucty = radkyReportu(odpoved?.soucty).map(({ dimenze, metriky }) => ({
    platform, date: datumZOdpovedi(dimenze.date), segment_kind: '', segment: '',
    sessions: cislo(metriky.sessions),
    total_users: cislo(metriky.totalUsers),
    view_item: cislo(metriky.itemsViewed),
    add_to_cart: cislo(metriky.addToCarts),
    begin_checkout: cislo(metriky.checkouts),
    purchase: cislo(metriky.ecommercePurchases),
    purchase_revenue: cislo(metriky.purchaseRevenue),
  }));
  const kanaly = radkyReportu(odpoved?.kanaly).map(({ dimenze, metriky }) => ({
    platform, date: datumZOdpovedi(dimenze.date), segment_kind: 'channel',
    segment: String(dimenze.sessionSourceMedium ?? '').trim() || '(not set)',
    sessions: cislo(metriky.sessions),
    total_users: cislo(metriky.totalUsers),
    purchase: cislo(metriky.ecommercePurchases),
    purchase_revenue: cislo(metriky.purchaseRevenue),
  }));

  const dnySouctu = new Set(soucty.map(r => r.date));
  const dopocitane = souctyPoDnech(kanaly.filter(r => r.date && !dnySouctu.has(r.date)), ctx);
  if (dopocitane.length && Array.isArray(ctx.varovani)) {
    ctx.varovani.push(`GA4: součet dne ${dopocitane.map(r => r.date).join(', ')} v reportu A chybí, dopočítán z kanálů (bez trychtýře)`);
  }
  return [...soucty, ...dopocitane, ...kanaly];
}

async function stahniReport(id, dotaz, { from, to, log, sleep, googleJsonImpl, nazev }) {
  const stranky = [];
  let offset = 0;
  for (let i = 0; i < MAX_STRANEK; i++) {
    const odpoved = await googleVolani(`${DATA_API}/properties/${id}:runReport`, {
      method: 'POST', body: dotaz(from, to, offset), scopes: [SCOPE], platform, nazev, log, sleep, googleJsonImpl,
    });
    stranky.push(odpoved);
    const n = odpoved?.rows?.length ?? 0;
    offset += n;
    if (n < LIMIT_RADKU || offset >= (Number(odpoved?.rowCount) || 0)) break;
  }
  return stranky;
}

/** Normalizované řádky GA4 za okno [from, to]. `googleJsonImpl` a `sleep` jen pro testy. */
export async function fetchDaily({ source, from, to, log, sleep, googleJsonImpl } = {}) {
  const id = propertyId(source);
  const soucty = await stahniReport(id, dotazSoucty, { from, to, log, sleep, googleJsonImpl, nazev: 'GA4 runReport (součty)' });
  const kanaly = await stahniReport(id, dotazKanaly, { from, to, log, sleep, googleJsonImpl, nazev: 'GA4 runReport (kanály)' });
  const varovani = [];
  const radky = parsuj({ soucty, kanaly }, { from, to, varovani });
  return normalizujRadky(radky, { from, to, platform, log, nazev: `GA4 ${from}–${to}`, varovani });
}

/** Property přes Admin API: název, pásmo, měna. Nikdy nevyhodí. */
export async function overit({ source, log, googleJsonImpl } = {}) {
  try {
    const id = propertyId(source);
    const p = await googleVolani(`${ADMIN_API}/properties/${id}`, {
      scopes: [SCOPE], platform, nazev: 'GA4 property', log, googleJsonImpl, timeoutMs: 20_000,
    });
    const nazev = p?.displayName ? ` (${p.displayName})` : '';
    const mena = p?.currencyCode && p.currencyCode !== 'CZK' ? ` — pozor, měna property je ${p.currencyCode}, tržby se čekají v CZK` : '';
    return { ok: true, zprava: `Property ${id}${nazev}, pásmo ${p?.timeZone || 'neznámé'}${mena}` };
  } catch (err) {
    return { ok: false, zprava: zpravaOvereni(err, { platform }) };
  }
}
