/**
 * Atribuce objednávky a nákupní cena položky z těla POST …/orders — sdílené
 * oběma order API (/api/toneracek/orders i /api/eshop/orders), čisté funkce
 * bez databáze, ať se pravidla dají otestovat.
 *
 * ## Proč to je
 *
 * Jakmile běží kampaně, je každá objednávka bez zdroje ztracené číslo:
 * sekce Marketing počítá PNO a ROAS po kanálech z objednávek v One SEIL,
 * ne z GA4 (tam chybí nákupy bez souhlasu). E-shop proto s objednávkou
 * posílá `marketing` — první a poslední dotyk (UTM, click-id, referrer,
 * vstupní stránka, čas) a kategorii souhlasu z lišty — a u položek
 * `costPrice` pro marži. Obojí je VOLITELNÉ: starší e-shop nic z toho
 * neposílá a objednávka musí projít stejně jako dřív, jen s výchozími
 * hodnotami ('' a NULL). Kontrakt je v docs/api.md, sloupce v migraci 042.
 *
 * ## Server tělu nevěří, ale nic neodmítá
 *
 * E-shop má vlastní validaci (Zod), jenže sloupce v shop_orders jsou TEXT
 * bez omezení a objednávka se nesmí ztratit kvůli kosmetice v atribuci.
 * Takže se tu nic nevyhazuje, jen čistí: řídicí a neviditelné formátovací
 * znaky a <>"'`\ pryč, oříznutí na délky z kontraktu, source/medium malými,
 * enumy jen z povolených hodnot. Čas dotyku musí být ISO 8601 s pásmem;
 * nečitelný nebo dál než rok od teď (rozbité hodiny v prohlížeči by jinak
 * vyrobily dotyk z roku 1970) nahradí čas přijetí objednávky, ne NULL:
 * touch_last_at IS NULL znamená „e-shop atribuci neposlal“ (migrace 042)
 * a dotyk se zdrojem by jinak v KPI vyšel jako neznámý kanál. Click-id se
 * ukládá jen s marketingovým souhlasem (consent marketing/all): e-shop ho
 * bez něj posílat nemá, ale uložení je na One SEIL, tak to hlídá i tady.
 *
 * Nákupní cena se drží na haléře (NUMERIC(10,2)), NE v celých korunách
 * jako prodejní cena: ta se zaokrouhluje, aby doklad seděl s webem a se
 * Stripem, nákupní cena na doklad nejde a marže z ní má být přesná.
 * Příznak cost_price_vat_included je jen true/false, jinak NULL (neznámo).
 */

/** Nejvyšší délky textů podle kontraktu (e-shop ořezává stejně). */
export const DELKY = { utm: 120, clickId: 200, host: 100, cesta: 200 };

/** Povolené druhy click-id; cokoli jiného se zahodí i s hodnotou. */
export const DRUHY_CLICK_ID = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'sznclid', 'sznaiid', 'hgtid', 'aku'];

/** Kategorie souhlasu z lišty e-shopu; '' = e-shop ji neposlal (před nasazením). */
export const SOUHLASY = ['none', 'analytics', 'marketing', 'all'];

/** Se kterými souhlasy se smí uložit click-id (měření výkonu reklamy = marketing). */
const SOUHLASY_PRO_CLICK_ID = ['marketing', 'all'];

/** Dotyk dál od „teď“ než tohle je rozbitý čas, ne atribuce. */
const ROK_MS = 366 * 24 * 60 * 60 * 1000;

/** Nákupní cena musí být v [0, 1e6) — nad milion za kus je překlep. */
const MAX_NAKUPNI_CENA = 1e6;

/** Pole dotyku z těla → základ názvu sloupce (přípona _first/_last se přidá). */
const POLE_DOTYKU = [
  ['source', 'utm_source'], ['medium', 'utm_medium'], ['campaign', 'utm_campaign'],
  ['term', 'utm_term'], ['content', 'utm_content'], ['clickIdKind', 'click_id_kind'],
  ['clickId', 'click_id'], ['referrerHost', 'referrer_host'], ['landingPage', 'landing_page'],
];

/** 21 sloupců shop_orders, které atribuceZTela() vrací — přesně v tomhle pořadí. */
export const SLOUPCE_ATRIBUCE = [
  ...['first', 'last'].flatMap((p) => [...POLE_DOTYKU.map(([, sloupec]) => `${sloupec}_${p}`), `touch_${p}_at`]),
  'attribution_consent',
];

/**
 * Znaky, které v atribuci nemají co dělat: řídicí C0 a C1 (včetně DEL),
 * HTML, uvozovky, zpětné lomítko a neviditelné formátovací znaky Unicode
 * (nulová šířka U+200B–200F, bidi U+202A–202E a U+2066–2069, spojovače
 * U+2060–2064, BOM U+FEFF). Ty by jinak vyrobily dvě na pohled stejné
 * kampaně ve dvou řádcích nebo obrácený text v tabulkách Marketingu.
 * Tutéž třídu má mít e-shop ve své validaci (textAtribuce).
 */
const ZAKAZANE_ZNAKY = /[\x00-\x1F\x7F-\x9F<>"'`\\\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Tvar času dotyku: ISO 8601 s pásmem (Z nebo ±HH:MM) — bez pásma by ho new Date vzal v pásmu serveru. */
const TVAR_CASU = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Text bez zakázaných znaků, oříznutý (po znacích, ne po bajtech) na `max`. Jiný typ než text → ''. */
function text(hodnota, max) {
  if (typeof hodnota === 'number' && Number.isFinite(hodnota)) hodnota = String(hodnota);
  if (typeof hodnota !== 'string') return '';
  const cisty = hodnota.replace(ZAKAZANE_ZNAKY, '').trim();
  return Array.from(cisty).slice(0, max).join('').trim();
}

/** Jen hostitel malými písmeny bez schématu, cesty, portu a www. — jinak ''. */
function hostitel(hodnota) {
  let h = text(hodnota, 2048).toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  h = h.split(/[/?#]/)[0];
  h = h.replace(/:\d+$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9.-]*$/.test(h)) return '';
  return text(h, DELKY.host);
}

/** Jen cesta vstupní stránky (začíná lomítkem, bez dotazu a kotvy) — jinak ''. */
function cesta(hodnota) {
  let c = text(hodnota, 4096);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(c)) {
    try { c = new URL(c).pathname; } catch { c = ''; }
  }
  c = c.split(/[?#]/)[0].replace(/\s+/g, '');
  if (c && !c.startsWith('/')) c = `/${c}`;
  return text(c, DELKY.cesta);
}

/** ISO 8601 čas s pásmem jako Date, nebo null: jiný tvar, bez pásma, neplatný, nebo víc než rok od `ted`. */
function okamzik(hodnota, ted) {
  if (typeof hodnota !== 'string') return null;
  const s = hodnota.trim();
  if (!TVAR_CASU.test(s)) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  if (Math.abs(d.getTime() - ted.getTime()) > ROK_MS) return null;
  return d;
}

/** Sloupce jednoho dotyku (first nebo last) z objektu e-shopu; chybějící dotyk → samé '' a NULL. */
function dotyk(hodnota, pripona, souhlas, ted) {
  const d = hodnota && typeof hodnota === 'object' && !Array.isArray(hodnota) ? hodnota : {};
  // Druh a hodnota click-id jdou spolu: bez platného druhu nejde hodnotu
  // zařadit ke kanálu, bez hodnoty nemá druh smysl. Bez marketingového
  // souhlasu se neukládá ani jedno (e-shop ho tak posílat nemá).
  const druh = DRUHY_CLICK_ID.includes(d.clickIdKind) ? d.clickIdKind : '';
  const clickId = druh && SOUHLASY_PRO_CLICK_ID.includes(souhlas) ? text(d.clickId, DELKY.clickId) : '';
  const texty = {
    [`utm_source_${pripona}`]:    text(d.source, DELKY.utm).toLowerCase(),
    [`utm_medium_${pripona}`]:    text(d.medium, DELKY.utm).toLowerCase(),
    [`utm_campaign_${pripona}`]:  text(d.campaign, DELKY.utm),
    [`utm_term_${pripona}`]:      text(d.term, DELKY.utm),
    [`utm_content_${pripona}`]:   text(d.content, DELKY.utm),
    [`click_id_kind_${pripona}`]: clickId ? druh : '',
    [`click_id_${pripona}`]:      clickId,
    [`referrer_host_${pripona}`]: hostitel(d.referrerHost),
    [`landing_page_${pripona}`]:  cesta(d.landingPage),
  };
  // Dotyk, který něco nese, má čas vždy: poslaný, a když je nepoužitelný,
  // čas přijetí objednávky. NULL zůstává jen dotyku bez jediného údaje —
  // touch_*_at IS NULL = e-shop dotyk neposlal (migrace 042, KPI).
  const neseUdaj = Object.values(texty).some((v) => v !== '');
  return { ...texty, [`touch_${pripona}_at`]: okamzik(d.at, ted) ?? (neseUdaj ? ted : null) };
}

/**
 * Sloupce atribuce pro INSERT do shop_orders z `marketing` v těle objednávky.
 * Vrací vždy všech 21 sloupců (SLOUPCE_ATRIBUCE): bez `marketing` nebo
 * s nesmyslem v něm samé '' a NULL, tedy totéž, co výchozí hodnoty
 * sloupců — starší e-shop projde beze změny chování.
 *
 * `ted` je čas přijetí objednávky: hranice ±1 rok pro čas dotyku a jeho
 * náhrada, když je nepoužitelný; v testech pevný.
 */
export function atribuceZTela(marketing, ted = new Date()) {
  const m = marketing && typeof marketing === 'object' && !Array.isArray(marketing) ? marketing : {};
  const souhlas = SOUHLASY.includes(m.consent) ? m.consent : '';
  return {
    ...dotyk(m.first, 'first', souhlas, ted),
    ...dotyk(m.last, 'last', souhlas, ted),
    attribution_consent: souhlas,
  };
}

/**
 * Nákupní cena položky pro INSERT do shop_order_items: `{ cost_price,
 * cost_price_vat_included }`. Cena jen konečné číslo v [0, 1e6) na haléře,
 * jinak NULL; příznak DPH jen true/false, jinak NULL. Pseudo-položky
 * (DOPRAVA, DOBIRKA, SLEVA-REG) posílá e-shop s null a tak se i uloží.
 */
export function nakupniCenaZPolozky(item) {
  const p = item && typeof item === 'object' ? item : {};
  let n = null;
  if (typeof p.costPrice === 'number') n = p.costPrice;
  else if (typeof p.costPrice === 'string' && p.costPrice.trim() !== '') n = Number(p.costPrice.trim().replace(',', '.'));
  if (n !== null && (!Number.isFinite(n) || n < 0 || n >= MAX_NAKUPNI_CENA)) n = null;
  // EPSILON kvůli 1.005 → 1.01 (bez něj dá Math.round 1.00); -0 → 0.
  const cost_price = n === null ? null : Math.round((n + Number.EPSILON) * 100) / 100 || 0;
  const cost_price_vat_included = typeof p.costPriceVatIncluded === 'boolean' ? p.costPriceVatIncluded : null;
  return { cost_price, cost_price_vat_included };
}
