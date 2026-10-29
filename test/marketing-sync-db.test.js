// Noční stahování marketingových statistik (src/marketing/sync.js) proti
// testovací databázi s falešným adaptérem — bez volání skutečných platforem.
//
// Hlídá: ruční běh uloží okno a označí běh hotovo; opakovaný zápis okna
// nahradí staré řádky a nedotkne se řádků mimo okno; rozběhnutý zdroj druhý
// ruční běh odmítne; trvalá chyba adaptéru skončí během `chyba` s `permanent`,
// zapíše se ke zdroji a vyvolá upozornění (řádek v notification_log);
// po smyčce se maže click-id starší 90 dní a PNO nad prahem se hlásí jednou
// za den.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… node --test test/marketing-sync-db.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { prazskyCas, pridejDny } from '../src/prazsky-cas.js';
// sync.js (přes alerty.js a healthcheck-worker.js) otevírá databázi už při
// importu — bez DATABASE_URL se moduly načtou až v before(), ať soubor
// přeskočí místo pádu.
let SyncBeziError, poSmycce, spustSyncRucne, ulozOkno, UDALOST_PNO, UDALOST_SYNC;

const DATABASE_URL = process.env.DATABASE_URL || '';
const r = crypto.randomBytes(4).toString('hex');

function lokalniDatabaze() {
  const host = DATABASE_URL ? new URL(DATABASE_URL).hostname : '';
  if (!['127.0.0.1', 'localhost'].includes(host) && process.env.TEST_DB_ALLOW_REMOTE !== '1') {
    throw new Error(`Test zapisuje statistiky a objednávky — DATABASE_URL musí mířit na 127.0.0.1/localhost, ne na "${host}"`);
  }
  return DATABASE_URL;
}

let sql;
const ctx = {};
const log = { info() {}, warn() {}, error() {}, debug() {} };

/** Adaptér, který vrátí připravené řádky, nebo vyhodí připravenou chybu. */
function falesnyAdapter({ radky = [], chyba = null, zapisujePlatformy = ['ga4'] } = {}) {
  const volani = [];
  return {
    platform: 'ga4', zapisujePlatformy, maxDniNaDotaz: 31, prepisDni: 14,
    volani,
    async fetchDaily({ from, to }) {
      volani.push({ from, to });
      if (chyba) throw chyba;
      return radky.filter(x => x.date >= from && x.date <= to);
    },
    async overit() { return { ok: true, zprava: 'test' }; },
  };
}

describe('marketing sync proti databázi', { skip: !DATABASE_URL && 'bez DATABASE_URL' }, () => {
  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 3, onnotice: () => {} });
    ({ SyncBeziError, poSmycce, spustSyncRucne, ulozOkno } = await import('../src/marketing/sync.js'));
    ({ UDALOST_PNO, UDALOST_SYNC } = await import('../src/marketing/alerty.js'));
    const [u] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`sync-${r}@example.invalid`}, 'x', 'Test', 'Sync', TRUE) RETURNING id`;
    ctx.userId = u.id;
    const [shop] = await sql`
      INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address, marketing_pno_alert_pct)
      VALUES (${`test-sync-${r}`}, ${`Sync test ${r}`}, 'https://example.invalid', TRUE, 'Test', 'noreply@example.invalid', 20)
      RETURNING *`;
    ctx.shop = shop;
    const [zdroj] = await sql`
      INSERT INTO marketing_sources (shop_id, platform, active, external_id)
      VALUES (${shop.id}, 'ga4', TRUE, '318467224') RETURNING *`;
    ctx.zdroj = zdroj;
    ctx.dnes = prazskyCas().datum;
    ctx.vcera = pridejDny(ctx.dnes, -1);
    ctx.predevcirem = pridejDny(ctx.dnes, -2);
  });

  after(async () => {
    if (!sql) return;
    await sql`DELETE FROM notification_log WHERE event_type IN (${UDALOST_SYNC}, ${UDALOST_PNO}) AND (event_key LIKE ${ctx.zdroj.id + ':%'} OR event_key LIKE ${ctx.shop.id + ':%'})`;
    await sql`DELETE FROM shop_orders WHERE shop_id = ${ctx.shop.id}`;
    await sql`DELETE FROM marketing_daily_stats WHERE shop_id = ${ctx.shop.id}`;
    await sql`DELETE FROM marketing_sync_runs WHERE shop_id = ${ctx.shop.id}`;
    await sql`DELETE FROM marketing_sources WHERE shop_id = ${ctx.shop.id}`;
    await sql`DELETE FROM shops WHERE id = ${ctx.shop.id}`;
    await sql`DELETE FROM users WHERE id = ${ctx.userId}`;
    await sql.end();
  });

  test('ruční běh uloží řádky okna a označí běh hotovo', async () => {
    const adapter = falesnyAdapter({ radky: [
      { platform: 'ga4', date: ctx.predevcirem, segment_kind: '', segment: '', sessions: 120, purchase: 2, purchase_revenue: 2500.5 },
      { platform: 'ga4', date: ctx.predevcirem, segment_kind: 'channel', segment: 'google / cpc', sessions: 80, purchase: 2, purchase_revenue: 2500.5 },
      { platform: 'ga4', date: ctx.vcera, segment_kind: '', segment: '', sessions: 90 },
      { platform: 'ga4', date: pridejDny(ctx.dnes, 1), segment_kind: '', segment: '', sessions: 999 },  // zítřek – mimo okno, zahodit
    ] });
    const vysledky = await spustSyncRucne({ sql, log, shopId: ctx.shop.id, platform: 'ga4', userId: ctx.userId, adaptery: { ga4: adapter } });
    assert.equal(vysledky.length, 1);
    assert.equal(vysledky[0].status, 'hotovo');
    assert.equal(vysledky[0].rows_saved, 3, 'řádek mimo okno se nezapsal');
    assert.ok(adapter.volani.length >= 1);
    assert.equal(adapter.volani.at(-1).to, ctx.vcera, 'okno končí včerejškem');
    assert.ok(adapter.volani[0].from <= pridejDny(ctx.dnes, -14), 'první běh bez „stahovat od“ jde aspoň 14 dní zpět');

    const radky = await sql`SELECT date::text AS date, segment_kind, segment, sessions, purchase_revenue::float8 AS purchase_revenue FROM marketing_daily_stats WHERE shop_id = ${ctx.shop.id} ORDER BY date, segment_kind`;
    assert.equal(radky.length, 3);
    assert.deepEqual(radky.map(x => x.sessions), [120, 80, 90]);
    assert.equal(radky[0].purchase_revenue, 2500.5);

    const [z] = await sql`SELECT last_ok_at, last_error FROM marketing_sources WHERE id = ${ctx.zdroj.id}`;
    assert.ok(z.last_ok_at, 'zdroj má čas posledního úspěchu');
    assert.equal(z.last_error, '');
    const [beh] = await sql`SELECT * FROM marketing_sync_runs WHERE source_id = ${ctx.zdroj.id} ORDER BY id DESC LIMIT 1`;
    assert.equal(beh.kind, 'rucni');
    assert.equal(beh.started_by, ctx.userId);
    assert.ok(beh.finished_at);
  });

  test('zápis okna nahradí staré řádky a nechá řádky mimo okno', async () => {
    const mimo = pridejDny(ctx.dnes, -60);
    await sql`INSERT INTO marketing_daily_stats (shop_id, platform, date, segment_kind, segment, sessions) VALUES (${ctx.shop.id}, 'ga4', ${mimo}, '', '', 7)`;
    const pocet = await ulozOkno(sql, {
      shopId: ctx.shop.id, platformy: ['ga4'], od: ctx.predevcirem, do: ctx.vcera,
      radky: [{ platform: 'ga4', date: ctx.vcera, segment_kind: '', segment: '', sessions: 5 }],
    });
    assert.equal(pocet, 1);
    const radky = await sql`SELECT date::text AS date, sessions FROM marketing_daily_stats WHERE shop_id = ${ctx.shop.id} ORDER BY date`;
    assert.deepEqual(radky.map(x => ({ date: x.date, sessions: x.sessions })), [{ date: mimo, sessions: 7 }, { date: ctx.vcera, sessions: 5 }], 'okno přepsané, řádek mimo okno zůstal');
  });

  test('trvalá chyba adaptéru: běh chyba + permanent, chyba u zdroje, upozornění jednou', async () => {
    const chyba = Object.assign(new Error('403 service account nemá přístup'), { permanent: true, status: 403 });
    const adapter = falesnyAdapter({ chyba });
    const [beh] = await spustSyncRucne({ sql, log, shopId: ctx.shop.id, platform: 'ga4', adaptery: { ga4: adapter } });
    assert.equal(beh.status, 'chyba');
    assert.equal(beh.permanent, true);
    assert.match(beh.error, /403/);
    const [z] = await sql`SELECT last_error FROM marketing_sources WHERE id = ${ctx.zdroj.id}`;
    assert.match(z.last_error, /403/);
    const log1 = await sql`SELECT * FROM notification_log WHERE event_type = ${UDALOST_SYNC} AND event_key LIKE ${ctx.zdroj.id + ':%'}`;
    assert.equal(log1.length, 1, 'upozornění zapsané');

    // druhé selhání týž den už neotravuje
    await spustSyncRucne({ sql, log, shopId: ctx.shop.id, platform: 'ga4', adaptery: { ga4: adapter } });
    const log2 = await sql`SELECT * FROM notification_log WHERE event_type = ${UDALOST_SYNC} AND event_key LIKE ${ctx.zdroj.id + ':%'}`;
    assert.equal(log2.length, 1);
  });

  test('rozběhnutý zdroj odmítne další ruční běh', async () => {
    await sql`
      INSERT INTO marketing_sync_runs (source_id, shop_id, platform, kind, run_date, status, from_date, to_date)
      VALUES (${ctx.zdroj.id}, ${ctx.shop.id}, 'ga4', 'rucni', ${ctx.dnes}, 'probiha', ${ctx.vcera}, ${ctx.vcera})`;
    await assert.rejects(
      spustSyncRucne({ sql, log, shopId: ctx.shop.id, platform: 'ga4', adaptery: { ga4: falesnyAdapter() } }),
      SyncBeziError,
    );
    await sql`DELETE FROM marketing_sync_runs WHERE source_id = ${ctx.zdroj.id} AND status = 'probiha'`;
  });

  test('po smyčce: click-id starší 90 dní zmizí, PNO nad prahem se ohlásí jednou za den', async () => {
    const stare = new Date(Date.now() - 100 * 24 * 3600_000);
    const nove = new Date(`${ctx.predevcirem}T10:00:00Z`);
    await sql`
      INSERT INTO shop_orders (id, shop_id, order_number, status, payment_method, total_price, created_at, email, click_id_kind_last, click_id_last, touch_last_at)
      VALUES (${`sync-${r}-stara`}, ${ctx.shop.id}, 'S1', 'Zaplaceno', 'Platba kartou', 1210, ${stare}, 'x@example.invalid', 'gclid', 'STARY', ${stare}),
             (${`sync-${r}-nova`},  ${ctx.shop.id}, 'S2', 'Zaplaceno', 'Platba kartou', 1210, ${nove},  'x@example.invalid', 'gclid', 'NOVY',  ${nove})`;
    // náklady za tento měsíc: 500 Kč proti tržbě 1 000 bez DPH → PNO 50 % > práh 20 %
    await sql`INSERT INTO marketing_daily_stats (shop_id, platform, date, segment_kind, segment, cost) VALUES (${ctx.shop.id}, 'sklik', ${ctx.predevcirem}, '', '', 500)`;

    await poSmycce(sql, log, { datum: ctx.dnes, hodina: 7 });
    const ids = await sql`SELECT id, click_id_last FROM shop_orders WHERE shop_id = ${ctx.shop.id} ORDER BY id`;
    assert.equal(ids.find(o => o.id.endsWith('stara')).click_id_last, '', 'staré click-id smazané');
    assert.equal(ids.find(o => o.id.endsWith('nova')).click_id_last, 'NOVY', 'nové click-id zůstává');

    const prvni = ctx.dnes.slice(8) === '01' || ctx.dnes.slice(8) === '02';
    const log1 = await sql`SELECT * FROM notification_log WHERE event_type = ${UDALOST_PNO} AND event_key = ${`${ctx.shop.id}:${ctx.dnes}`}`;
    if (!prvni) {
      assert.equal(log1.length, 1, 'PNO nad prahem ohlášeno');
      assert.match(log1[0].message, /PNO .* 50 %/);
      await poSmycce(sql, log, { datum: ctx.dnes, hodina: 8 });
      const log2 = await sql`SELECT * FROM notification_log WHERE event_type = ${UDALOST_PNO} AND event_key = ${`${ctx.shop.id}:${ctx.dnes}`}`;
      assert.equal(log2.length, 1, 'podruhé týž den už ne');
    }
    await poSmycce(sql, log, { datum: ctx.dnes, hodina: 5 });  // před sedmou se PNO nehodnotí – nesmí spadnout
  });
});
