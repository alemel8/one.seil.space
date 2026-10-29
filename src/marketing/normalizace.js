/**
 * Jednotný tvar denního řádku statistik pro `marketing_daily_stats`.
 *
 * Každý adaptér (GA4, Google Ads, Sklik, Heureka, …) vrací data jinak —
 * haléře, mikro-koruny, řetězce, záporné „opravy“ z restatementu, data mimo
 * vyžádané okno. Tady se z toho udělá řádek, který jde rovnou do INSERTu,
 * a všechno podezřelé se vrátí jako varování pro log běhu, místo aby to
 * potichu zkreslilo PNO nebo spadlo na CHECK constraintu v databázi.
 *
 * ## Platforma
 *
 * Každý řádek nese `platform` z PLATFORMY — UNIQUE index tabulky i
 * DELETE + INSERT syncu jsou per platforma a adaptér Skliku zapisuje dvě
 * (`sklik` pro vyhledávání, `zbozi` pro kampaně Nákupů; plán D2). Adaptér
 * s jedinou platformou ji nemusí psát do každého řádku: předá ji jako
 * `platform` ve volbách a doplní se tam, kde chybí. Řádek bez platformy
 * nebo s neznámou se zahodí s důvodem — kdyby se platforma cestou ztratila,
 * sečetly by se řádky Skliku a Zboží do jednoho, dlaždice Zboží.cz by
 * ukazovala nulu, celkový součet by přitom seděl a nikdo by si nevšiml.
 *
 * ## Co platí pro čísla
 *
 * - chybějící (null, undefined, '') → 0 potichu — metrika pro platformu
 *   neexistuje,
 * - nečíselné (text, NaN, Infinity, objekt) → 0 s varováním — to je chyba
 *   adaptéru a má být vidět v logu běhu,
 * - záporné → 0 s varováním (Google Ads i Sklik umí poslat zápornou opravu;
 *   do denního součtu nepatří, celý den se stejně přepisuje znovu),
 * - peníze a desetinné metriky na 2 desetinná místa, počty na celé číslo.
 *   `conversions` je desetinné schválně: Google Ads s atribucí podle dat
 *   hlásí 2,5 konverze a zaokrouhlením by se měsíc rozešel s účtem.
 *   Migrace 042 má tytéž sloupce jako NUMERIC; test to proti ní hlídá.
 *
 * Převod haléřů a mikro-korun na Kč dělá adaptér, ne tenhle modul — ten
 * dostává už koruny bez DPH (viz hlavička kpi.js).
 *
 * ## Součet před normalizací
 *
 * `sectiRadky()` sčítá surové řádky (kampaně → den) ještě před
 * zaokrouhlením, ať se haléře nenasčítají; proto i ono hlásí nečíselné
 * hodnoty jako varování — jinak by „1 234,50“ z Heureky zmizelo v nule
 * dřív, než ho normalizace uvidí, a běh by skončil „hotovo“ s nulovými
 * náklady.
 *
 * ## Segmenty
 *
 * `segment_kind = ''` je denní součet platformy a jediný řádek, který
 * vstupuje do KPI; rozpady (kampaň, kanál, dotaz, stránka, země, produkt)
 * jsou doplňkové. Součet proto nikdy nenese segment — kdyby ho adaptér
 * omylem poslal, zahodí se s varováním, jinak by UNIQUE index pustil do
 * tabulky dva „součty“ téhož dne.
 */

import { jenDatum } from '../prazsky-cas.js';

export const PLATFORMY = ['ga4', 'google_ads', 'search_console', 'merchant', 'sklik', 'zbozi', 'heureka', 'meta', 'eshop'];

export const SEGMENT_KINDS = ['', 'campaign', 'channel', 'query', 'page', 'country', 'product'];

export const METRIKY = [
  'cost', 'cost_with_vat', 'impressions', 'clicks', 'conversions', 'conversion_value',
  'sessions', 'total_users', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'purchase_revenue',
  'position_sum', 'approved_items', 'disapproved_items',
  'searches', 'searches_no_result', 'carts_abandoned', 'carts_value',
];

/** Metriky, které smí mít desetinná místa (peníze, konverze podle dat, součet pozic). Ostatní jsou počty. */
export const DESETINNE_METRIKY = ['cost', 'cost_with_vat', 'conversions', 'conversion_value', 'purchase_revenue', 'position_sum', 'carts_value'];

/** Nejdelší uložený segment (název kampaně, dotaz, URL stránky). */
export const MAX_DELKA_SEGMENTU = 300;

/** Na 2 desetinná místa; EPSILON kvůli 1.005 → 1.01 místo 1. */
export function zaokrouhli2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Všechny metriky nulové — základ řádku, do kterého adaptér doplní, co má. */
export function prazdneMetriky() {
  return Object.fromEntries(METRIKY.map(m => [m, 0]));
}

/** Číslo, nebo null, když hodnota není číselná (řetězec s čárkou je schválně nečíselný — „1,000“ je dvojznačné). */
function cislo(hodnota) {
  if (hodnota == null || hodnota === '') return 0;
  const n = typeof hodnota === 'string' ? Number(hodnota.trim()) : typeof hodnota === 'number' ? hodnota : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Datum adaptéru: „YYYY-MM-DD“, Date, ISO s časem i „YYYYMMDD“ z GA4 (dimenze `date`). */
function datumRadku(hodnota) {
  if (typeof hodnota === 'string' && /^\d{8}$/.test(hodnota)) {
    return jenDatum(`${hodnota.slice(0, 4)}-${hodnota.slice(4, 6)}-${hodnota.slice(6, 8)}`);
  }
  return jenDatum(hodnota);
}

function popisHodnoty(hodnota) {
  if (typeof hodnota === 'number') return String(hodnota);
  try { return JSON.stringify(hodnota) ?? String(hodnota); } catch { return String(hodnota); }
}

function zaokrouhliMetriku(metrika, n) {
  return DESETINNE_METRIKY.includes(metrika) ? zaokrouhli2(n) : Math.round(n);
}

/** „2026-10-05 (Tonery)“ — kde se varování stalo; den a segment stačí, běh je per zdroj. */
function kdeVRadku(date, segment) {
  return `${date}${segment ? ` (${segment})` : ''}`;
}

/**
 * Jeden řádek adaptéru → `{ radek, varovani }`, nebo `{ radek: null, duvod }`,
 * když řádek nemá kam patřit (chybějící nebo neznámá platforma, neplatné
 * datum, datum mimo okno `[from, to]`, neznámý druh segmentu). Vrácený
 * řádek má `platform`, `date`, `segment_kind`, `segment` a všech METRIKY
 * jako čísla; ostatní klíče vstupu se nepřenášejí. `platform` ve volbách
 * je výchozí pro řádky, které ji nenesou (viz hlavička).
 */
export function normalizujRadek(radek, { from, to, platform: vychoziPlatforma } = {}) {
  const platform = String(radek?.platform ?? '').trim() || String(vychoziPlatforma ?? '').trim();
  if (!platform) return { radek: null, duvod: 'chybí platforma' };
  if (!PLATFORMY.includes(platform)) return { radek: null, duvod: `neznámá platforma ${JSON.stringify(platform)}` };

  const varovani = [];
  const date = datumRadku(radek?.date);
  if (!date) return { radek: null, duvod: `neplatné datum ${JSON.stringify(radek?.date ?? null)}` };
  if (date < from || date > to) return { radek: null, duvod: `datum ${date} je mimo okno ${from} – ${to}` };

  const segmentKind = radek.segment_kind == null ? '' : String(radek.segment_kind);
  if (!SEGMENT_KINDS.includes(segmentKind)) {
    return { radek: null, duvod: `neznámý druh segmentu ${JSON.stringify(segmentKind)}` };
  }

  let segment = String(radek.segment ?? '').replace(/[\x00-\x1F\x7F]+/g, ' ').trim();
  if (segment.length > MAX_DELKA_SEGMENTU) {
    varovani.push(`segment zkrácen na ${MAX_DELKA_SEGMENTU} znaků: ${segment.slice(0, 40)}…`);
    segment = segment.slice(0, MAX_DELKA_SEGMENTU).trim();
  }
  if (segmentKind === '' && segment !== '') {
    varovani.push(`denní součet nenese segment, „${segment}“ zahozen`);
    segment = '';
  }

  const vysledek = { platform, date, segment_kind: segmentKind, segment };
  const kde = kdeVRadku(date, segment);
  for (const metrika of METRIKY) {
    let n = cislo(radek[metrika]);
    if (n == null) {
      varovani.push(`${metrika} ${kde}: nečíselná hodnota ${popisHodnoty(radek[metrika])} nahrazena nulou`);
      n = 0;
    } else if (n < 0) {
      varovani.push(`${metrika} ${kde}: záporná hodnota ${n} nahrazena nulou`);
      n = 0;
    }
    vysledek[metrika] = zaokrouhliMetriku(metrika, n);
  }
  return { radek: vysledek, varovani };
}

/**
 * Sečte metriky řádků se stejným klíčem (platform, date, segment_kind,
 * segment) → `{ radky, varovani }`. Pro adaptéry, které vrací tentýž den
 * víckrát — Sklik po kampaních, když se chce součet, Heureka po produktech.
 * Pořadí prvního výskytu se drží. Nečíselná hodnota se do součtu nepočítá
 * a ohlásí se stejně jako v `normalizujRadek()` (viz hlavička); řádek bez
 * platformy má `platform: ''` a doplní ji až normalizace z voleb.
 */
export function sectiRadky(radky) {
  const mapa = new Map();
  const varovani = [];
  for (const r of radky ?? []) {
    const platform = String(r.platform ?? '').trim();
    const segmentKind = r.segment_kind ?? '';
    const segment = r.segment ?? '';
    const klic = [platform, r.date, segmentKind, segment].join('\u0000');
    let soucet = mapa.get(klic);
    if (!soucet) {
      soucet = { platform, date: r.date, segment_kind: segmentKind, segment, ...prazdneMetriky() };
      mapa.set(klic, soucet);
    }
    for (const metrika of METRIKY) {
      const n = cislo(r[metrika]);
      if (n == null) {
        varovani.push(`${metrika} ${kdeVRadku(r.date, segment)}: nečíselná hodnota ${popisHodnoty(r[metrika])} nahrazena nulou`);
        continue;
      }
      soucet[metrika] += n;
    }
  }
  for (const soucet of mapa.values()) {
    for (const metrika of METRIKY) soucet[metrika] = zaokrouhliMetriku(metrika, soucet[metrika]);
  }
  return { radky: [...mapa.values()], varovani };
}
