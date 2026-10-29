/**
 * Společné kousky adaptérů: číslo z odpovědi, datum z odpovědi, součty po
 * dnech, top N segmentů na den a normalizace s logem.
 *
 * Každý adaptér skládá řádky stejně: rozpad (kampaň, kanál, dotaz, produkt)
 * → součet po dnech (`segment_kind = ''`, jediný řádek, který jde do KPI)
 * → ořez rozpadu na top N → normalizace. Kdyby to každý dělal po svém,
 * lišilo by se třídění při shodě, zaokrouhlení i to, kam jdou varování;
 * proto je to tady a adaptéry jen mapují tvar odpovědi své platformy.
 *
 * ## Čísla se nepřevádějí potichu
 *
 * `cislo()` vrací NaN pro nečíselný text („1 234,50“, „n/a“) a 0 jen pro
 * chybějící hodnotu. NaN projde až do `normalizujRadek()`, které ho ohlásí
 * jako varování a nahradí nulou — kdyby `cislo()` vracelo 0 rovnou, hodnota
 * by zmizela beze stopy (hlavička ../normalizace.js). Součet před
 * normalizací (`sectiRadky`) NaN přeskočí a ohlásí; adaptéry proto sbírají
 * jeho varování do `ctx.varovani` a `normalizujRadky()` je zapíše do logu
 * spolu se svými.
 *
 * ## Top N na den, ne na okno
 *
 * Rozpad se řeže na každý den zvlášť (Search Console 50 dotazů na den,
 * Heureka 50 produktů na den): okno se přepisuje po dnech a UNIQUE index
 * tabulky je per den, takže ořez přes celé okno by den s malým provozem
 * připravil o všechny řádky rozpadu.
 *
 * ## Datum z odpovědi
 *
 * Platformy posílají den jako „YYYY-MM-DD“ (Ads, Search Console, Meta,
 * e-shop), „YYYYMMDD“ (GA4), objekt { year, month, day } (Merchant) nebo
 * ISO čas s pásmem (Sklik může). Čas s pásmem se převede na pražský den —
 * „2026-10-04T22:00:00Z“ je pražská půlnoc 5. 10., ne 4. 10.
 */

import { prazskeDatum } from '../../prazsky-cas.js';
import { normalizujRadek, sectiRadky } from '../normalizace.js';

/** Kolik řádků rozpadu na den se nejvýš ukládá (dotazy Search Console, produkty Heureky). */
export const TOP_SEGMENTU = 50;

/**
 * Číslo z hodnoty API: chybějící (null, undefined, '') → 0, řetězec →
 * Number (nečíselný → NaN, schválně — viz hlavička), cokoli jiného než
 * číslo → NaN.
 */
export function cislo(hodnota) {
  if (hodnota == null || hodnota === '') return 0;
  if (typeof hodnota === 'number') return hodnota;
  if (typeof hodnota === 'string') return Number(hodnota.trim());
  return NaN;
}

/** „318467224“, „882-718-1396“, „act_123“, „properties/1“ → jen číslice; cokoli jiného → ''. */
export function jenCislice(text) {
  const s = String(text ?? '').trim().replace(/^(properties\/|customers\/|accounts\/|act_)/, '').replace(/[-\s]/g, '');
  return /^\d+$/.test(s) ? s : '';
}

/** Den z odpovědi API jako „YYYY-MM-DD“, nebo null (viz hlavička). */
export function datumZOdpovedi(hodnota) {
  if (hodnota == null || hodnota === '') return null;
  if (typeof hodnota === 'object') {
    const { year, month, day } = hodnota;
    if (!(Number(year) > 0 && Number(month) > 0 && Number(day) > 0)) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const s = String(hodnota).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) return prazskeDatum(s);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/** `sectiRadky()` s varováními do `ctx.varovani`, když je kam. */
export function sectiSVarovanim(radky, ctx) {
  const { radky: secteno, varovani } = sectiRadky(radky);
  if (varovani.length && Array.isArray(ctx?.varovani)) ctx.varovani.push(...varovani);
  return secteno;
}

/**
 * Denní součty (`segment_kind = ''`) z řádků rozpadu — jeden na (platforma,
 * den). Záporná hodnota (Sklik a Google Ads umí poslat zápornou opravu
 * konverzí) do součtu nevstoupí: řádek rozpadu si ji nese dál a normalizace
 * ji ohlásí, součet by s ní ale ukázal míň konverzí, než mají kampaně
 * dohromady (hlavička ../normalizace.js).
 */
export function souctyPoDnech(radky, ctx) {
  let zapornych = 0;
  const bezZapornych = (radky ?? []).map((r) => {
    const kopie = { ...r, segment_kind: '', segment: '' };
    for (const [k, v] of Object.entries(kopie)) {
      if (typeof v === 'number' && v < 0) { kopie[k] = 0; zapornych++; }
    }
    return kopie;
  });
  if (zapornych && Array.isArray(ctx?.varovani)) ctx.varovani.push(`${zapornych} záporných hodnot rozpadu do denního součtu nevstoupilo`);
  return sectiSVarovanim(bezZapornych, ctx);
}

/**
 * Nejvýš `n` řádků na (platforma, den) podle metrik sestupně (`metriky`
 * je pořadí pro shodu, např. ['clicks', 'impressions']), při úplné shodě
 * podle segmentu. Pořadí dnů podle prvního výskytu.
 */
export function topNaDen(radky, metriky, n = TOP_SEGMENTU) {
  const poradi = Array.isArray(metriky) ? metriky : [metriky];
  const skupiny = new Map();
  for (const r of radky ?? []) {
    const klic = `${r.platform}\u0000${r.date}`;
    if (!skupiny.has(klic)) skupiny.set(klic, []);
    skupiny.get(klic).push(r);
  }
  const vysledek = [];
  for (const skupina of skupiny.values()) {
    skupina.sort((a, b) => {
      for (const m of poradi) {
        const rozdil = (Number(b[m]) || 0) - (Number(a[m]) || 0);
        if (rozdil) return rozdil;
      }
      return String(a.segment).localeCompare(String(b.segment), 'cs');
    });
    vysledek.push(...skupina.slice(0, n));
  }
  return vysledek;
}

/**
 * Řádky adaptéru → řádky pro INSERT přes `normalizujRadek()`. Zahozené
 * řádky (datum mimo okno, neznámý segment) a varování (záporné, nečíselné,
 * zkrácený segment) jdou do logu souhrnně — jeden záznam s počtem a prvními
 * ukázkami, ne tisíc řádků za noc. `varovani` jsou varování ze součtů
 * v `parsuj()`, která se připojí.
 */
export function normalizujRadky(radky, { from, to, platform, log, nazev = platform, varovani = [] } = {}) {
  const vysledek = [];
  const vsechnaVarovani = [...varovani];
  const zahozene = [];
  for (const r of radky ?? []) {
    const n = normalizujRadek(r, { from, to, platform });
    if (n.radek) {
      vysledek.push(n.radek);
      vsechnaVarovani.push(...n.varovani);
    } else {
      zahozene.push(n.duvod);
    }
  }
  if (vsechnaVarovani.length) {
    log?.warn?.({ nazev, pocet: vsechnaVarovani.length, ukazky: vsechnaVarovani.slice(0, 5) },
      `${nazev}: ${vsechnaVarovani.length} varování při normalizaci řádků, první: ${vsechnaVarovani[0]}`);
  }
  if (zahozene.length) {
    log?.warn?.({ nazev, pocet: zahozene.length, ukazky: zahozene.slice(0, 5) },
      `${nazev}: ${zahozene.length} řádků zahozeno, první důvod: ${zahozene[0]}`);
  }
  return vysledek;
}

/** Součet metriky přes řádky (jen pro hlášky `overit()`). */
export function soucet(radky, metrika) {
  return (radky ?? []).reduce((s, r) => s + (Number(r?.[metrika]) || 0), 0);
}

/** Kč pro hlášky: „12 500 Kč“. */
export function kc(castka) {
  return `${new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 }).format(Number(castka) || 0)} Kč`;
}
