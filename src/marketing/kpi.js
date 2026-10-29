/**
 * KPI marketingového přehledu: čisté výpočty + SQL, které jim dodává čísla
 * (plán D4). Databázi berou SQL pomocníci parametrem `sql`, nic se tu
 * neimportuje — přehled i testy si ji podstrčí.
 *
 * ## Definice (jediné místo, kde platí)
 *
 * - **Tržby** = Σ `shop_orders.total_price` / 1,21. Objednávka nese celé Kč
 *   s 21 % DPH (toneracek.js:496-501); tržby se v marketingu srovnávají
 *   s náklady bez DPH, takže i ony jsou bez DPH. Dělí se až součet, ne každá
 *   objednávka zvlášť (haléře by se nasčítaly).
 * - **Den** objednávky = pražský den `created_at` (vzor podminkaKExpedici,
 *   src/expedice.js:299-311): `created_at >= (od::date::timestamp AT TIME
 *   ZONE 'Europe/Prague')`, horní mez obdobně s `do + 1`. Rozsah na
 *   `created_at` využije index.
 * - **Stavy**: počítá se všechno kromě `Stornována` a `Platba se nezdařila`.
 *   `Čeká na platbu` zůstává — je to konverze; když ji storno vyřadí, zmizí
 *   zpětně. Vedle toho „z toho zaplaceno“ (`zaplaceno` u řádku, vždy
 *   TRUE/FALSE, nikdy NULL) podle `podminkaZaplaceno()`.
 * - **Náklady** = Σ `marketing_daily_stats.cost` (bez DPH, jen `segment_kind
 *   = ''`) + ruční náklady z `marketing_manual_costs` rozpočítané rovnoměrně
 *   po dnech na překryv s obdobím. Obojí se sčítá — ruční náklad za dny,
 *   které má platforma už z API, je v součtu dvakrát a `prekryvRucnichNakladu()`
 *   to hlásí, aby to přehled ukázal.
 * - **PNO** = náklady / tržby bez DPH × 100 (česká praxe: obojí bez DPH).
 *   **ROAS** = tržby / náklady. **CPA** = náklady / počet objednávek.
 *   **Průměrná objednávka** = tržby / počet. **Zisk** = marže − náklady.
 *   **ROI** = zisk / náklady × 100. Dělení nulou → `null` (UI ukáže „—“).
 * - **Marže** z položek bez pseudo-řádků (SLEVA-REG, DOPRAVA, DOBIRKA —
 *   `jePseudoPolozka`, místní kopie z expedice.js): s `cost_price` → (price/1,21 − nákupní bez DPH) × qty
 *   (nákupní s DPH se nejdřív dělí 1,21); bez ní → price/1,21 × qty ×
 *   `shops.marketing_margin_pct`/100; bez obojího nic, jen do koše
 *   `bezMarze`. Dlaždice nese podíl odhadu.
 * - **Kanál objednávky** = poslední dotyk (`*_last`), první jen informativně.
 *   Pořadí: click-id → placené médium + zdroj (i ve tvaru hostu: „google.com“
 *   z kopírované šablony sledování je Google Ads) → zdroj heureka/zbozi → médium
 *   e-mail / organic / social → host referreru → direct. Bez `touch_last_at`
 *   (objednávka před nasazením atribuce, e-shop ji neposlal) → `neznamy`.
 *   Totéž jádro `kanalZeZdrojeAMedia()` sdílí rozpad GA4.
 * - **Porovnání** Seil × platforma: |Δ| ≤ ODCHYLKA_OK_PCT (10 %) ok,
 *   ≤ ODCHYLKA_VAROVANI_PCT (25 %) varování, jinak chyba (pravidlo ±10 %
 *   z 90denního plánu).
 *
 * ## Peníze
 *
 * Kč jako čísla na 2 desetinná místa; haléře a mikro-koruny převádí
 * adaptér. `NUMERIC` sloupce se v SQL přetypují na `float8`, protože
 * postgres.js je jinak vrací jako řetězce (stejně jako `SUM(int)` → bigint
 * → řetězec, proto `::int`).
 */

import { jenDatum } from '../prazsky-cas.js';
import { zaokrouhli2 } from './normalizace.js';
import { rozdilDni, vyctiDny } from './obdobi.js';

// ── DPH a kanály ───────────────────────────────────────────────

/** Zrcadlí e-shop: všechno zboží v 21 % sazbě, ceny objednávek jsou s DPH. */
export const SAZBA_DPH = 21;

/** Cena s DPH → bez DPH, na haléře. */
export function bezDph(sDph) {
  return zaokrouhli2((Number(sDph) || 0) / (1 + SAZBA_DPH / 100));
}

/**
 * Dopočtené řádky e-shopu mezi položkami objednávky (doprava, dobírka,
 * sleva za registraci) — do tržeb za zboží ani do marže nepatří.
 *
 * sjednotit s expedice.js: kopie `PSEUDO_SKU` a `jePseudoPolozka`
 * (src/expedice.js:59,96-98). Import odtamtud by do čistého modulu i do
 * jeho testu přitáhl db.js, email.js a push.js (nativní better-sqlite3,
 * čtvrt vteřiny při startu a pád testu na stroji bez sestaveného modulu);
 * až bude seznam v samostatném modulu, vzít ho odtamtud. Test hlídá, že se
 * kopie od expedice.js neliší.
 */
export const PSEUDO_SKU = ['SLEVA-REG', 'DOPRAVA', 'DOBIRKA'];

export function jePseudoPolozka(sku) {
  return PSEUDO_SKU.includes(String(sku ?? '').trim().toUpperCase());
}

export const KANALY = [
  'google_ads', 'sklik', 'zbozi', 'heureka', 'meta', 'placene_jine',
  'organic', 'email', 'social', 'referral', 'direct', 'neznamy',
];

export const KANAL_POPIS = {
  google_ads: 'Google Ads',
  sklik: 'Sklik',
  zbozi: 'Zboží.cz',
  heureka: 'Heureka',
  meta: 'Meta (Facebook, Instagram)',
  placene_jine: 'Placené ostatní',
  organic: 'Organické vyhledávání',
  email: 'E-mail',
  social: 'Sociální sítě',
  referral: 'Odkazující weby',
  direct: 'Přímý přístup',
  neznamy: 'Neznámý (bez atribuce)',
};

/** Kanály, za které se platí — mají řádek nákladů i vlastní platformu. */
export const KANALY_PLACENE = ['google_ads', 'sklik', 'zbozi', 'heureka', 'meta', 'placene_jine'];

/** Stavy objednávek, které do tržeb nepatří. */
export const STAVY_MIMO_TRZBY = ['Stornována', 'Platba se nezdařila'];

const CLICK_ID_KANAL = {
  gclid: 'google_ads', gbraid: 'google_ads', wbraid: 'google_ads',
  fbclid: 'meta',
  sznclid: 'sklik', sznaiid: 'sklik',
  hgtid: 'heureka', aku: 'heureka',
};

const PLACENA_MEDIA = ['cpc', 'ppc', 'paid', 'cpm', 'display', 'paidsocial', 'paid_social', 'paid-social'];

const PLACENE_ZDROJE = {
  google: 'google_ads',
  seznam: 'sklik', sklik: 'sklik',
  facebook: 'meta', instagram: 'meta', meta: 'meta',
  heureka: 'heureka', 'heureka.cz': 'heureka',
  zbozi: 'zbozi', 'zbozi.cz': 'zbozi',
};

const MEDIA_EMAIL = ['email', 'e-mail', 'newsletter'];
const MEDIA_SOCIAL = ['social', 'social-network', 'social-media', 'social_network', 'social_media', 'sm'];

const norm = (x) => String(x ?? '').trim().toLowerCase();
const bezWww = (host) => host.replace(/^www\./, '');
const jeHost = (s) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s);

const HOST_GOOGLE = /(^|\.)google\.[a-z.]+$/;
const HOST_VYHLEDAVAC = /(^|\.)(google|bing|duckduckgo|ecosia)\.[a-z.]+$/;
const HOST_SEZNAM = /(^|\.)seznam\.cz$/;
const HOST_HEUREKA = /(^|\.)heureka\.[a-z.]+$/;
const HOST_ZBOZI = /(^|\.)zbozi\.cz$/;
const HOST_META = /(^|\.)((facebook|instagram)\.[a-z.]+|fb\.(com|me))$/;

/** Kanál podle hostu referreru; '' pro prázdný host. */
function kanalZHostu(host) {
  if (!host) return '';
  if (HOST_VYHLEDAVAC.test(host) || HOST_SEZNAM.test(host)) return 'organic';
  if (HOST_HEUREKA.test(host)) return 'heureka';
  if (HOST_ZBOZI.test(host)) return 'zbozi';
  if (HOST_META.test(host)) return 'social';
  return 'referral';
}

/**
 * Placený zdroj ve tvaru hostu → platforma: `utm_source=google.com` nebo
 * `seznam.cz` s `cpc` je běžné při kopírování šablon sledování a jsou to
 * tytéž kampaně jako `google` / `seznam`. '' pro host bez vlastní platformy
 * (bing.com) — ten zůstává „placené ostatní“.
 */
function placenyKanalZHostu(host) {
  if (HOST_GOOGLE.test(host)) return 'google_ads';
  if (HOST_SEZNAM.test(host)) return 'sklik';
  if (HOST_META.test(host)) return 'meta';
  if (HOST_HEUREKA.test(host)) return 'heureka';
  if (HOST_ZBOZI.test(host)) return 'zbozi';
  return '';
}

/**
 * Jádro atribuce: zdroj + médium (+ host referreru, + druh click-id) → kanál.
 * Pořadí přesně podle plánu D4; vstupy se trimují a převádí na malá písmena,
 * `www.` se u hostů ignoruje. Zdroj ve tvaru hostu projde pravidly hostu:
 * v placené větvi rovnou („google.com / cpc“ je Google Ads), jinak až když
 * referrer chybí (GA4 referral „l.facebook.com / referral“).
 */
export function kanalZeZdrojeAMedia(source, medium, referrerHost = '', clickIdKind = '') {
  const clickId = norm(clickIdKind);
  if (CLICK_ID_KANAL[clickId]) return CLICK_ID_KANAL[clickId];

  const zdroj = bezWww(norm(source));
  const medium_ = norm(medium);
  if (PLACENA_MEDIA.includes(medium_)) {
    return PLACENE_ZDROJE[zdroj] ?? ((jeHost(zdroj) && placenyKanalZHostu(zdroj)) || 'placene_jine');
  }
  if (zdroj === 'heureka' || zdroj === 'heureka.cz') return 'heureka';
  if (zdroj === 'zbozi' || zdroj === 'zbozi.cz') return 'zbozi';
  if (MEDIA_EMAIL.includes(medium_)) return 'email';
  if (medium_ === 'organic') return 'organic';
  if (MEDIA_SOCIAL.includes(medium_)) return 'social';

  const host = bezWww(norm(referrerHost)) || (jeHost(zdroj) ? zdroj : '');
  const zHostu = kanalZHostu(host);
  if (zHostu) return zHostu;
  if (medium_ === 'referral') return 'referral';
  return 'direct';
}

/** Kanál objednávky podle posledního dotyku; bez `touch_last_at` e-shop atribuci neposlal → 'neznamy'. */
export function kanalObjednavky(o) {
  if (o?.touch_last_at == null) return 'neznamy';
  return kanalZeZdrojeAMedia(o.utm_source_last, o.utm_medium_last, o.referrer_host_last, o.click_id_kind_last);
}

/** Totéž pro první dotyk — jen informativně (plán D4). */
export function kanalPrvnihoDotyku(o) {
  if (o?.touch_first_at == null) return 'neznamy';
  return kanalZeZdrojeAMedia(o.utm_source_first, o.utm_medium_first, o.referrer_host_first, o.click_id_kind_first);
}

/**
 * Objednávky → `{ kanaly: { [kanal]: { pocet, trzbyBezDph } }, pokrytiAtribuce }`.
 * Všechny kanály jsou v mapě i s nulou, ať má tabulka stálé řádky.
 * `pokrytiAtribuce` = podíl objednávek s `touch_last_at` (0..1; bez
 * objednávek 0 — přehled pak ukáže i sloupec GA4).
 */
export function rozdelPodleKanalu(objednavky) {
  const kanaly = Object.fromEntries(KANALY.map(k => [k, { pocet: 0, trzbyBezDph: 0 }]));
  const soucty = Object.fromEntries(KANALY.map(k => [k, 0]));
  let sAtribuci = 0;
  for (const o of objednavky ?? []) {
    const kanal = kanalObjednavky(o);
    kanaly[kanal].pocet += 1;
    soucty[kanal] += Number(o.total_price) || 0;
    if (o.touch_last_at != null) sAtribuci += 1;
  }
  for (const k of KANALY) kanaly[k].trzbyBezDph = bezDph(soucty[k]);
  const pocet = (objednavky ?? []).length;
  return { kanaly, pokrytiAtribuce: pocet ? sAtribuci / pocet : 0 };
}

// ── Marže a náklady ────────────────────────────────────────────

/**
 * Marže z položek objednávek. Řádek `{ sku, price (s DPH za kus), quantity,
 * cost_price, cost_price_vat_included }`:
 * - `cost_price` známá → (price/1,21 − nákupní bez DPH) × qty → `zname`,
 * - jinak při `marzePct > 0` → price/1,21 × qty × marzePct/100 → `odhadnute`,
 * - jinak nic; tržba bez DPH takových položek jde do `bezMarze`.
 * Pseudo-položky (doprava, dobírka, sleva) se přeskakují.
 * `podilOdhadu` = podíl tržeb bez DPH, u kterých je marže jen odhad
 * (0..1 z tržeb s nějakou marží); `trzbyZbozi` = tržby bez DPH všech
 * započtených položek.
 */
export function marzeObjednavek(polozky, marzePct) {
  const pct = Number(marzePct) || 0;
  const delitel = 1 + SAZBA_DPH / 100;
  let zname = 0, odhadnute = 0, bezMarze = 0, trzbyZname = 0, trzbyOdhad = 0;

  for (const p of polozky ?? []) {
    if (jePseudoPolozka(p.sku)) continue;
    const qty = Number(p.quantity) || 0;
    const cenaBezDph = (Number(p.price) || 0) / delitel;
    const trzba = cenaBezDph * qty;
    const nakupni = p.cost_price == null || p.cost_price === '' ? null : Number(p.cost_price);

    if (nakupni != null && Number.isFinite(nakupni)) {
      const nakupniBezDph = p.cost_price_vat_included === true ? nakupni / delitel : nakupni;
      zname += (cenaBezDph - nakupniBezDph) * qty;
      trzbyZname += trzba;
    } else if (pct > 0) {
      odhadnute += trzba * pct / 100;
      trzbyOdhad += trzba;
    } else {
      bezMarze += trzba;
    }
  }

  const sMarzi = trzbyZname + trzbyOdhad;
  return {
    marze: zaokrouhli2(zname + odhadnute),
    zname: zaokrouhli2(zname),
    odhadnute: zaokrouhli2(odhadnute),
    bezMarze: zaokrouhli2(bezMarze),
    podilOdhadu: sMarzi > 0 ? trzbyOdhad / sMarzi : 0,
    trzbyZbozi: zaokrouhli2(sMarzi + bezMarze),
  };
}

/** Překryv `[date_from, date_to]` nákladu s `[od, do]` a jeho délka; null bez překryvu. */
function prekryvNakladu(naklad, od, do_) {
  const from = jenDatum(naklad?.date_from);
  const to = jenDatum(naklad?.date_to);
  if (!from || !to || from > to) return null;
  const zacatek = from > od ? from : od;
  const konec = to < do_ ? to : do_;
  if (zacatek > konec) return null;
  const dniCelkem = rozdilDni(from, to) + 1;
  const amount = Number(naklad.amount);
  if (!Number.isFinite(amount)) return null;
  return { zacatek, konec, naDen: amount / dniCelkem };
}

/**
 * Část ručního nákladu připadající na období: částka se rozprostře
 * rovnoměrně po dnech `[date_from, date_to]` (včetně obou) a sečte se
 * překryv s `[od, do]`. Data chodí z DB jako Date i jako řetězec.
 */
export function rozpoctiManualniNaklad(naklad, od, do_) {
  const prekryv = prekryvNakladu(naklad, od, do_);
  if (!prekryv) return 0;
  return zaokrouhli2(prekryv.naDen * (rozdilDni(prekryv.zacatek, prekryv.konec) + 1));
}

/**
 * Totéž po dnech: `{ 'YYYY-MM-DD': částka }` jen pro dny překryvu, bez
 * zaokrouhlení (zaokrouhluje se až součet nebo zobrazení). Pro graf a pro
 * varování „API i ruční náklad pro tutéž platformu a den“.
 */
export function rozpoctiManualniNakladPoDnech(naklad, od, do_) {
  const prekryv = prekryvNakladu(naklad, od, do_);
  if (!prekryv) return {};
  return Object.fromEntries(vyctiDny(prekryv.zacatek, prekryv.konec).map(den => [den, prekryv.naDen]));
}

/**
 * Varování „API i ruční náklad pro tutéž platformu a den“ (plán D4): ruční
 * náklady proti dnům, za které má platforma náklad z API. `apiDny` jsou
 * řádky `{ platform, den }` z `dnyNakladuPlatforem()`. Vrací
 * `[{ platform, dny, idNakladu }]` jen pro platformy s překryvem, dny
 * vzestupně a jen v `[od, do]`, platformy abecedně. Součet nákladů se tím
 * nemění — obojí se počítá, a právě proto to má být vidět.
 */
export function prekryvRucnichNakladu(rucniNaklady, apiDny, od, do_) {
  const apiPodlePlatformy = new Map();
  for (const r of apiDny ?? []) {
    const platform = String(r?.platform ?? '');
    const den = jenDatum(r?.den);
    if (!platform || !den) continue;
    if (!apiPodlePlatformy.has(platform)) apiPodlePlatformy.set(platform, new Set());
    apiPodlePlatformy.get(platform).add(den);
  }

  const prekryvy = new Map();
  for (const naklad of rucniNaklady ?? []) {
    const platform = String(naklad?.platform ?? '');
    const dnyApi = apiPodlePlatformy.get(platform);
    if (!dnyApi) continue;
    const dny = Object.keys(rozpoctiManualniNakladPoDnech(naklad, od, do_)).filter(den => dnyApi.has(den));
    if (!dny.length) continue;
    let p = prekryvy.get(platform);
    if (!p) {
      p = { platform, dny: new Set(), idNakladu: [] };
      prekryvy.set(platform, p);
    }
    for (const den of dny) p.dny.add(den);
    if (naklad.id != null) p.idNakladu.push(naklad.id);
  }

  return [...prekryvy.values()]
    .map(p => ({ platform: p.platform, dny: [...p.dny].sort(), idNakladu: p.idNakladu }))
    .sort((a, b) => a.platform.localeCompare(b.platform));
}

// ── KPI ────────────────────────────────────────────────────────

const podil = (citatel, jmenovatel) => (jmenovatel > 0 ? zaokrouhli2(citatel / jmenovatel) : null);

/**
 * `{ pno, roas, cpa, prumerna, zisk, roi }` — PNO a ROI v procentech,
 * dělení nulou → null, `marze` null → zisk i roi null.
 */
export function spoctiKpi({ trzbyBezDph, pocetObjednavek, naklady, marze = null }) {
  const trzby = Number(trzbyBezDph) || 0;
  const pocet = Number(pocetObjednavek) || 0;
  const n = Number(naklady) || 0;
  const m = marze == null || marze === '' ? null : Number(marze);
  const zisk = m == null || !Number.isFinite(m) ? null : zaokrouhli2(m - n);
  return {
    pno: trzby > 0 ? zaokrouhli2(n / trzby * 100) : null,
    roas: podil(trzby, n),
    cpa: podil(n, pocet),
    prumerna: podil(trzby, pocet),
    zisk,
    roi: zisk == null || !(n > 0) ? null : zaokrouhli2(zisk / n * 100),
  };
}

/** Porovnání Seil × platforma (plán D4): do ±10 % zelený badge, do ±25 % oranžový, dál červený. */
export const ODCHYLKA_OK_PCT = 10;
export const ODCHYLKA_VAROVANI_PCT = 25;

/**
 * Hodnota Seilu (zdroj pravdy) proti hodnotě platformy → `{ rozdilPct, stav }`.
 * `rozdilPct` je odchylka platformy od Seilu v procentech (1 desetinné místo).
 * |Δ| ≤ ODCHYLKA_OK_PCT → 'ok', ≤ ODCHYLKA_VAROVANI_PCT → 'varovani', jinak
 * 'chyba'; obě nuly → ok, jedna nula → chyba (rozdíl 100 %, nebo null, když
 * Seil nemá nic).
 */
export function porovnej(hodnotaSeil, hodnotaPlatformy) {
  const seil = Number(hodnotaSeil) || 0;
  const platforma = Number(hodnotaPlatformy) || 0;
  if (seil === 0 && platforma === 0) return { rozdilPct: 0, stav: 'ok' };
  if (seil === 0) return { rozdilPct: null, stav: 'chyba' };
  const rozdilPct = Math.round((platforma - seil) / Math.abs(seil) * 1000) / 10;
  if (platforma === 0) return { rozdilPct, stav: 'chyba' };
  const abs = Math.abs(rozdilPct);
  const stav = abs <= ODCHYLKA_OK_PCT ? 'ok' : abs <= ODCHYLKA_VAROVANI_PCT ? 'varovani' : 'chyba';
  return { rozdilPct, stav };
}

/**
 * Řádky `{ den, castka }` (tvar `trzbyPoDnech()` a `nakladyPoDnech()`, den
 * i jako Date) nebo mapa `{ 'YYYY-MM-DD': částka }` (tvar
 * `rozpoctiManualniNakladPoDnech()`) → Map den → částka; duplicitní dny
 * se sečtou, neplatné přeskočí.
 */
function naMapuDni(vstup) {
  const mapa = new Map();
  const polozky = Array.isArray(vstup) ? vstup.map(r => [r?.den, r?.castka]) : Object.entries(vstup ?? {});
  for (const [den, hodnota] of polozky) {
    const d = jenDatum(den);
    if (d) mapa.set(d, (mapa.get(d) ?? 0) + (Number(hodnota) || 0));
  }
  return mapa;
}

/**
 * Řady pro graf: každý den období, i bez dat (nula), popisky „1. 10.“,
 * tržby bez DPH, náklady a PNO dne (null bez tržeb).
 */
export function radyProGraf({ od, do: do_, trzbyPoDnech, nakladyPoDnech }) {
  const trzbyMapa = naMapuDni(trzbyPoDnech);
  const nakladyMapa = naMapuDni(nakladyPoDnech);
  const dny = vyctiDny(od, do_);   // chybějící, obrácené nebo neplatné období → []
  const trzby = dny.map(den => zaokrouhli2(trzbyMapa.get(den) ?? 0));
  const naklady = dny.map(den => zaokrouhli2(nakladyMapa.get(den) ?? 0));
  return {
    dny,
    popisky: dny.map(den => `${Number(den.slice(8, 10))}. ${Number(den.slice(5, 7))}.`),
    trzby,
    naklady,
    pno: dny.map((_, i) => (trzby[i] > 0 ? zaokrouhli2(naklady[i] / trzby[i] * 100) : null)),
  };
}

// ── GA4 rozpad ─────────────────────────────────────────────────

/**
 * Segment řádku GA4 (`segment_kind = 'channel'`) → kanál. Adaptér ukládá
 * „zdroj / médium“ (sessionSourceMedium, plán D2), které projde stejným
 * jádrem jako objednávky; cokoli jiného je 'neznamy'. Názvy výchozích
 * skupin kanálů GA4 se schválně nepřekládají: „Paid Search“ by skončilo
 * v „placené ostatní“, i když je to Google Ads nebo Sklik, a srovnání se
 * Seilem by bylo špatně už z principu — kdyby je někdy adaptér ukládal,
 * přeloží si je sám nad fixturou.
 */
export function kanalZeSegmentuGa4(segment) {
  const s = norm(segment);
  if (!s.includes(' / ')) return 'neznamy';
  const [source, medium] = s.split(' / ');
  return kanalZeZdrojeAMedia(source, medium);
}

/** Řádky `kanalyGa4()` sečtené do našich kanálů — všechny kanály, i nulové. */
export function seskupKanalyGa4(radky) {
  const vysledek = Object.fromEntries(KANALY.map(k => [k, { sessions: 0, total_users: 0, purchase: 0, purchase_revenue: 0 }]));
  for (const r of radky ?? []) {
    const cil = vysledek[kanalZeSegmentuGa4(r.segment)];
    cil.sessions += Number(r.sessions) || 0;
    cil.total_users += Number(r.total_users) || 0;
    cil.purchase += Number(r.purchase) || 0;
    cil.purchase_revenue += Number(r.purchase_revenue) || 0;
  }
  for (const k of KANALY) vysledek[k].purchase_revenue = zaokrouhli2(vysledek[k].purchase_revenue);
  return vysledek;
}

// ── SQL ────────────────────────────────────────────────────────

/** Pražský den `created_at` v `[od, do]` — rozsah na sloupci, ať se použije index (alias `o`). */
export function podminkaObdobi(sql, od, do_) {
  return sql`o.created_at >= (${od}::date::timestamp AT TIME ZONE 'Europe/Prague')
    AND o.created_at < ((${do_}::date + 1)::timestamp AT TIME ZONE 'Europe/Prague')`;
}

/**
 * „Objednávka je zaplacená“ jako SQL výraz, vždy TRUE nebo FALSE: karta se
 * pozná ze stavu nebo podaného balíku, převod jen ze zálohové faktury
 * `Zaplacena` (alias `p`, LATERAL jako v objednavkySeStavemSkladu), dobírka
 * při převzetí. Očekává aliasy `o` (shop_orders) a `p` (poslední zálohovka).
 *
 * sjednotit s expedice.js: řádek se stavy i tři větve platby jsou doslovná
 * kopie z `podminkaKExpedici` (src/expedice.js:306-311) — expedice.js právě
 * upravuje jiný agent; až bude mít `podminkaZaplaceno(sql)`, vzít ji
 * odtamtud. Stavy jsou v kopii schválně: stornovaná objednávka kartou
 * s číslem zásilky ani „Čeká na platbu“ nesmí vyjít jako zaplacená, ať se
 * výraz použije v kterémkoli dotazu. COALESCE kvůli převodu bez zálohovky:
 * `p.status` je z LEFT JOIN NULL a `NULL = 'Zaplacena'` by dalo NULL místo
 * FALSE — dlaždice „z toho zaplaceno“ by takové objednávky neuměla ani
 * vyloučit. Test hlídá, že se kopie od expedice.js neliší.
 */
export function podminkaZaplaceno(sql) {
  return sql`COALESCE((
        o.status NOT IN ('Stornována', 'Čeká na platbu', 'Platba se nezdařila')
    AND (
         (o.payment_method = 'Platba kartou'   AND (o.status IN ('Zaplaceno', 'Vyřízena') OR o.tracking_number <> ''))
      OR (o.payment_method = 'Bankovní převod' AND p.status = 'Zaplacena')
      OR  o.payment_method = 'Dobírka'
    )
  ), FALSE)`;
}

/**
 * Objednávky e-shopu za období (bez storen a neúspěšných plateb), nejstarší
 * první: základní sloupce, `total_price` jako číslo, `zaplaceno`, všechny
 * atribuční sloupce `*_first`/`*_last`, `touch_*_at` a `attribution_consent`.
 */
export async function objednavkyZaObdobi(sql, { shopId, od, do: do_ }) {
  return sql`
    SELECT o.id, o.order_number, o.status, o.payment_method,
           o.total_price::float8 AS total_price, o.created_at,
           ${podminkaZaplaceno(sql)} AS zaplaceno,
           o.utm_source_first, o.utm_medium_first, o.utm_campaign_first, o.utm_term_first, o.utm_content_first,
           o.click_id_kind_first, o.click_id_first, o.referrer_host_first, o.landing_page_first, o.touch_first_at,
           o.utm_source_last, o.utm_medium_last, o.utm_campaign_last, o.utm_term_last, o.utm_content_last,
           o.click_id_kind_last, o.click_id_last, o.referrer_host_last, o.landing_page_last, o.touch_last_at,
           o.attribution_consent
    FROM shop_orders o
    LEFT JOIN LATERAL (
      SELECT status FROM accounting_invoices
      WHERE order_id = o.id AND type = 'proforma'
      ORDER BY (status = 'Zaplacena') DESC, created_at DESC
      LIMIT 1
    ) p ON TRUE
    WHERE o.shop_id = ${shopId}
      AND ${podminkaObdobi(sql, od, do_)}
      AND o.status NOT IN ${sql(STAVY_MIMO_TRZBY)}
    ORDER BY o.created_at, o.id`;
}

/** Položky objednávek pro marži; prázdný seznam id → [] bez dotazu. */
export async function polozkyObjednavek(sql, orderIds) {
  if (!orderIds?.length) return [];
  return sql`
    SELECT order_id, sku, name, quantity, price::float8 AS price,
           cost_price::float8 AS cost_price, cost_price_vat_included
    FROM shop_order_items
    WHERE order_id = ANY(${orderIds}::text[])
    ORDER BY id`;
}

/** Náklady API po platformách: `{ platform, naklady, naklady_s_dph, od, do, dni }` (jen denní součty). */
export async function nakladyPlatforem(sql, { shopId, od, do: do_ }) {
  return sql`
    SELECT platform,
           COALESCE(SUM(cost), 0)::float8 AS naklady,
           COALESCE(SUM(cost_with_vat), 0)::float8 AS naklady_s_dph,
           MIN(date)::text AS od, MAX(date)::text AS do, COUNT(*)::int AS dni
    FROM marketing_daily_stats
    WHERE shop_id = ${shopId} AND segment_kind = '' AND date BETWEEN ${od} AND ${do_}
    GROUP BY platform
    ORDER BY platform`;
}

/** Náklady API po dnech přes všechny platformy: `{ den, castka }`. */
export async function nakladyPoDnech(sql, { shopId, od, do: do_ }) {
  return sql`
    SELECT date::text AS den, COALESCE(SUM(cost), 0)::float8 AS castka
    FROM marketing_daily_stats
    WHERE shop_id = ${shopId} AND segment_kind = '' AND date BETWEEN ${od} AND ${do_}
    GROUP BY date
    ORDER BY date`;
}

/** Dny, za které má platforma náklad z API (`cost > 0`, jen denní součty): `{ platform, den }` — pro `prekryvRucnichNakladu()`. */
export async function dnyNakladuPlatforem(sql, { shopId, od, do: do_ }) {
  return sql`
    SELECT platform, date::text AS den
    FROM marketing_daily_stats
    WHERE shop_id = ${shopId} AND segment_kind = '' AND cost > 0 AND date BETWEEN ${od} AND ${do_}
    ORDER BY platform, date`;
}

/** Tržby bez DPH a počet objednávek po pražských dnech: `{ den, pocet, castka, trzbySDph }`. */
export async function trzbyPoDnech(sql, { shopId, od, do: do_ }) {
  const rows = await sql`
    SELECT to_char(o.created_at AT TIME ZONE 'Europe/Prague', 'YYYY-MM-DD') AS den,
           COUNT(*)::int AS pocet,
           COALESCE(SUM(o.total_price), 0)::float8 AS trzby_s_dph
    FROM shop_orders o
    WHERE o.shop_id = ${shopId}
      AND ${podminkaObdobi(sql, od, do_)}
      AND o.status NOT IN ${sql(STAVY_MIMO_TRZBY)}
    GROUP BY 1
    ORDER BY 1`;
  return rows.map(r => ({ den: r.den, pocet: r.pocet, castka: bezDph(r.trzby_s_dph), trzbySDph: Number(r.trzby_s_dph) || 0 }));
}

/** Ruční náklady, jejichž období zasahuje do `[od, do]`; data jako „YYYY-MM-DD“, částka číslo. Sloupce podle migrace 042 (vč. `created_at`). */
export async function rucniNaklady(sql, { shopId, od, do: do_ }) {
  return sql`
    SELECT id, platform, date_from::text AS date_from, date_to::text AS date_to,
           amount::float8 AS amount, note, invoice_id, receipt_id, created_by, created_at
    FROM marketing_manual_costs
    WHERE shop_id = ${shopId} AND date_from <= ${do_} AND date_to >= ${od}
    ORDER BY date_from, id`;
}

/** Funnel GA4 za období (součet denních řádků) — jeden objekt, `dni` = kolik dní má data. */
export async function funnelGa4(sql, { shopId, od, do: do_ }) {
  const [row] = await sql`
    SELECT COUNT(*)::int AS dni,
           COALESCE(SUM(sessions), 0)::int AS sessions,
           COALESCE(SUM(total_users), 0)::int AS total_users,
           COALESCE(SUM(view_item), 0)::int AS view_item,
           COALESCE(SUM(add_to_cart), 0)::int AS add_to_cart,
           COALESCE(SUM(begin_checkout), 0)::int AS begin_checkout,
           COALESCE(SUM(purchase), 0)::int AS purchase,
           COALESCE(SUM(purchase_revenue), 0)::float8 AS purchase_revenue
    FROM marketing_daily_stats
    WHERE shop_id = ${shopId} AND platform = 'ga4' AND segment_kind = '' AND date BETWEEN ${od} AND ${do_}`;
  return row ?? { dni: 0, sessions: 0, total_users: 0, view_item: 0, add_to_cart: 0, begin_checkout: 0, purchase: 0, purchase_revenue: 0 };
}

/** Rozpad GA4 po kanálech (`segment_kind = 'channel'`), nejvíc návštěv první. */
export async function kanalyGa4(sql, { shopId, od, do: do_ }) {
  return sql`
    SELECT segment,
           SUM(sessions)::int AS sessions, SUM(total_users)::int AS total_users,
           SUM(purchase)::int AS purchase, SUM(purchase_revenue)::float8 AS purchase_revenue,
           SUM(conversions)::float8 AS conversions, SUM(conversion_value)::float8 AS conversion_value
    FROM marketing_daily_stats
    WHERE shop_id = ${shopId} AND platform = 'ga4' AND segment_kind = 'channel' AND date BETWEEN ${od} AND ${do_}
    GROUP BY segment
    ORDER BY 2 DESC, 1`;
}

/**
 * Organika ze Search Console: `{ celkem: { dni, clicks, impressions, pozice },
 * dotazy: [{ dotaz, clicks, impressions, pozice }] }` — top 20 dotazů podle
 * kliků. `position_sum` je Σ(pozice × imprese), průměrná pozice tedy
 * position_sum / impressions.
 */
export async function organikaSearchConsole(sql, { shopId, od, do: do_ }) {
  const [[celkem], dotazy] = await Promise.all([
    sql`
      SELECT COUNT(*)::int AS dni,
             COALESCE(SUM(clicks), 0)::int AS clicks,
             COALESCE(SUM(impressions), 0)::int AS impressions,
             COALESCE(SUM(position_sum), 0)::float8 AS position_sum
      FROM marketing_daily_stats
      WHERE shop_id = ${shopId} AND platform = 'search_console' AND segment_kind = '' AND date BETWEEN ${od} AND ${do_}`,
    sql`
      SELECT segment AS dotaz,
             SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions,
             SUM(position_sum)::float8 AS position_sum
      FROM marketing_daily_stats
      WHERE shop_id = ${shopId} AND platform = 'search_console' AND segment_kind = 'query' AND date BETWEEN ${od} AND ${do_}
      GROUP BY segment
      ORDER BY 2 DESC, 3 DESC, 1
      LIMIT 20`,
  ]);
  const sPozici = (r) => ({
    ...r,
    pozice: Number(r.impressions) > 0 ? zaokrouhli2(Number(r.position_sum) / Number(r.impressions)) : null,
  });
  return {
    celkem: sPozici(celkem ?? { dni: 0, clicks: 0, impressions: 0, position_sum: 0 }),
    dotazy: (dotazy ?? []).map(sPozici),
  };
}

/**
 * Merchant Center: stav položek z posledního dne s daty + kliky a imprese
 * za období: `{ den, approved_items, disapproved_items, clicks, impressions, dni }`
 * (`den` null bez dat).
 */
export async function stavMerchantu(sql, { shopId, od, do: do_ }) {
  const [[posledni], [soucet]] = await Promise.all([
    sql`
      SELECT date::text AS den, approved_items, disapproved_items
      FROM marketing_daily_stats
      WHERE shop_id = ${shopId} AND platform = 'merchant' AND segment_kind = '' AND date BETWEEN ${od} AND ${do_}
      ORDER BY date DESC
      LIMIT 1`,
    sql`
      SELECT COUNT(*)::int AS dni,
             COALESCE(SUM(clicks), 0)::int AS clicks,
             COALESCE(SUM(impressions), 0)::int AS impressions
      FROM marketing_daily_stats
      WHERE shop_id = ${shopId} AND platform = 'merchant' AND segment_kind = '' AND date BETWEEN ${od} AND ${do_}`,
  ]);
  return {
    den: posledni?.den ?? null,
    approved_items: Number(posledni?.approved_items) || 0,
    disapproved_items: Number(posledni?.disapproved_items) || 0,
    clicks: Number(soucet?.clicks) || 0,
    impressions: Number(soucet?.impressions) || 0,
    dni: Number(soucet?.dni) || 0,
  };
}

/** Konverze podle platformy (jen k porovnání se Seilem): `{ platform, conversions, conversion_value, clicks, impressions, cost }`. */
export async function platformniKonverze(sql, { shopId, od, do: do_ }) {
  return sql`
    SELECT platform,
           COALESCE(SUM(conversions), 0)::float8 AS conversions,
           COALESCE(SUM(conversion_value), 0)::float8 AS conversion_value,
           COALESCE(SUM(clicks), 0)::int AS clicks,
           COALESCE(SUM(impressions), 0)::int AS impressions,
           COALESCE(SUM(cost), 0)::float8 AS cost
    FROM marketing_daily_stats
    WHERE shop_id = ${shopId} AND segment_kind = '' AND date BETWEEN ${od} AND ${do_}
    GROUP BY platform
    ORDER BY platform`;
}

/** Statistiky z e-shopu po dnech: hledání bez výsledku, opuštěné košíky a jejich hodnota. */
export async function eshopStatistiky(sql, { shopId, od, do: do_ }) {
  return sql`
    SELECT date::text AS den, searches_no_result, carts_abandoned, carts_value::float8 AS carts_value
    FROM marketing_daily_stats
    WHERE shop_id = ${shopId} AND platform = 'eshop' AND segment_kind = '' AND date BETWEEN ${od} AND ${do_}
    ORDER BY date`;
}
