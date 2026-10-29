/**
 * Noční stahování statistik marketingových platforem do
 * `marketing_daily_stats` (plán D5).
 *
 * Každý tik (10 min) projde aktivní zdroje aktivních e-shopů (zdroje.js) a
 * po páté hodině pražského času zajistí, že za každý zdroj proběhl dnes jeden
 * automatický běh. Běh je řádek `marketing_sync_runs`, který vzniká PŘED prací
 * a je zároveň zámkem — částečné unikátní indexy (jeden auto běh na zdroj
 * a den, nejvýš jeden rozběhnutý) drží i při překryvu starého a nového
 * kontejneru při nasazení, stejně jako u expedice (src/expedice.js).
 *
 * ## Co se stahuje
 *
 * Okno `[dnes − prepisDni, včera]` (adaptér říká, kolik dní platforma
 * restatuje: GA4 a Ads 14, konverze Skliku, Heureky a Mety 30) rozdělené na
 * kusy po `maxDniNaDotaz`. Při prvním běhu od `since` zdroje (strop 400 dní).
 * Výsledek se ukládá v jedné transakci jako DELETE okna + INSERT: kampaň,
 * která z platformy zmizela (přejmenovaná), by jinak zůstala v okně navždy.
 * Adaptér Skliku zapisuje dvě platformy (`sklik` + `zbozi`) — maže se okno
 * všech, které deklaruje v `zapisujePlatformy`.
 *
 * ## Chyby
 *
 * Trvalá (401/403/400, nerozšifrovatelný token, špatné ID) → běh `chyba`
 * s `permanent`, upozornění hned a žádné opakování, dokud někdo nezmění
 * nastavení. Přechodná (timeout, 429, 5xx) → `chyba` a backoff 10/20/30 min
 * (sync-pravidla.js), po šestém pokusu upozornění. Text chyby do 500 znaků.
 *
 * Adaptéry se načítají líně z ./adapters/index.js: server musí nastartovat
 * i bez nich (jen pak nic nestahuje a ruční běh to řekne).
 */

import { getDb } from '../db.js';
import { jenDatum, prazskyCas, pridejDny } from '../prazsky-cas.js';
import { KONSTANTY, jeTrvalaChyba, jeVOkneSyncu, oknoSyncu, rozdelOkno, rozhodniAlertPno, rozhodniBehSyncu } from './sync-pravidla.js';
import { METRIKY, normalizujRadek } from './normalizace.js';
import { aktivniZdroje, tajemstviZdroje } from './zdroje.js';
import { TajemstviError } from './tajemstvi.js';
import { oznamPno, oznamSelhaniSyncu } from './alerty.js';
import { popisMesice } from './obdobi.js';
import * as kpi from './kpi.js';

export class SyncBeziError extends Error {
  constructor() { super('Pro tenhle zdroj právě běží stahování'); this.name = 'SyncBeziError'; }
}

/** Sloupce INSERTu do marketing_daily_stats — tvar řádku z normalizace.js + shop_id a run_id. */
export const SLOUPCE_RADKU = ['shop_id', 'platform', 'date', 'segment_kind', 'segment', ...METRIKY, 'run_id'];

/** Nejdelší ruční okno (stejný strop jako první běh). */
export const MAX_DNI_RUCNE = KONSTANTY.prvniBehMaxDni;

/** Hodina pražského času, od které se hlásí PNO nad prahem (data za včerejšek už jsou stažená). */
export const HODINA_PNO = 7;

/** Click-id u objednávek se maže po 90 dnech (plán C2 — pseudonymní identifikátor nemá ležet u objednávky roky). */
export const RETENCE_CLICK_ID_DNI = 90;

const DAVKA_INSERTU = 500;

let adapteryCache = null;

/** Registr adaptérů; bez modulu prázdný objekt (server bez adaptérů jen nic nestahuje). */
export async function nactiAdaptery() {
  if (adapteryCache) return adapteryCache;
  try {
    const m = await import('./adapters/index.js');
    adapteryCache = m.ADAPTERS ?? {};
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    return {};
  }
  return adapteryCache;
}

// ── Běhy (zámek v databázi) ────────────────────────────────────

/**
 * Založí běh. Automatický přes ON CONFLICT DO NOTHING: prázdný výsledek
 * znamená „dnes už běželo“ nebo „něco právě běží“. Ruční běh na rozběhnutý
 * zdroj vyhodí SyncBeziError (druhý částečný index).
 */
export async function zalozBehSyncu(sql, { zdroj, kind = 'auto', runDate, od, do: do_, userId = null }) {
  try {
    if (kind === 'auto') {
      const [row] = await sql`
        INSERT INTO marketing_sync_runs (source_id, shop_id, platform, kind, run_date, status, attempt, from_date, to_date)
        VALUES (${zdroj.id}, ${zdroj.shop_id}, ${zdroj.platform}, 'auto', ${runDate}, 'probiha', 1, ${od}, ${do_})
        ON CONFLICT DO NOTHING
        RETURNING *`;
      return row ?? null;
    }
    const [row] = await sql`
      INSERT INTO marketing_sync_runs (source_id, shop_id, platform, kind, run_date, status, attempt, from_date, to_date, started_by)
      VALUES (${zdroj.id}, ${zdroj.shop_id}, ${zdroj.platform}, 'rucni', ${runDate}, 'probiha', 1, ${od}, ${do_}, ${userId})
      RETURNING *`;
    return row;
  } catch (err) {
    if (err.code === '23505') throw new SyncBeziError();
    throw err;
  }
}

/** Další pokus po přechodné chybě — compare-and-set, kdo neuspěje, nemá co dělat. */
export async function prevezmiBehSyncu(sql, dnesni, { od, do: do_ }) {
  try {
    const [row] = await sql`
      UPDATE marketing_sync_runs
      SET status = 'probiha', attempt = attempt + 1, started_at = NOW(), finished_at = NULL,
          error = '', permanent = FALSE, from_date = ${od}, to_date = ${do_}
      WHERE id = ${dnesni.id} AND status = 'chyba'
      RETURNING *`;
    return row ?? null;
  } catch (err) {
    if (err.code === '23505') return null;
    throw err;
  }
}

async function oznacChybuBehu(sql, beh, chyba, permanent) {
  const text = String(chyba?.message ?? chyba ?? 'neznámá chyba').slice(0, 500);
  const [row] = await sql`
    UPDATE marketing_sync_runs
    SET status = 'chyba', permanent = ${Boolean(permanent)}, error = ${text}, finished_at = NOW()
    WHERE id = ${beh.id}
    RETURNING *`;
  return row ?? { ...beh, status: 'chyba', permanent, error: text };
}

async function dokonciBehSyncu(sql, beh, rowsSaved) {
  await sql`
    UPDATE marketing_sync_runs
    SET status = 'hotovo', rows_saved = ${rowsSaved}, error = '', finished_at = NOW()
    WHERE id = ${beh.id}`;
}

// ── Zápis okna ─────────────────────────────────────────────────

/**
 * Nahradí řádky platforem v okně `[od, do]` novými — jedna transakce, aby
 * přehled nikdy neviděl smazané okno bez nových dat. Řádky mimo okno nebo
 * cizí platformy se nezapíší (hlídá to už adaptér, tady je to pojistka).
 */
export async function ulozOkno(sql, { shopId, platformy, od, do: do_, radky, runId = null }) {
  const vhodne = (radky ?? []).filter(r => platformy.includes(r.platform) && r.date >= od && r.date <= do_);
  const hodnoty = vhodne.map(r => {
    const h = { shop_id: shopId, run_id: runId, platform: r.platform, date: r.date, segment_kind: r.segment_kind ?? '', segment: r.segment ?? '' };
    for (const m of METRIKY) h[m] = Number(r[m]) || 0;
    return h;
  });
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM marketing_daily_stats
      WHERE shop_id = ${shopId} AND platform = ANY(${platformy}) AND date BETWEEN ${od} AND ${do_}`;
    for (let i = 0; i < hodnoty.length; i += DAVKA_INSERTU) {
      await tx`INSERT INTO marketing_daily_stats ${tx(hodnoty.slice(i, i + DAVKA_INSERTU), ...SLOUPCE_RADKU)}`;
    }
  });
  return hodnoty.length;
}

// ── Stažení jednoho zdroje ─────────────────────────────────────

/** E-shop ke zdroji ve tvaru, který čekají adaptéry a tajemstviZdroje(). */
function shopZeZdroje(zdroj) {
  return {
    id: zdroj.shop_id, slug: zdroj.slug, name: zdroj.shop_name, url: zdroj.shop_url,
    webhook_secret: zdroj.shop_webhook_secret ?? '',
  };
}

/**
 * Stáhne okno přes adaptér, znormalizuje a uloží. Vrací počet řádků.
 * Chyby propadají volajícímu (ten rozhodne o trvalosti a backoffu).
 */
export async function stahniZdroj(sql, log, { zdroj, adapter, od, do: do_, beh, fetchImpl }) {
  const shop = shopZeZdroje(zdroj);
  const platformy = adapter.zapisujePlatformy ?? [zdroj.platform];
  let tajemstvi;
  try {
    tajemstvi = tajemstviZdroje(zdroj, shop);
  } catch (err) {
    if (err instanceof TajemstviError) { err.permanent = true; }
    throw err;
  }
  const radky = [];
  let zahozeno = 0;
  for (const kus of rozdelOkno(od, do_, adapter.maxDniNaDotaz ?? 31)) {
    const vysledek = await adapter.fetchDaily({ shop, source: zdroj, from: kus.od, to: kus.do, tajemstvi, log, fetchImpl });
    for (const surovy of vysledek ?? []) {
      const { radek, duvod, varovani } = normalizujRadek(surovy, { from: od, to: do_, platform: zdroj.platform });
      if (!radek) { zahozeno += 1; continue; }
      if (!platformy.includes(radek.platform)) { zahozeno += 1; continue; }
      if (varovani?.length) log?.debug?.({ platform: radek.platform, date: radek.date, varovani }, 'Marketing sync: řádek s varováním');
      radky.push(radek);
    }
  }
  if (zahozeno) log?.warn?.({ platform: zdroj.platform, shop: zdroj.slug, zahozeno }, 'Marketing sync: řádky mimo okno nebo platformu zahozeny');
  return ulozOkno(sql, { shopId: zdroj.shop_id, platformy, od, do: do_, radky, runId: beh?.id ?? null });
}

/** Provede běh (už založený): stáhne, zapíše výsledek do běhu i zdroje, pošle upozornění při chybě. */
async function provedBeh(sql, log, { zdroj, adapter, beh, od, do: do_, fetchImpl }) {
  await sql`UPDATE marketing_sources SET last_run_at = NOW() WHERE id = ${zdroj.id}`;
  try {
    const pocet = await stahniZdroj(sql, log, { zdroj, adapter, od, do: do_, beh, fetchImpl });
    await dokonciBehSyncu(sql, beh, pocet);
    await sql`UPDATE marketing_sources SET last_ok_at = NOW(), last_error = '' WHERE id = ${zdroj.id}`;
    log?.info?.({ platform: zdroj.platform, shop: zdroj.slug, od, do: do_, pocet }, 'Marketing sync hotov');
    return { ...beh, status: 'hotovo', rows_saved: pocet };
  } catch (err) {
    const permanent = jeTrvalaChyba(err);
    const chyba = await oznacChybuBehu(sql, beh, err, permanent);
    await sql`UPDATE marketing_sources SET last_error = ${chyba.error} WHERE id = ${zdroj.id}`;
    log?.error?.({ err, platform: zdroj.platform, shop: zdroj.slug, permanent, attempt: chyba.attempt }, 'Marketing sync selhal');
    if (permanent || chyba.attempt >= KONSTANTY.maxPokusu) {
      await oznamSelhaniSyncu(sql, log, { zdroj, beh: chyba, shopName: zdroj.shop_name, shopSlug: zdroj.slug }).catch(e => log?.error?.({ err: e }, 'Marketing: upozornění na selhání syncu neodešlo'));
    }
    return chyba;
  }
}

// ── Automatický běh ────────────────────────────────────────────

async function zpracujZdrojAuto(sql, log, { zdroj, adapter, prazsky, now, fetchImpl }) {
  const [dnesni] = await sql`
    SELECT * FROM marketing_sync_runs
    WHERE source_id = ${zdroj.id} AND kind = 'auto' AND run_date = ${prazsky.datum}
    LIMIT 1`;
  const { akce, duvod } = rozhodniBehSyncu({ dnesni, now });
  if (akce === 'nic') return null;

  if (akce === 'oznacit-chybu') {
    await oznacChybuBehu(sql, dnesni, duvod, false);
    log?.warn?.({ runId: dnesni.id, platform: zdroj.platform }, `Marketing sync: ${duvod}`);
    return null;
  }

  const okno = oknoSyncu({ zdroj, dnes: prazsky.datum, prepisDni: adapter.prepisDni ?? KONSTANTY.prepisDni });
  if (!okno.od || !okno.do || okno.od > okno.do) return null;

  const beh = akce === 'zalozit'
    ? await zalozBehSyncu(sql, { zdroj, kind: 'auto', runDate: prazsky.datum, od: okno.od, do: okno.do })
    : await prevezmiBehSyncu(sql, dnesni, okno);
  if (!beh) return null;  // jiný tik nebo ruční běh byl rychlejší

  return provedBeh(sql, log, { zdroj, adapter, beh, od: okno.od, do: okno.do, fetchImpl });
}

/** Po smyčce: retence click-id a upozornění na PNO nad prahem (jednou za den po sedmé). */
export async function poSmycce(sql, log, prazsky) {
  await sql`
    UPDATE shop_orders SET click_id_first = '', click_id_last = ''
    WHERE created_at < NOW() - ${`${RETENCE_CLICK_ID_DNI} days`}::interval
      AND (click_id_first <> '' OR click_id_last <> '')`;

  if (prazsky.hodina < HODINA_PNO) return;
  const shopy = await sql`
    SELECT id, slug, name, marketing_pno_alert_pct::float8 AS prah
    FROM shops WHERE active = TRUE AND marketing_pno_alert_pct > 0`;
  const od = `${prazsky.datum.slice(0, 7)}-01`;
  const do_ = pridejDny(prazsky.datum, -1);
  if (do_ < od) return;  // prvního v měsíci není co hodnotit
  for (const shop of shopy) {
    try {
      const rozsah = { shopId: shop.id, od, do: do_ };
      const [objednavky, nakladyApi, rucni] = await Promise.all([
        kpi.objednavkyZaObdobi(sql, rozsah), kpi.nakladyPlatforem(sql, rozsah), kpi.rucniNaklady(sql, rozsah),
      ]);
      const trzby = kpi.bezDph(objednavky.reduce((s, o) => s + (Number(o.total_price) || 0), 0));
      const naklady = nakladyApi.reduce((s, n) => s + (Number(n.naklady) || 0), 0)
        + rucni.reduce((s, n) => s + kpi.rozpoctiManualniNaklad(n, od, do_), 0);
      const { pno } = kpi.spoctiKpi({ trzbyBezDph: trzby, pocetObjednavek: objednavky.length, naklady });
      if (rozhodniAlertPno({ pno, prah: shop.prah, naklady })) {
        await oznamPno(sql, log, { shop, datum: prazsky.datum, pno, prah: shop.prah, naklady, trzby, mesicPopis: popisMesice(od) });
      }
    } catch (err) {
      log?.error?.({ err, shop: shop.slug }, 'Marketing: kontrola PNO selhala');
    }
  }
}

let bezi = false;

/**
 * Jeden tik plánovače. `adaptery`, `now` a `fetchImpl` jsou pro testy;
 * v provozu se adaptéry načtou z ./adapters/index.js.
 */
export async function tikMarketing(log, { adaptery, now = new Date(), fetchImpl } = {}) {
  if (bezi) return;
  bezi = true;
  try {
    const sql = getDb();
    const prazsky = prazskyCas(now);
    if (!jeVOkneSyncu(prazsky)) return;
    const registr = adaptery ?? await nactiAdaptery();
    const zdroje = await aktivniZdroje(sql);
    for (const zdroj of zdroje) {
      const adapter = registr[zdroj.platform];
      if (!adapter) continue;  // např. zbozi — plní ho adaptér Skliku
      try {
        await zpracujZdrojAuto(sql, log, { zdroj, adapter, prazsky, now, fetchImpl });
      } catch (err) {
        log?.error?.({ err, platform: zdroj.platform, shop: zdroj.slug }, 'Marketing sync: zpracování zdroje selhalo');
      }
    }
    await poSmycce(sql, log, prazsky);
  } finally {
    bezi = false;
  }
}

export function startMarketingScheduler(log) {
  const tik = () => tikMarketing(log).catch(err => log?.error?.({ err }, 'marketing sync tick error'));
  setTimeout(tik, 45_000);
  setInterval(tik, 10 * 60_000);
}

// ── Ruční běh ──────────────────────────────────────────────────

/**
 * Ruční stažení z administrace (jen správce): všechny aktivní zdroje
 * e-shopu, nebo jedna platforma; okno výslovné (max 400 dní, do nejvýš dnes)
 * nebo výchozí jako v noci. Běží synchronně a vrací řádky běhů. Rozběhnutý
 * zdroj vyhodí SyncBeziError.
 */
export async function spustSyncRucne({ sql = getDb(), log, shopId, platform = 'vse', od = null, do: do_ = null, userId = null, adaptery, fetchImpl, now = new Date() } = {}) {
  const registr = adaptery ?? await nactiAdaptery();
  const prazsky = prazskyCas(now);
  const zdroje = await sql`
    SELECT src.*, s.slug, s.name AS shop_name, s.url AS shop_url, s.webhook_secret AS shop_webhook_secret
    FROM marketing_sources src JOIN shops s ON s.id = src.shop_id
    WHERE src.shop_id = ${shopId} AND src.active = TRUE
      AND (${platform} = 'vse' OR src.platform = ${platform})
    ORDER BY src.platform`;

  const vlastniOd = od ? jenDatum(od) : null;
  const vlastniDo = do_ ? jenDatum(do_) : null;
  if ((od && !vlastniOd) || (do_ && !vlastniDo)) throw new Error('Okno musí být ve tvaru RRRR-MM-DD');

  const vysledky = [];
  for (const zdroj of zdroje) {
    const adapter = registr[zdroj.platform];
    if (!adapter) continue;
    let okno = oknoSyncu({ zdroj, dnes: prazsky.datum, prepisDni: adapter.prepisDni ?? KONSTANTY.prepisDni });
    if (vlastniOd || vlastniDo) {
      const doKonec = vlastniDo && vlastniDo <= prazsky.datum ? vlastniDo : pridejDny(prazsky.datum, -1);
      const odZacatek = vlastniOd ?? pridejDny(doKonec, -(KONSTANTY.prepisDni - 1));
      okno = { od: odZacatek < pridejDny(doKonec, -(MAX_DNI_RUCNE - 1)) ? pridejDny(doKonec, -(MAX_DNI_RUCNE - 1)) : odZacatek, do: doKonec };
    }
    if (!okno.od || !okno.do || okno.od > okno.do) continue;
    const beh = await zalozBehSyncu(sql, { zdroj, kind: 'rucni', runDate: prazsky.datum, od: okno.od, do: okno.do, userId });
    vysledky.push(await provedBeh(sql, log, { zdroj, adapter, beh, od: okno.od, do: okno.do, fetchImpl }));
  }
  return vysledky;
}
