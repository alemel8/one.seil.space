// Nastavení e-shopu → záložka Marketing: marže a práh PNO, napojení platforem
// a tokeny (src/routes/settings.js, src/marketing/zdroje.js).
//
// Token platformy se do databáze ukládá jen šifrovaný (tajemstvi.js) a v
// administraci se ukazuje otiskem; prázdné pole token nechá, akce
// vymazat-tajemstvi ho smaže. Testy s tokenem potřebují, aby server i test
// měly tentýž MARKETING_SECRETS_KEY — bez něj se přeskočí.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   MARKETING_SECRETS_KEY=<64 hex> node --test test/marketing-nastaveni.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';

const BASE   = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.SESSION_SECRET || 'one-seil-space-secret-change-in-production-32chars';
const DATABASE_URL = process.env.DATABASE_URL || '';
const MA_KLIC = /^[0-9a-f]{64}$/i.test(process.env.MARKETING_SECRETS_KEY || '');
const r = crypto.randomBytes(4).toString('hex');

function lokalniDatabaze() {
  const host = DATABASE_URL ? new URL(DATABASE_URL).hostname : '';
  if (!['127.0.0.1', 'localhost'].includes(host) && process.env.TEST_DB_ALLOW_REMOTE !== '1') {
    throw new Error(`Test zakládá e-shopy — DATABASE_URL musí mířit na 127.0.0.1/localhost, ne na "${host}"`);
  }
  return DATABASE_URL;
}

let sql;
const uklid = { shops: [], users: [], sids: [] };
const ctx = {};

async function prihlas(userId) {
  const sid = 'test' + crypto.randomBytes(12).toString('hex');
  const sig = crypto.createHmac('sha256', SECRET).update(sid).digest('base64').replace(/=/g, '');
  uklid.sids.push(sid);
  await sql`
    INSERT INTO session (sid, sess, expire) VALUES (${sid},
      ${{ cookie: { originalMaxAge: 28800000, httpOnly: true, path: '/', sameSite: 'lax', secure: false }, userId }},
      ${new Date(Date.now() + 3600_000)})`;
  return `sessionId=${sid}.${sig}`;
}

const get  = (p, cookie = ctx.cookie) => fetch(BASE + p, { headers: { cookie }, redirect: 'manual' });
const post = (p, body = {}, cookie = ctx.cookie) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});

describe('nastavení: záložka Marketing', { skip: !DATABASE_URL && 'bez DATABASE_URL' }, () => {
  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 3, onnotice: () => {} });
    const health = await fetch(BASE + '/health').catch(() => null);
    assert.ok(health?.ok, `server neběží na ${BASE}`);

    const [u] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`mkt-nast-${r}@example.invalid`}, 'x', 'Test', 'Správce', TRUE) RETURNING id`;
    uklid.users.push(u.id);
    ctx.cookie = await prihlas(u.id);
    const [b] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`mkt-nast-bezny-${r}@example.invalid`}, 'x', 'Test', 'Běžný', FALSE) RETURNING id`;
    uklid.users.push(b.id);
    ctx.beznyCookie = await prihlas(b.id);

    const [shop] = await sql`
      INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address)
      VALUES (${`test-mkt-nast-${r}`}, ${`Nastavení marketingu ${r}`}, 'https://example.invalid', TRUE, 'Test', 'noreply@example.invalid')
      RETURNING *`;
    uklid.shops.push(shop.id);
    ctx.shop = shop;
  });

  after(async () => {
    if (!sql) return;
    const shops = uklid.shops.length ? uklid.shops : [0];
    await sql`DELETE FROM marketing_sources WHERE shop_id = ANY(${shops})`;
    await sql`DELETE FROM shops WHERE id = ANY(${shops})`;
    if (uklid.sids.length)  await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
    if (uklid.users.length) await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
    await sql.end();
  });

  test('detail e-shopu má záložku Marketing se všemi platformami', async () => {
    const res = await get(`/nastaveni/eshopy/${ctx.shop.id}?tab=marketing`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const text of ['Odhad hrubé marže', 'Napojené platformy', 'Google Analytics 4', 'Google Ads', 'Search Console', 'Merchant Center', 'Sklik', 'Heureka', 'Meta', 'E-shop (hledání bez výsledku']) {
      assert.ok(html.includes(text), `záložka obsahuje „${text}“`);
    }
    assert.ok(!html.includes('Ověřit připojení'), 'bez uloženého napojení není co ověřovat');
  });

  test('marže a práh PNO se uloží, nesmysl se odmítne', async () => {
    let res = await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing`, { marketing_margin_pct: '33', marketing_pno_alert_pct: '28,5' });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?tab=marketing&saved=1`);
    let [s] = await sql`SELECT marketing_margin_pct::float8 AS m, marketing_pno_alert_pct::float8 AS p FROM shops WHERE id = ${ctx.shop.id}`;
    assert.equal(s.m, 33);
    assert.equal(s.p, 28.5);

    res = await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing`, { marketing_margin_pct: '150', marketing_pno_alert_pct: '0' });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?tab=marketing&error=marketing-procenta`);
    [s] = await sql`SELECT marketing_margin_pct::float8 AS m FROM shops WHERE id = ${ctx.shop.id}`;
    assert.equal(s.m, 33, 'neplatná hodnota nic nepřepsala');
  });

  test('napojení bez tokenu (GA4): uložení, aktivní, od kdy; neznámá platforma a špatné datum se odmítnou', async () => {
    let res = await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing/zdroj`, { platform: 'ga4', active: '1', external_id: ' 318467224 ', since: '2026-10-01', akce: 'ulozit' });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?tab=marketing&saved=1`);
    const [z] = await sql`SELECT *, since::text AS since_text FROM marketing_sources WHERE shop_id = ${ctx.shop.id} AND platform = 'ga4'`;
    assert.ok(z);
    assert.equal(z.active, true);
    assert.equal(z.external_id, '318467224');
    assert.equal(z.since_text, '2026-10-01');

    res = await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing/zdroj`, { platform: 'ga4', external_id: '318467224', akce: 'ulozit' });
    const [vyp] = await sql`SELECT active FROM marketing_sources WHERE shop_id = ${ctx.shop.id} AND platform = 'ga4'`;
    assert.equal(vyp.active, false, 'bez zaškrtnutí je zdroj vypnutý');

    res = await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing/zdroj`, { platform: 'tiktok', external_id: '1', akce: 'ulozit' });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?tab=marketing&error=marketing-platforma`);
    res = await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing/zdroj`, { platform: 'ga4', external_id: '1', since: '1. 10. 2026', akce: 'ulozit' });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?tab=marketing&error=marketing-datum`);

    const html = await (await get(`/nastaveni/eshopy/${ctx.shop.id}?tab=marketing`)).text();
    assert.ok(html.includes('Ověřit připojení'), 'uložené napojení nabízí ověření');
  });

  test('token se uloží šifrovaný, ukazuje se otiskem, prázdné pole ho nechá, akce ho smaže', { skip: !MA_KLIC && 'chybí MARKETING_SECRETS_KEY (musí být i u serveru)' }, async () => {
    const token = `tajny-token-${r}`;
    let res = await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing/zdroj`, { platform: 'sklik', active: '1', external_id: '555', secret: token, akce: 'ulozit' });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?tab=marketing&saved=1`);
    let [z] = await sql`SELECT secret_enc, secret_fingerprint, secret_set_at FROM marketing_sources WHERE shop_id = ${ctx.shop.id} AND platform = 'sklik'`;
    assert.match(z.secret_enc, /^v1:/, 'šifrovaný tvar');
    assert.ok(z.secret_set_at);
    const otisk = crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
    assert.equal(z.secret_fingerprint, otisk);
    const vse = JSON.stringify(await sql`SELECT * FROM marketing_sources WHERE shop_id = ${ctx.shop.id}`);
    assert.ok(!vse.includes(token), 'token v databázi nikde není v čitelné podobě');

    const html = await (await get(`/nastaveni/eshopy/${ctx.shop.id}?tab=marketing`)).text();
    assert.ok(html.includes(otisk), 'detail ukazuje otisk');
    assert.ok(!html.includes(token), 'detail token neukazuje');

    res = await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing/zdroj`, { platform: 'sklik', active: '1', external_id: '555', secret: '', akce: 'ulozit' });
    const [z2] = await sql`SELECT secret_enc FROM marketing_sources WHERE shop_id = ${ctx.shop.id} AND platform = 'sklik'`;
    assert.equal(z2.secret_enc, z.secret_enc, 'prázdné pole token nechá');

    res = await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing/zdroj`, { platform: 'sklik', active: '1', external_id: '555', secret: 'ma mezeru', akce: 'ulozit' });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?tab=marketing&error=marketing-hodnota`);

    res = await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing/zdroj`, { platform: 'sklik', active: '1', external_id: '555', akce: 'vymazat-tajemstvi' });
    const [z3] = await sql`SELECT secret_enc, secret_fingerprint, secret_set_at FROM marketing_sources WHERE shop_id = ${ctx.shop.id} AND platform = 'sklik'`;
    assert.deepEqual([z3.secret_enc, z3.secret_fingerprint, z3.secret_set_at], ['', '', null]);
  });

  test('ověření napojení vrátí stránku s výsledkem i bez adaptéru', async () => {
    const res = await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing/zdroj/ga4/overit`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Ověření napojení (ga4)'));
    assert.ok(html.includes('name="marketing_margin_pct"'), 'výsledek ověření se ukáže na záložce Marketing');
    const bez = await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing/zdroj/meta/overit`);
    assert.ok((await bez.text()).includes('Napojení není uložené'));
  });

  test('nesprávce do nastavení nemůže', async () => {
    assert.equal((await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing`, { marketing_margin_pct: '1' }, ctx.beznyCookie)).status, 403);
    assert.equal((await post(`/nastaveni/eshopy/${ctx.shop.id}/marketing/zdroj`, { platform: 'ga4' }, ctx.beznyCookie)).status, 403);
  });
});
