/**
 * Adaptér Meta (Marketing API v26.0, Insights reklamního účtu).
 *
 * Útrata, zobrazení, kliky a nákupy po kampaních a dnech z
 * `GET /act_{id}/insights?level=campaign&time_increment=1`. Token je
 * System User z Business Settings s oprávněním `ads_read`; standardně
 * platí 60 dní (nebo „Never“ — jen tak sync nepadá každé dva měsíce na
 * 401/400 code 190, které je tu trvalá chyba s návodem).
 *
 * ## Metriky
 *
 * `spend` je v měně účtu — předpokládá se CZK bez DPH (reverse charge),
 * `overit()` měnu vypisuje a varuje, když není CZK. `clicks` v tabulce jsou
 * kliky na odkaz (`inline_link_clicks` = návštěvy webu, srovnatelné
 * s kliky Skliku a Ads; „clicks“ Mety počítají i reakce a sdílení) —
 * když pole chybí, vezmou se `clicks`. Nákupy: `actions[]`
 * / `action_values[]` s `action_type` `omni_purchase` (web + aplikace),
 * náhradně `offsite_conversion.fb_pixel_purchase` (jen pixel). Hodnota
 * konverzí je v měně účtu. Atribuční okno účtu (7d_click/1d_view) Meta
 * dopočítává zpětně → `prepisDni = 30`.
 *
 * ## Stránkování a chyby
 *
 * Odpověď má `paging.next` s absolutní adresou včetně tokenu — volá se tak,
 * jak přišla; do logu jde adresa bez query stringu (../http.js). Meta
 * vrací přechodné stavy (limity volání: code 4/17/32/613 platformy, 80000
 * Business Use Case pro Ads Insights, `is_transient`) jako HTTP 400, které
 * by jinak bylo trvalou chybou — ty se značí jako opakovatelné. Den je v pásmu účtu (`timezone_name`, u Toneráčku
 * Europe/Prague).
 */

import { fetchJson } from '../http.js';
import { AdapterError, sPrevodemChyb, zpravaOvereni } from './chyby.js';
import { cislo, datumZOdpovedi, jenCislice, normalizujRadky, sectiSVarovanim, souctyPoDnech } from './spolecne.js';

export const platform = 'meta';
export const popis = 'Meta (Facebook, Instagram)';
export const zapisujePlatformy = ['meta'];
export const potrebujeTajemstvi = true;
export const popisExternalId = 'ID reklamního účtu (číslo za act_)';
export const popisParentId = '';
export const maxDniNaDotaz = 31;
export const prepisDni = 30;

export const VERZE = 'v26.0';
export const API = `https://graph.facebook.com/${VERZE}`;
export const POLE = 'campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,actions,action_values,purchase_roas';
export const LIMIT = 500;
/** Typy akcí nákupu v pořadí priority. */
export const TYPY_NAKUPU = ['omni_purchase', 'offsite_conversion.fb_pixel_purchase'];
/**
 * Kódy chyb Mety, které jsou přechodné i pod HTTP 400: 1/2 neznámá či
 * dočasně nedostupná služba, 4/17/32/613 limity volání platformy, 80000
 * a 80004 limity Business Use Case pro Ads Insights a Ads Management
 * (subcode 2446079) — právě 80000 vrací /insights při překročení limitu.
 */
export const PRECHODNE_KODY = [1, 2, 4, 17, 32, 613, 80000, 80004];
const MAX_STRANEK = 50;

function token(tajemstvi) {
  const t = String(tajemstvi ?? '').trim();
  if (!t) throw new AdapterError('Meta: chybí token System User — uložte ho v nastavení e-shopu (Business Settings → Users → System Users → Generate token, oprávnění ads_read)', { permanent: true, platform });
  return t;
}

/** ID účtu bez `act_`; jiný tvar je trvalá chyba nastavení. */
export function accountId(source) {
  const id = jenCislice(source?.external_id);
  if (!id) {
    throw new AdapterError(
      `Meta: ID reklamního účtu musí být číslo (za act_ v Ads Manageru), ne „${String(source?.external_id ?? '').trim()}“`,
      { permanent: true, platform },
    );
  }
  return id;
}

/** Chybu Graph API, která je přechodná i pod HTTP 400 (limity volání, dočasný problém), označí k opakování. Jiné stavy nechá být. */
export function oznacPrechodnou(err) {
  const chyba = err?.body?.error;
  if (err?.status === 400 && chyba && (chyba.is_transient === true || PRECHODNE_KODY.includes(Number(chyba.code)))) err.retryable = true;
  return err;
}

function napoveda(chyba) {
  const e = chyba?.cause?.body?.error;
  if (e?.code === 190 || chyba.status === 401) {
    return 'token System User vypršel nebo byl odvolán — vygenerujte nový v Business Settings → Users → System Users (platí 60 dní, nebo zvolte „Never“)';
  }
  if (e?.code === 100) return 'zkontrolujte ID reklamního účtu (číslo za act_)';
  if (chyba.status === 403 || [10, 200, 294].includes(Number(e?.code))) return 'token nemá k účtu oprávnění ads_read — přidejte System Useru přístup k reklamnímu účtu';
  return '';
}

/** Adresa první stránky insights za okno. Token je v query stringu, do logu nikdy nejde. */
export function urlInsights(id, from, to, accessToken) {
  const u = new URL(`${API}/act_${id}/insights`);
  u.searchParams.set('level', 'campaign');
  u.searchParams.set('fields', POLE);
  u.searchParams.set('time_increment', '1');
  u.searchParams.set('time_range', JSON.stringify({ since: from, until: to }));
  u.searchParams.set('limit', String(LIMIT));
  u.searchParams.set('access_token', accessToken);
  return u.toString();
}

/** Hodnota nákupu z `actions` / `action_values`: první nalezený typ z TYPY_NAKUPU, jinak 0. */
export function hodnotaAkce(akce) {
  if (!Array.isArray(akce)) return 0;
  for (const typ of TYPY_NAKUPU) {
    const a = akce.find(x => x?.action_type === typ);
    if (a) return cislo(a.value);
  }
  return 0;
}

/** Stránka nebo pole stránek insights → řádky kampaní a denní součty. Čistá funkce. */
export function parsuj(odpoved, ctx = {}) {
  const stranky = Array.isArray(odpoved) ? odpoved : odpoved ? [odpoved] : [];
  const kampane = [];
  for (const s of stranky) {
    for (const r of (Array.isArray(s?.data) ? s.data : [])) {
      const date = datumZOdpovedi(r?.date_start);
      if (!date) continue;
      const linkClicks = r?.inline_link_clicks;
      kampane.push({
        platform, date, segment_kind: 'campaign',
        segment: String(r?.campaign_name ?? '').trim() || `Kampaň ${r?.campaign_id ?? '?'}`,
        cost: cislo(r?.spend),
        impressions: cislo(r?.impressions),
        clicks: linkClicks != null && linkClicks !== '' ? cislo(linkClicks) : cislo(r?.clicks),
        conversions: hodnotaAkce(r?.actions),
        conversion_value: hodnotaAkce(r?.action_values),
      });
    }
  }
  return [...souctyPoDnech(kampane, ctx), ...sectiSVarovanim(kampane, ctx)];
}

async function volejMeta(url, { fetchImpl, log, sleep, nazev }) {
  return sPrevodemChyb(async () => {
    try {
      return (await fetchJson(url, { fetchImpl })).json;
    } catch (err) {
      throw oznacPrechodnou(err);
    }
  }, { platform, nazev, log, sleep, napoveda });
}

/** Normalizované řádky Mety za okno [from, to]; sleduje `paging.next`. */
export async function fetchDaily({ source, from, to, tajemstvi, log, fetchImpl, sleep } = {}) {
  const id = accountId(source);
  const stranky = [];
  let url = urlInsights(id, from, to, token(tajemstvi));
  for (let i = 0; i < MAX_STRANEK && url; i++) {
    const stranka = await volejMeta(url, { fetchImpl, log, sleep, nazev: `Meta insights (strana ${i + 1})` });
    stranky.push(stranka);
    url = typeof stranka?.paging?.next === 'string' ? stranka.paging.next : null;
  }
  const varovani = [];
  const radky = parsuj(stranky, { from, to, varovani });
  return normalizujRadky(radky, { from, to, platform, log, nazev: `Meta ${from}–${to}`, varovani });
}

/** Reklamní účet: název, měna, pásmo. Nikdy nevyhodí. */
export async function overit({ source, tajemstvi, log, fetchImpl, sleep } = {}) {
  try {
    const id = accountId(source);
    const u = new URL(`${API}/act_${id}`);
    u.searchParams.set('fields', 'name,currency,timezone_name');
    u.searchParams.set('access_token', token(tajemstvi));
    const ucet = await volejMeta(u.toString(), { fetchImpl, log, sleep, nazev: 'Meta účet' });
    const mena = ucet?.currency && ucet.currency !== 'CZK' ? ` — pozor, účet je v ${ucet.currency}, útrata se čeká v CZK` : `, měna ${ucet?.currency || '?'}`;
    return { ok: true, zprava: `Účet act_${id}${ucet?.name ? ` (${ucet.name})` : ''}${mena}, pásmo ${ucet?.timezone_name || 'neznámé'}` };
  } catch (err) {
    return { ok: false, zprava: zpravaOvereni(err, { platform }) };
  }
}
