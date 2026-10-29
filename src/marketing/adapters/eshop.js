/**
 * Adaptér vlastního e-shopu (platforma `eshop`): hledání bez výsledku
 * a opuštěné košíky z `GET {shops.url}/api/marketing/statistika`.
 *
 * Jednotný kontrakt pro všechny e-shopy (Toneráček ho má, Dílna dostane
 * týž): `?dni=N` vrátí posledních N pražských dnů včetně dneška —
 * `hledani` (celkem, dotazy bez výsledku, nejčastější), `kosiky` (počet,
 * hodnota, dokončené, připomenuté, top zboží) a `poDnech[]` s denními
 * čítači. Do tabulky jdou jen denní součty (`searches`,
 * `searches_no_result`, `carts_abandoned`, `carts_value` — Kč s DPH, jak
 * je měl košík) a seznam dotazů bez výsledku jako řádky `segment_kind =
 * 'query'` na POSLEDNÍ den okna, který má denní součet (e-shop ho neumí
 * rozložit do dnů; `n` je celkový počet hledání dotazu, který se naposledy
 * hledal v okně). Rozpad bez součtu téhož dne nevzniká — součet je
 * povinný pro každý den s daty (hlavička ../normalizace.js).
 *
 * ## Okno vs. `dni`
 *
 * E-shop počítá ode dneška zpět a nejdál 90 dní, zatímco sync chce okno
 * [from, to] končící včerejškem. Volá se proto `dni = dnes − from + 1`
 * (nejvýš 90) a `parsuj()` nechá jen dny v okně — dnešek je neúplný.
 * Kus okna starší než 90 dní e-shop neumí vrátit: bez volání se vrátí
 * prázdno a zaloguje se to, není to chyba (první běh 400 dní zpět).
 *
 * ## Tajemství
 *
 * Hlavička `x-webhook-secret`: Toneráček jede jen na `SHOP_WEBHOOK_SECRET`
 * z prostředí, ostatní e-shopy jen na `shops.webhook_secret` (pravidlo
 * `webhookSecretEshopu()` v src/expedice.js, které sem kvůli db.js
 * neimportujeme — sync ho předá v `tajemstvi`; bez něj platí tatáž volba
 * nad `shop`). 401 = tajemství nesedí (trvalá), 503 s JSON chybou =
 * e-shop nemá `WEBHOOK_SECRET` v prostředí (trvalá, s návodem); 503 bez
 * JSON je výpadek proxy a opakuje se.
 */

import { prazskyCas, pridejDny } from '../../prazsky-cas.js';
import { adresaProLog, fetchJson } from '../http.js';
import { rozdilDni } from '../obdobi.js';
import { AdapterError, sPrevodemChyb, zpravaOvereni } from './chyby.js';
import { cislo, datumZOdpovedi, kc, normalizujRadky, sectiSVarovanim, topNaDen, TOP_SEGMENTU } from './spolecne.js';

export const platform = 'eshop';
export const popis = 'E-shop (hledání bez výsledku, opuštěné košíky)';
export const zapisujePlatformy = ['eshop'];
export const potrebujeTajemstvi = false;
export const popisExternalId = 'Nevyplňuje se — volá se adresa e-shopu z jeho nastavení (URL)';
export const popisParentId = '';
export const maxDniNaDotaz = 90;
export const prepisDni = 14;

export const CESTA = '/api/marketing/statistika';
/** Nejdál zpět, kam e-shop statistiku umí vrátit (`MAX_DNI` v jeho route). */
export const MAX_DNI = 90;
export const TOP_DOTAZU = TOP_SEGMENTU;
const VYCHOZI_ESHOP = 'toneracek';

/** Tajemství pro hlavičku: předané, jinak podle pravidla Toneráček = env, ostatní = shops.webhook_secret. */
export function tajemstviEshopu(shop, tajemstvi) {
  const t = String(tajemstvi ?? '').trim();
  if (t) return t;
  if (shop?.slug === VYCHOZI_ESHOP) return String(process.env.SHOP_WEBHOOK_SECRET ?? '').trim();
  return String(shop?.webhook_secret ?? '').trim();
}

/** Adresa statistiky e-shopu; e-shop bez platné URL je trvalá chyba nastavení. */
export function adresaStatistiky(shop, dni) {
  const base = String(shop?.url ?? '').trim();
  if (!/^https?:\/\/\S+$/.test(base)) {
    throw new AdapterError(`E-shop ${shop?.slug ?? '?'}: nemá platnou URL („${base}“) — doplňte ji v Nastavení → Eshopy`, { permanent: true, platform });
  }
  const u = new URL(CESTA, base);
  u.searchParams.set('dni', String(dni));
  return u.toString();
}

/** `dni` pro volání: ode dneška zpět po `from`, 1–90. */
export function pocetDni(from, dnes) {
  const n = rozdilDni(from, dnes) + 1;
  return Math.min(MAX_DNI, Math.max(1, Number.isFinite(n) ? n : 1));
}

/** Chyby, které říkají, co má obsluha udělat; ostatní projdou beze změny. */
export function chybaEshopu(err) {
  if (err?.status === 401) {
    return new AdapterError('e-shop odmítl tajemství (401) — x-webhook-secret se neshoduje s WEBHOOK_SECRET e-shopu', { permanent: true, status: 401, platform, cause: err });
  }
  if (err?.status === 503 && err?.body && typeof err.body === 'object' && err.body.error) {
    return new AdapterError('e-shop nemá nastavené WEBHOOK_SECRET (odpověděl 503) — doplňte ho v prostředí e-shopu, stejné jako tajemství v One SEIL', { permanent: true, status: 503, platform, cause: err });
  }
  if (err?.status === 404) {
    return new AdapterError(`e-shop nemá ${CESTA} (404) — nasaďte verzi e-shopu, která statistiku pro One SEIL umí`, { permanent: true, status: 404, platform, cause: err });
  }
  return err;
}

/**
 * Odpověď e-shopu → denní součty za dny v okně [ctx.from, ctx.to] a dotazy
 * bez výsledku na poslední den okna, který má součet. Čistá funkce.
 */
export function parsuj(odpoved, ctx = {}) {
  const from = datumZOdpovedi(ctx.from);
  const to = datumZOdpovedi(ctx.to);
  const radky = [];
  for (const d of (Array.isArray(odpoved?.poDnech) ? odpoved.poDnech : [])) {
    const date = datumZOdpovedi(d?.datum);
    if (!date || (from && date < from) || (to && date > to)) continue;
    radky.push({
      platform, date, segment_kind: '', segment: '',
      searches: cislo(d.hledani),
      searches_no_result: cislo(d.hledaniBezVysledku),
      carts_abandoned: cislo(d.kosiky),
      carts_value: cislo(d.kosikyHodnota),
    });
  }
  // Dotazy jdou na poslední den okna, který má součet; bez součtů žádný rozpad (viz hlavička).
  const dnySouctu = radky.map(r => r.date).sort();
  const den = to && dnySouctu.includes(to) ? to : dnySouctu.at(-1) ?? null;
  const bezVysledku = Array.isArray(odpoved?.hledani?.bezVysledku) ? odpoved.hledani.bezVysledku : [];
  const dotazy = den
    ? bezVysledku
      .map(b => ({ platform, date: den, segment_kind: 'query', segment: String(b?.dotaz ?? '').trim(), searches_no_result: cislo(b?.n) }))
      .filter(r => r.segment)
    : [];
  return [...radky, ...topNaDen(sectiSVarovanim(dotazy, ctx), ['searches_no_result'], TOP_DOTAZU)];
}

async function stahni(url, secret, { fetchImpl, log, sleep, nazev }) {
  return sPrevodemChyb(async () => {
    try {
      return (await fetchJson(url, { headers: { 'x-webhook-secret': secret }, fetchImpl })).json;
    } catch (err) {
      throw chybaEshopu(err);
    }
  }, { platform, nazev, log, sleep });
}

/** Normalizované řádky e-shopu za okno [from, to]. `now` jen pro testy. */
export async function fetchDaily({ shop, from, to, tajemstvi, log, fetchImpl, sleep, now = () => new Date() } = {}) {
  const secret = tajemstviEshopu(shop, tajemstvi);
  if (!secret) {
    const navod = shop?.slug === VYCHOZI_ESHOP ? 'nastavte SHOP_WEBHOOK_SECRET v prostředí One SEIL' : 'vyplňte tajemství v Nastavení → Eshopy → Napojení e-shopu';
    throw new AdapterError(`E-shop ${shop?.slug ?? '?'}: chybí tajemství pro volání (x-webhook-secret) — ${navod}`, { permanent: true, platform });
  }
  const dnes = prazskyCas(now()).datum;
  const nejstarsi = pridejDny(dnes, -(MAX_DNI - 1));
  if (to < nejstarsi) {
    log?.info?.({ from, to, nejstarsi }, `E-shop ${shop?.slug ?? ''}: okno ${from}–${to} je starší než ${MAX_DNI} dní, tak daleko statistika e-shopu nesahá — bez dat`);
    return [];
  }
  const url = adresaStatistiky(shop, pocetDni(from, dnes));
  const json = await stahni(url, secret, { fetchImpl, log, sleep, nazev: `E-shop ${shop?.slug ?? ''} statistika` });
  const varovani = [];
  const radky = parsuj(json, { from, to, varovani });
  return normalizujRadky(radky, { from, to, platform, log, nazev: `E-shop ${shop?.slug ?? ''} ${from}–${to}`, varovani });
}

/** `dni=1` a počty za dnešek. Nikdy nevyhodí. */
export async function overit({ shop, tajemstvi, log, fetchImpl, sleep } = {}) {
  try {
    const secret = tajemstviEshopu(shop, tajemstvi);
    if (!secret) {
      const navod = shop?.slug === VYCHOZI_ESHOP ? 'nastavte SHOP_WEBHOOK_SECRET v prostředí One SEIL' : 'vyplňte tajemství v Nastavení → Eshopy → Napojení e-shopu';
      return { ok: false, zprava: `E-shop ${shop?.slug ?? '?'}: chybí tajemství pro volání (x-webhook-secret) — ${navod}` };
    }
    const url = adresaStatistiky(shop, 1);
    const json = await stahni(url, secret, { fetchImpl, log, sleep, nazev: `E-shop ${shop?.slug ?? ''} ověření` });
    const h = json?.hledani ?? {};
    const k = json?.kosiky ?? {};
    const radku = Array.isArray(json?.poDnech) ? json.poDnech.length : 0;
    return {
      ok: true,
      zprava: `E-shop odpovídá (${adresaProLog(url)}): dnes ${cislo(h.celkem) || 0} hledání, ${Array.isArray(h.bezVysledku) ? h.bezVysledku.length : 0} dotazů bez výsledku, ${cislo(k.pocet) || 0} opuštěných košíků za ${kc(cislo(k.hodnota) || 0)}`,
      radku,
    };
  } catch (err) {
    return { ok: false, zprava: zpravaOvereni(err, { platform }) };
  }
}
