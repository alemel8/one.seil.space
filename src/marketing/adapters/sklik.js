/**
 * Adaptér Sklik (API Fénix, https://api.sklik.cz/v1) — zapisuje platformy
 * `sklik` i `zbozi`.
 *
 * Zboží.cz vlastní API nemá (skončilo 16. 3. 2026) a statistiky Seznam
 * Nákupů jsou od října 2026 jen ve Skliku jako kampaně typu `zbozi`. Jeden
 * adaptér proto stahuje kampaně a třídí je podle typu: `zbozi` → platforma
 * `zbozi`, všechno ostatní (fulltext, context, combined, video, product,
 * social, simple, smart, audio) → `sklik`. Každá platforma má svůj denní
 * součet a své řádky `segment_kind = 'campaign'`; `normalizujRadek()`
 * bere platformu z řádku, takže se Sklik a Zboží téhož dne nesečtou.
 *
 * Tvar volání i odpovědí je ověřený proti specifikaci
 * https://api.sklik.cz/v1/openapi.json z 29. 10. 2026 (ne proti živému
 * účtu — první ostrý běh porovnat s UI Skliku).
 *
 * ## Přihlášení
 *
 * Tajemství je klíč API Fénix s právem čtení (r) — vzniká v Skliku pod
 * Nastavení → Správa klíčů API Fénix, jen při přímém přihlášení majitele
 * účtu. `POST /user/token` s `Authorization: Bearer <klíč>` a
 * `grant_type=client_credentials` (formulář) vrátí `access_token` na
 * hodinu (`expires_in`). Endpoint tokenu je sám omezený na počet volání,
 * proto se token drží v paměti procesu pod otiskem klíče nejvýš 55 minut,
 * ať se nebere při každém kusu okna. `user_id` jde do žádosti jen tehdy,
 * když `external_id` nese číslo propojeného (agenturou spravovaného) účtu.
 * Když datové volání vrátí 401, token se jednou obnoví — Seznam ho může
 * zneplatnit dřív než za hodinu; druhá 401 už je trvalá chyba (klíč).
 * Chybný klíč vrací endpoint tokenu podle RFC 6749 jako 400
 * (invalid_grant), proto je u tokenu i 400 „špatný klíč“ s návodem.
 *
 * ## Statistiky kampaní
 *
 * `GET /sklik/campaigns/?statisticsDateFrom&statisticsDateTo&
 * statisticsGranularity=daily&a=id&a=name&a=type&a=clicks&…&limit&offset`.
 * Statistiky se musí vyžádat atributy `a` (bez nich odpověď nese jen to,
 * co se požádalo) a s granularitou je odpověď PLOCHÁ: v `items` se každá
 * kampaň opakuje jednou na den a každý řádek nese statistiky toho dne
 * a jeho `firstDate` (doplňuje API). `limit`/`offset` proto počítají řádky
 * (kampaň × den), ne kampaně — kampaň může být rozdělená přes dvě stránky,
 * což součtům nevadí. Odpověď nenese celkový počet, stránkuje se, dokud
 * stránka vrací plný `limit` (nejvýš 1 000), s pojistkou proti opakované
 * stránce. Nejvýš 60 bucketů na kampaň, denně „do 1 měsíce“ →
 * `maxDniNaDotaz = 30`. Mezi voláními 250 ms (limit 5 požadavků za sekundu).
 *
 * ## Jednotky a pásmo
 *
 * Peníze (`totalMoney`, `conversionValue`, `clickMoney`…) jsou v HALÉŘÍCH
 * bez DPH → dělí se 100. Kredit Peněženky z `/user/me/credit` je naopak
 * v Kč (`credit` bez DPH, `creditWithVat` s DPH); klient agentury pole
 * `credit` nemá, jen `agencyStatus`. Konverze se připisují ke dni kliku až
 * 30 dní → `prepisDni = 30`. Den je pražský (účty Skliku jsou české).
 */

import { fetchJson } from '../http.js';
import { otiskTajemstvi } from '../tajemstvi.js';
import { AdapterError, sPrevodemChyb, zpravaOvereni } from './chyby.js';
import { cislo, datumZOdpovedi, jenCislice, kc, normalizujRadky, sectiSVarovanim, souctyPoDnech } from './spolecne.js';

export const platform = 'sklik';
export const popis = 'Sklik (včetně kampaní Zboží.cz)';
export const zapisujePlatformy = ['sklik', 'zbozi'];
export const potrebujeTajemstvi = true;
export const popisExternalId = 'ID propojeného účtu Sklik (userId) — jen když klíč patří agentuře, jinak prázdné';
export const popisParentId = '';
export const maxDniNaDotaz = 30;
export const prepisDni = 30;

export const API = 'https://api.sklik.cz/v1';
/** Řádků (kampaň × den) na stránku — maximum i výchozí hodnota API. */
export const LIMIT = 1000;
export const PRODLEVA_MS = 250;
/** Access token platí hodinu; drží se nejvýš 55 minut, ať nevyprší uprostřed stránkování. */
export const PLATNOST_TOKENU_MS = 55 * 60_000;
/** Atributy žádané u kampaní: identifikace a statistiky (hodnoty enumů CampaignAttribute a StatisticAttribute). */
export const ATRIBUTY = ['id', 'name', 'type', 'clicks', 'impressions', 'totalMoney', 'conversions', 'conversionValue'];
/** Scope, který `/sklik/campaigns/` vyžaduje; klíč bez něj by padal na 403. */
export const SCOPE_KAMPANI = 'campaign';
const MAX_STRANEK = 500;

const spi = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** otisk klíče + user_id → { token, expiresAt } */
const tokeny = new Map();

/** Zahodí tokeny v paměti — po změně klíče, při 401 a v testech. */
export function vymazTokenySklik() {
  tokeny.clear();
}

function klicApi(tajemstvi) {
  const klic = String(tajemstvi ?? '').trim();
  if (!klic) throw new AdapterError('Sklik: chybí klíč API Fénix — uložte ho v nastavení e-shopu (Sklik → Nastavení → Správa klíčů API Fénix, právo čtení)', { permanent: true, platform });
  return klic;
}

const NAVOD_KLIC = 'klíč API Fénix neplatí, vypršel nebo nemá právo čtení (r); nový vzniká v Skliku pod Nastavení → Správa klíčů API Fénix při přímém přihlášení majitele účtu';

/** Dovětek k chybě datového volání podle stavu — co má obsluha udělat. */
function napoveda(chyba) {
  if (chyba.status === 401 || chyba.status === 403) return NAVOD_KLIC;
  if (chyba.status === 429) return 'limit API je 5 požadavků za sekundu, běh se zopakuje';
  return '';
}

/** U žádosti o token je i 400 špatný klíč (RFC 6749 vrací invalid_grant jako 400, ne 401). */
function napovedaTokenu(chyba) {
  return chyba.status === 400 ? NAVOD_KLIC : napoveda(chyba);
}

async function pristupovyToken(klic, userId, { fetchImpl, log, sleep, now }) {
  const cacheKlic = `${otiskTajemstvi(klic)}:${userId}`;
  const ulozeny = tokeny.get(cacheKlic);
  if (ulozeny && ulozeny.expiresAt > now().getTime()) return ulozeny.token;

  const telo = new URLSearchParams({ grant_type: 'client_credentials', ...(userId ? { user_id: userId } : {}) });
  const { json } = await sPrevodemChyb(() => fetchJson(`${API}/user/token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${klic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: telo,
    fetchImpl,
  }), { platform, nazev: 'Sklik token', log, sleep, napoveda: napovedaTokenu });

  const token = json?.access_token;
  if (!token) throw new AdapterError('Sklik token: odpověď /user/token neobsahuje access_token', { permanent: true, platform });
  const expiresIn = cislo(json.expires_in);
  const platnost = Math.min(PLATNOST_TOKENU_MS, (expiresIn > 0 ? expiresIn * 1000 : PLATNOST_TOKENU_MS) - 5 * 60_000);
  tokeny.set(cacheKlic, { token, expiresAt: now().getTime() + Math.max(60_000, platnost) });
  return token;
}

/** JSON volání API Fénix s access tokenem. */
async function volejSklik(url, token, { fetchImpl, log, sleep, nazev }) {
  const { json } = await sPrevodemChyb(() => fetchJson(url, { headers: { Authorization: `Bearer ${token}` }, fetchImpl }),
    { platform, nazev, log, sleep, napoveda });
  return json;
}

/** Adresa statistik kampaní za okno: denní granularita, atributy ATRIBUTY, stránka `limit`/`offset`. */
export function urlKampani(from, to, { limit = LIMIT, offset = 0 } = {}) {
  const u = new URL(`${API}/sklik/campaigns/`);
  u.searchParams.set('statisticsDateFrom', from);
  u.searchParams.set('statisticsDateTo', to);
  u.searchParams.set('statisticsGranularity', 'daily');
  for (const a of ATRIBUTY) u.searchParams.append('a', a);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('offset', String(offset));
  return u.toString();
}

/** Řádky (kampaň × den) ze stránky odpovědi: `items`, nebo holé pole řádků. */
export function radkyZeStranky(stranka) {
  if (Array.isArray(stranka)) return stranka;
  return Array.isArray(stranka?.items) ? stranka.items : [];
}

/** Počet řádků (kampaň × den) na stránce — podle nich se stránkuje (`limit`/`offset` počítají řádky, ne kampaně). */
export function pocetRadku(stranka) {
  return radkyZeStranky(stranka).length;
}

/** Platforma podle typu kampaně: `zbozi` → zbozi, ostatní → sklik. */
export function platformaKampane(kampan) {
  return String(kampan?.type ?? '').trim().toLowerCase() === 'zbozi' ? 'zbozi' : 'sklik';
}

/** Stránka nebo pole stránek jako pole stránek (pole řádků bez `items` je jedna stránka). */
function stranky(odpoved) {
  if (!Array.isArray(odpoved)) return odpoved ? [odpoved] : [];
  const jeStranka = (s) => s && typeof s === 'object' && Array.isArray(s.items);
  return odpoved.length && odpoved.every(jeStranka) ? odpoved : [odpoved];
}

/**
 * Stránka (nebo stránky) `/sklik/campaigns/` → řádky kampaní pro platformy
 * sklik/zbozi a denní součty každé z nich. Každý řádek odpovědi je jedna
 * kampaň v jednom dni (`firstDate`), haléře → Kč. Čistá funkce.
 */
export function parsuj(odpoved, ctx = {}) {
  const kampane = [];
  let bezData = 0;
  for (const stranka of stranky(odpoved)) {
    for (const r of radkyZeStranky(stranka)) {
      const date = datumZOdpovedi(r?.firstDate ?? r?.date);
      if (!date) { bezData++; continue; }
      kampane.push({
        platform: platformaKampane(r), date, segment_kind: 'campaign',
        segment: String(r?.name ?? '').trim() || `Kampaň ${r?.id ?? '?'}`,
        impressions: cislo(r.impressions),
        clicks: cislo(r.clicks),
        cost: cislo(r.totalMoney) / 100,
        conversions: cislo(r.conversions),
        conversion_value: cislo(r.conversionValue) / 100,
      });
    }
  }
  if (bezData && Array.isArray(ctx.varovani)) ctx.varovani.push(`Sklik: ${bezData} řádků statistik bez data (firstDate) přeskočeno`);
  return [...souctyPoDnech(kampane, ctx), ...sectiSVarovanim(kampane, ctx)];
}

/**
 * Normalizované řádky Skliku a Zboží za okno [from, to]. `tajemstvi` je
 * klíč API Fénix; `fetchImpl`, `sleep`, `now` a `limit` jsou pro testy.
 */
export async function fetchDaily({ source, from, to, tajemstvi, log, fetchImpl, sleep = spi, now = () => new Date(), limit = LIMIT } = {}) {
  const klic = klicApi(tajemstvi);
  const userId = jenCislice(source?.external_id);
  const ctx = { fetchImpl, log, sleep, now };
  let token = await pristupovyToken(klic, userId, ctx);

  const stranky = [];
  let offset = 0;
  let obnoveno = false;
  let predchozi = '';
  while (stranky.length < MAX_STRANEK) {
    let stranka;
    try {
      stranka = await volejSklik(urlKampani(from, to, { limit, offset }), token, { ...ctx, nazev: 'Sklik kampaně' });
    } catch (err) {
      if (err?.status === 401 && !obnoveno) {
        obnoveno = true;
        tokeny.delete(`${otiskTajemstvi(klic)}:${userId}`);
        token = await pristupovyToken(klic, userId, ctx);
        continue;
      }
      throw err;
    }
    const n = pocetRadku(stranka);
    const otisk = JSON.stringify(stranka);
    // Pojistka: kdyby API offset ignorovalo, stejná stránka by se sečetla dvakrát — nepřidá se a končí se.
    if (n > 0 && otisk === predchozi) {
      log?.warn?.({ offset, radku: n }, `Sklik: stránka s offsetem ${offset} je stejná jako předchozí, stránkování končí`);
      break;
    }
    stranky.push(stranka);
    if (n < limit) break;
    offset += n;
    predchozi = otisk;
    await sleep(PRODLEVA_MS);
  }

  const varovani = [];
  const radky = parsuj(stranky, { from, to, varovani });
  return normalizujRadky(radky, { from, to, platform, log, nazev: `Sklik ${from}–${to}`, varovani });
}

/**
 * Účet přes /user/me (userName, userId, scope) a kredit Peněženky přes
 * /user/me/credit (Kč bez DPH; klient agentury kredit nemá). Klíč bez
 * scope `campaign` by při syncu padal na 403, proto je to už tady ok: false.
 * Nikdy nevyhodí.
 */
export async function overit({ source, tajemstvi, log, fetchImpl, sleep = spi, now = () => new Date() } = {}) {
  try {
    const klic = klicApi(tajemstvi);
    const userId = jenCislice(source?.external_id);
    const ctx = { fetchImpl, log, sleep, now };
    const token = await pristupovyToken(klic, userId, ctx);
    const me = await volejSklik(`${API}/user/me`, token, { ...ctx, nazev: 'Sklik účet' });
    const ucet = me?.userName ?? me?.userId ?? '?';
    const zastupce = me?.actor?.userName ? ` přes ${me.actor.userName}` : '';
    if (Array.isArray(me?.scope) && !me.scope.includes(SCOPE_KAMPANI)) {
      return { ok: false, zprava: `Účet Sklik ${ucet}: klíč nemá právo „${SCOPE_KAMPANI}“ (čtení kampaní), má jen: ${me.scope.join(', ') || 'nic'} — založte klíč s právem čtení celého účtu` };
    }

    let kredit = '';
    try {
      const c = await volejSklik(`${API}/user/me/credit`, token, { ...ctx, nazev: 'Sklik kredit' });
      kredit = c?.credit != null
        ? `, kredit Peněženky ${kc(cislo(c.credit))} bez DPH`
        : `, bez vlastní Peněženky (${c?.agencyStatus || 'agenturní fakturace'})`;
    } catch {
      kredit = ' (kredit se nepodařilo načíst)';
    }
    return { ok: true, zprava: `Účet Sklik ${ucet}${zastupce}${userId ? ` (propojený účet ${userId})` : ''}${kredit}, pásmo Europe/Prague` };
  } catch (err) {
    return { ok: false, zprava: zpravaOvereni(err, { platform }) };
  }
}
