/**
 * Adaptér Google Ads (Google Ads API v26, GAQL přes searchStream).
 *
 * Náklady a konverze kampaní po dnech přímo z účtu — ne přes propojení
 * s GA4, které náklady ukazuje jen po kampaních a jen pro přihlášené
 * property. Od 9. 9. 2026 Google Ads API nevyžaduje developer token:
 * úroveň přístupu je vlastnost Cloud projektu (Test → Explorer přes „Apply
 * for access“), a čte se tímtéž service accountem jako GA4, jen se scope
 * `adwords`; e-mail účtu musí být v Google Ads přidaný jako uživatel
 * s právem jen pro čtení (Správce → Přístup a zabezpečení).
 *
 * ## Dotaz
 *
 * Jeden GAQL na okno: `campaign` segmentovaný `segments.date` s metrikami
 * impressions, clicks, cost_micros, conversions, conversions_value,
 * all_conversions. Dny bez útraty v odpovědi nejsou (= 0, ne chyba), takže
 * víkend bez kampaní nedá žádný řádek. Řádky jsou `segment_kind =
 * 'campaign'` (segment = název kampaně; dvě kampaně se stejným názvem se
 * sečtou, UNIQUE index je per segment) a denní součet.
 *
 * ## Jednotky a pásmo
 *
 * `cost_micros` jsou mikro-koruny: 412 350 000 = 412,35 Kč bez DPH (účet
 * v CZK s reverse charge). `conversions` jsou desetinné (atribuce podle
 * dat), proto NUMERIC. Den je v pásmu účtu (`overit()` ho vypisuje).
 * Konverze se dopočítávají až 30 dní zpět → `prepisDni = 30`.
 *
 * ## MCC
 *
 * Hlavička `login-customer-id` jde jen tehdy, když je v `parent_external_id`
 * správcovský účet (agentura, MCC) — u přímo spravovaného účtu by Google
 * vrátil chybu. Zákaznické číslo se posílá bez pomlček.
 */

import { AdapterError, zpravaOvereni } from './chyby.js';
import { googleVolani } from './google.js';
import { cislo, datumZOdpovedi, jenCislice, normalizujRadky, sectiSVarovanim, souctyPoDnech } from './spolecne.js';

export const platform = 'google_ads';
export const popis = 'Google Ads';
export const zapisujePlatformy = ['google_ads'];
export const potrebujeTajemstvi = false;
export const popisExternalId = 'Zákaznické číslo účtu (10 číslic, pomlčky nevadí)';
export const popisParentId = 'Číslo správcovského účtu (MCC) — jen když účet spravuje agentura, jinak prázdné';
export const maxDniNaDotaz = 31;
export const prepisDni = 30;

export const SCOPE = 'https://www.googleapis.com/auth/adwords';
export const VERZE = 'v26';
export const API = `https://googleads.googleapis.com/${VERZE}`;

/** GAQL za okno — přesně podle plánu D9. */
export function gaql(from, to) {
  return 'SELECT segments.date, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, '
    + 'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.all_conversions '
    + `FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}'`;
}

export const GAQL_UCET = 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer';

/** „8827181396“ → „882-718-1396“ pro hlášky. */
export function formatujCid(cid) {
  const s = String(cid ?? '');
  return s.length === 10 ? `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}` : s;
}

/** Zákaznické číslo bez pomlček; cokoli jiného než 10 číslic je trvalá chyba nastavení. */
export function customerId(source) {
  const cid = jenCislice(source?.external_id);
  if (cid.length !== 10) {
    throw new AdapterError(
      `Google Ads: zákaznické číslo musí mít 10 číslic (např. 882-718-1396), ne „${String(source?.external_id ?? '').trim()}“ — je vpravo nahoře v Google Ads`,
      { permanent: true, platform },
    );
  }
  return cid;
}

/** Hlavičky požadavku: `login-customer-id` jen s MCC v parent_external_id. */
export function hlavicky(source) {
  const mcc = jenCislice(source?.parent_external_id);
  return mcc ? { 'login-customer-id': mcc } : {};
}

/** Výsledky ze searchStream: pole dávek `{ results }` (nebo jedna dávka) → ploché pole. */
export function vysledky(odpoved) {
  const davky = Array.isArray(odpoved) ? odpoved : odpoved ? [odpoved] : [];
  return davky.flatMap(d => (Array.isArray(d?.results) ? d.results : []));
}

/** Odpověď searchStream → řádky kampaní (`segment_kind = 'campaign'`) a denní součty. Čistá funkce. */
export function parsuj(odpoved, ctx = {}) {
  const kampane = [];
  for (const r of vysledky(odpoved)) {
    const date = datumZOdpovedi(r?.segments?.date);
    if (!date) continue;
    const m = r?.metrics ?? {};
    kampane.push({
      platform, date, segment_kind: 'campaign',
      segment: String(r?.campaign?.name ?? '').trim() || `Kampaň ${r?.campaign?.id ?? '?'}`,
      impressions: cislo(m.impressions),
      clicks: cislo(m.clicks),
      cost: cislo(m.costMicros) / 1e6,
      conversions: cislo(m.conversions),
      conversion_value: cislo(m.conversionsValue),
    });
  }
  return [...souctyPoDnech(kampane, ctx), ...sectiSVarovanim(kampane, ctx)];
}

async function searchStream(source, query, { log, sleep, googleJsonImpl, nazev }) {
  const cid = customerId(source);
  return googleVolani(`${API}/customers/${cid}/googleAds:searchStream`, {
    method: 'POST', body: { query }, headers: hlavicky(source), scopes: [SCOPE], platform, nazev, log, sleep, googleJsonImpl,
  });
}

/** Normalizované řádky Google Ads za okno [from, to]. */
export async function fetchDaily({ source, from, to, log, sleep, googleJsonImpl } = {}) {
  const odpoved = await searchStream(source, gaql(from, to), { log, sleep, googleJsonImpl, nazev: 'Google Ads searchStream' });
  const varovani = [];
  const radky = parsuj(odpoved, { from, to, varovani });
  return normalizujRadky(radky, { from, to, platform, log, nazev: `Google Ads ${from}–${to}`, varovani });
}

/** Účet přes GAQL `FROM customer`: název, měna, pásmo. Nikdy nevyhodí. */
export async function overit({ source, log, googleJsonImpl } = {}) {
  try {
    const odpoved = await searchStream(source, GAQL_UCET, { log, googleJsonImpl, nazev: 'Google Ads účet' });
    const c = vysledky(odpoved)[0]?.customer;
    if (!c) return { ok: false, zprava: 'Google Ads: dotaz na účet neprošel — odpověď neobsahuje customer (zkontrolujte zákaznické číslo a přístup service accountu)' };
    const mena = c.currencyCode && c.currencyCode !== 'CZK' ? ` — pozor, účet je v ${c.currencyCode}, náklady se čekají v CZK` : `, měna ${c.currencyCode || '?'}`;
    return { ok: true, zprava: `Účet ${formatujCid(c.id ?? customerId(source))}${c.descriptiveName ? ` (${c.descriptiveName})` : ''}${mena}, pásmo ${c.timeZone || 'neznámé'}` };
  } catch (err) {
    return { ok: false, zprava: zpravaOvereni(err, { platform }) };
  }
}
