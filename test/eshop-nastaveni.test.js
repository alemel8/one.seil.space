// Nastavení e-shopu: klíče pro /api/eshop a tajemství pro podání balíku.
//
// Klíč se ukáže jednou přímo v odpovědi (ne v URL, kde by skončil v logu)
// a v databázi zůstane jen jeho SHA-256 otisk. Toneráčku se klíč pro
// /api/eshop nevydává — má vlastní API a účty v crm_contacts — a ani
// tajemství pro balíky: jede na SHOP_WEBHOOK_SECRET z prostředí. Starší
// klíče z api_keys a /api/v1 jsou od 26. 10. 2026 pryč — klíče se vydávají
// jen tady.
//
// Jede proti běžícímu serveru a testovací databázi; přihlášení obchází
// vložením session. Zakládá si vlastní e-shop a správce a po sobě je uklidí.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   node --test test/eshop-nastaveni.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';

const BASE   = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.SESSION_SECRET || 'one-seil-space-secret-change-in-production-32chars';
const r = crypto.randomBytes(4).toString('hex');

function lokalniDatabaze() {
  const url = process.env.DATABASE_URL || '';
  const host = url ? new URL(url).hostname : '';
  if (!['127.0.0.1', 'localhost'].includes(host) && process.env.TEST_DB_ALLOW_REMOTE !== '1') {
    throw new Error(`Test zakládá e-shopy a klíče — DATABASE_URL musí mířit na 127.0.0.1/localhost, ne na "${host}"`);
  }
  return url;
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
      ${new Date(Date.now() + 3600_000)})
  `;
  return `sessionId=${sid}.${sig}`;
}

const get  = (p) => fetch(BASE + p, { headers: { cookie: ctx.cookie }, redirect: 'manual' });
const post = (p, body = {}) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { cookie: ctx.cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});

before(async () => {
  sql = postgres(lokalniDatabaze(), { max: 3, onnotice: () => {} });
  const health = await fetch(BASE + '/health').catch(() => null);
  assert.ok(health?.ok, `server neběží na ${BASE}`);

  const [u] = await sql`
    INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
    VALUES (${`nast-${r}@example.invalid`}, 'x', 'Test', 'Správce', TRUE) RETURNING id`;
  uklid.users.push(u.id);
  ctx.userId = u.id;
  ctx.cookie = await prihlas(u.id);

  const [bezny] = await sql`
    INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
    VALUES (${`nast-bezny-${r}@example.invalid`}, 'x', 'Test', 'Běžný', FALSE) RETURNING id`;
  uklid.users.push(bezny.id);
  ctx.beznyCookie = await prihlas(bezny.id);

  const [shop] = await sql`
    INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address)
    VALUES (${`test-nast-${r}`}, ${`Dílna nastavení ${r}`}, 'https://example.invalid', TRUE,
            'Dílna test', 'noreply@example.invalid')
    RETURNING *`;
  uklid.shops.push(shop.id);
  ctx.shop = shop;
  [ctx.toneracek] = await sql`SELECT * FROM shops WHERE slug = 'toneracek'`;
  assert.ok(ctx.toneracek, 'migrace 030 zakládá e-shop toneracek');
});

after(async () => {
  if (!sql) return;
  const shops = uklid.shops.length ? uklid.shops : [0];
  await sql`DELETE FROM api_keys WHERE shop_id = ANY(${shops})`;
  await sql`DELETE FROM shops WHERE id = ANY(${shops})`;
  if (uklid.sids.length)  await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
  if (uklid.users.length) await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
  await sql.end();
});

// ── Nastavení e-shopu ──────────────────────────────────────────

describe('nastavení: klíče pro /api/eshop a tajemství pro balíky', () => {
  test('klíč se ukáže jednou, v databázi je jen otisk a hned funguje', async () => {
    const res = await post(`/nastaveni/eshopy/${ctx.shop.id}/eshop-klic/vytvorit`, { label: 'test admin' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    const klic = html.match(/<code[^>]*>([0-9a-f]{64})<\/code>/)?.[1];
    assert.ok(klic, 'nový klíč je v odpovědi');
    const hash = crypto.createHash('sha256').update(klic).digest('hex');
    const [k] = await sql`SELECT * FROM eshop_api_keys WHERE shop_id = ${ctx.shop.id} AND key_hash = ${hash}`;
    assert.ok(k, 'otisk je uložený');
    assert.equal(k.label, 'test admin');
    assert.equal(k.created_by, ctx.userId);
    const vse = JSON.stringify(await sql`SELECT * FROM eshop_api_keys WHERE shop_id = ${ctx.shop.id}`);
    assert.ok(!vse.includes(klic), 'klíč sám v databázi není');

    const api = await fetch(`${BASE}/api/eshop/orders?email=x@example.invalid`, { headers: { authorization: `Bearer ${klic}` } });
    assert.equal(api.status, 200);

    const detail = await (await get(`/nastaveni/eshopy/${ctx.shop.id}?tab=napojeni`)).text();
    assert.ok(detail.includes(hash.slice(0, 8)), 'detail ukazuje otisk');
    assert.ok(!detail.includes(klic), 'detail klíč neukazuje');

    const zrus = await post(`/nastaveni/eshopy/${ctx.shop.id}/eshop-klic/${k.id}/zrusit`);
    assert.equal(zrus.status, 302);
    assert.equal(zrus.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?tab=napojeni&saved=1`, 'vrátí na záložku Napojení');
    const po = await fetch(`${BASE}/api/eshop/orders?email=x@example.invalid`, { headers: { authorization: `Bearer ${klic}` } });
    assert.equal(po.status, 401);
  });

  test('Toneráčku se klíč pro /api/eshop nevydá', async () => {
    const res = await post(`/nastaveni/eshopy/${ctx.toneracek.id}/eshop-klic/vytvorit`, { label: 'nesmí' });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.toneracek.id}?tab=napojeni&error=eshop-klic-toneracek`);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM eshop_api_keys WHERE shop_id = ${ctx.toneracek.id}`;
    assert.equal(n, 0);

    const detail = await get(`/nastaveni/eshopy/${ctx.toneracek.id}?tab=napojeni&error=eshop-klic-toneracek`);
    assert.equal(detail.status, 200);
    const html = await detail.text();
    assert.ok(html.includes('klíč pro <code>/api/eshop</code> se mu nevydává'), 'vysvětlení místo formuláře');
    assert.ok(!html.includes(`/nastaveni/eshopy/${ctx.toneracek.id}/eshop-klic/vytvorit`), 'bez formuláře na klíč');
    assert.ok(!html.includes(`/nastaveni/eshopy/${ctx.toneracek.id}/webhook-secret`), 'bez formuláře na tajemství');
    assert.ok(html.includes('proměnnou <code>SHOP_WEBHOOK_SECRET</code>'), 'vysvětlení, odkud Toneráček bere tajemství');
  });

  test('Toneráčku nejde tajemství pro balíky vygenerovat, nastavit ani smazat', async () => {
    const vlastni = 'n'.repeat(40);
    for (const telo of [{ akce: 'vygenerovat' }, { akce: 'nastavit', webhook_secret: vlastni }, { akce: 'vymazat' }]) {
      const res = await post(`/nastaveni/eshopy/${ctx.toneracek.id}/webhook-secret`, telo);
      assert.equal(res.status, 302, telo.akce);
      assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.toneracek.id}?tab=napojeni&error=webhook-secret-toneracek`);
    }
    // Ne „před = po“: test expedice si sloupec Toneráčku souběžně na chvíli
    // nastavuje, aby ověřil, že ho podání balíku ignoruje.
    const [po] = await sql`SELECT webhook_secret FROM shops WHERE id = ${ctx.toneracek.id}`;
    assert.notEqual(po.webhook_secret, vlastni, 'vlastní tajemství se neuložilo');
    assert.doesNotMatch(po.webhook_secret, /^[0-9a-f]{64}$/, 'vygenerované tajemství se neuložilo');

    const html = await (await get(`/nastaveni/eshopy/${ctx.toneracek.id}?tab=napojeni&error=webhook-secret-toneracek`)).text();
    assert.ok(html.includes('vlastní tajemství se mu tady nenastavuje'));
  });

  test('tajemství pro podání balíku: vygenerovat, odmítnout krátké, smazat', async () => {
    const bez = await (await get(`/nastaveni/eshopy/${ctx.shop.id}?tab=napojeni`)).text();
    assert.ok(bez.includes('Chybí tajemství — balíky se u převodu nepodají'), 'e-shop bez tajemství vidí varování');
    assert.ok(!bez.includes('Použít globální'), 'globální tajemství (Toneráčku) se jinému e-shopu nenabízí');

    const res = await post(`/nastaveni/eshopy/${ctx.shop.id}/webhook-secret`, { akce: 'vygenerovat' });
    assert.equal(res.status, 200);
    const secret = (await res.text()).match(/<code[^>]*>([0-9a-f]{64})<\/code>/)?.[1];
    assert.ok(secret);
    let [s] = await sql`SELECT webhook_secret FROM shops WHERE id = ${ctx.shop.id}`;
    assert.equal(s.webhook_secret, secret);

    const kratke = await post(`/nastaveni/eshopy/${ctx.shop.id}/webhook-secret`, { akce: 'nastavit', webhook_secret: 'kratke' });
    assert.equal(kratke.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?tab=napojeni&error=webhook-secret`);
    [s] = await sql`SELECT webhook_secret FROM shops WHERE id = ${ctx.shop.id}`;
    assert.equal(s.webhook_secret, secret, 'krátké tajemství se neuloží');

    const vlastni = 'v'.repeat(40);
    await post(`/nastaveni/eshopy/${ctx.shop.id}/webhook-secret`, { akce: 'nastavit', webhook_secret: vlastni });
    [s] = await sql`SELECT webhook_secret FROM shops WHERE id = ${ctx.shop.id}`;
    assert.equal(s.webhook_secret, vlastni);
    const detail = await (await get(`/nastaveni/eshopy/${ctx.shop.id}?tab=napojeni`)).text();
    assert.ok(!detail.includes(vlastni), 'tajemství se v administraci neukazuje');
    assert.ok(detail.includes(crypto.createHash('sha256').update(vlastni).digest('hex').slice(0, 8)), 'jen otisk');
    assert.ok(!detail.includes('Chybí tajemství'));

    await post(`/nastaveni/eshopy/${ctx.shop.id}/webhook-secret`, { akce: 'vymazat' });
    [s] = await sql`SELECT webhook_secret FROM shops WHERE id = ${ctx.shop.id}`;
    assert.equal(s.webhook_secret, '');
  });

  test('starší API klíče a /api/v1 jsou pryč — klíč se vydává jen v detailu e-shopu', async () => {
    // Vydání i deaktivace starého klíče už neexistují a nic nezaloží.
    assert.equal((await post('/nastaveni/eshopy/api-klic/vytvorit', { shop_id: String(ctx.shop.id) })).status, 404);
    assert.equal((await post('/nastaveni/eshopy/api-klic/1/deaktivovat')).status, 404);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM api_keys WHERE shop_id = ${ctx.shop.id}`;
    assert.equal(n, 0);

    // Ani platný starý klíč neotevře /api/v1 (dřív četlo a měnilo všechny kontakty v CRM).
    const stary = crypto.randomBytes(32).toString('hex');
    await sql`INSERT INTO api_keys (key, shop_id, active) VALUES (${stary}, ${ctx.shop.id}, TRUE)`;
    for (const cesta of ['/api/v1/customers', '/api/v1/orders', '/api/docs']) {
      const res = await fetch(BASE + cesta, { headers: { 'x-api-key': stary }, redirect: 'manual' });
      assert.notEqual(res.status, 200, `${cesta} nesmí odpovědět 200`);
      assert.ok([302, 404].includes(res.status), `${cesta}: čekal jsem 404 nebo přesměrování na přihlášení, ne ${res.status}`);
    }

    // Přehled i detail nabízí jen nový způsob.
    const prehled = await (await get('/nastaveni/eshopy')).text();
    assert.ok(!prehled.includes('api-klic'), 'přehled bez starých klíčů');
    assert.ok(!prehled.includes('+ Nový klíč'));
    const detail = await (await get(`/nastaveni/eshopy/${ctx.shop.id}?tab=napojeni`)).text();
    assert.ok(!detail.includes('api-klic') && !detail.includes('/api/v1'), 'detail bez starých klíčů');
    assert.ok(detail.includes(`/nastaveni/eshopy/${ctx.shop.id}/eshop-klic/vytvorit`), 'detail vydává klíč pro /api/eshop');
  });
});

// ── Detail e-shopu po záložkách ────────────────────────────────

describe('detail e-shopu po záložkách', () => {
  const detail = async (q = '') => {
    const res = await get(`/nastaveni/eshopy/${ctx.shop.id}${q}`);
    assert.equal(res.status, 200, q);
    return res.text();
  };

  test('bez ?tab= i s neznámým klíčem se otevřou Základní informace', async () => {
    for (const q of ['', '?tab=nesmysl', '?tab=identita&tab=zakladni']) {
      const html = await detail(q);
      assert.ok(html.includes(`action="/nastaveni/eshopy/${ctx.shop.id}/zakladni"`), `${q}: formulář základních informací`);
      assert.ok(/class="tab active" aria-current="page">Základní informace</.test(html), `${q}: aktivní záložka`);
      assert.ok(html.includes('name="active" value="1" class="toggle-input" checked'), `${q}: přepínač je předvyplněný stavem e-shopu`);
      assert.ok(!html.includes(`/nastaveni/eshopy/${ctx.shop.id}/identita"`), `${q}: identita je na jiné záložce`);
    }
  });

  test('každá záložka ukazuje svůj obsah a vrací na sebe', async () => {
    const markery = {
      identita:     'name="email_from_name"',
      napojeni:     `/nastaveni/eshopy/${ctx.shop.id}/eshop-klic/vytvorit`,
      expedice:     'name="warehouse_email"',
      marketing:    'name="marketing_margin_pct"',
      healthchecky: 'id="modalAddCheck"',
    };
    for (const [tab, marker] of Object.entries(markery)) {
      const html = await detail(`?tab=${tab}`);
      assert.ok(html.includes(marker), `${tab} má svůj obsah`);
      assert.ok(html.includes('class="tab active" aria-current="page">'), `${tab} má aktivní záložku`);
      assert.ok(!html.includes(`action="/nastaveni/eshopy/${ctx.shop.id}/zakladni"`), `${tab} nemá formulář základních informací`);
    }
    const health = await detail('?tab=healthchecky');
    assert.ok(health.includes(`value="/nastaveni/eshopy/${ctx.shop.id}?tab=healthchecky"`), 'healthchecky se vrací na svou záložku');
  });

  test('Základní informace: název, URL a stav se uloží, slug zůstane', async () => {
    let res = await post(`/nastaveni/eshopy/${ctx.shop.id}/zakladni`, { name: `Nový název ${r}`, url: 'https://novy.example.invalid', slug: 'podvrzeny' });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?tab=zakladni&saved=1`);
    let [s] = await sql`SELECT name, url, active, slug FROM shops WHERE id = ${ctx.shop.id}`;
    assert.equal(s.name, `Nový název ${r}`);
    assert.equal(s.url, 'https://novy.example.invalid');
    assert.equal(s.active, false, 'bez pole active je e-shop vypnutý');
    assert.equal(s.slug, ctx.shop.slug, 'slug se podvrženým polem nemění');

    res = await post(`/nastaveni/eshopy/${ctx.shop.id}/zakladni`, { name: ctx.shop.name, url: ctx.shop.url, active: '1' });
    assert.equal(res.status, 302);
    [s] = await sql`SELECT name, url, active FROM shops WHERE id = ${ctx.shop.id}`;
    assert.deepEqual([s.name, s.url, s.active], [ctx.shop.name, ctx.shop.url, true]);

    res = await post(`/nastaveni/eshopy/${ctx.shop.id}/zakladni`, { name: '   ', active: '1' });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?tab=zakladni&error=zakladni-nazev`);
    for (const url of ['example.invalid', 'ftp://example.invalid', 'https://a b']) {
      res = await post(`/nastaveni/eshopy/${ctx.shop.id}/zakladni`, { name: 'x', url, active: '1' });
      assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?tab=zakladni&error=zakladni-url`, url);
    }
    [s] = await sql`SELECT name, url, active FROM shops WHERE id = ${ctx.shop.id}`;
    assert.deepEqual([s.name, s.url, s.active], [ctx.shop.name, ctx.shop.url, true], 'neplatná data nic nezapsala');
  });

  test('Toneráček zůstane aktivní, i když formulář active nepošle', async () => {
    const [pred] = await sql`SELECT name, url, active FROM shops WHERE id = ${ctx.toneracek.id}`;
    const res = await post(`/nastaveni/eshopy/${ctx.toneracek.id}/zakladni`, { name: pred.name, url: pred.url });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.toneracek.id}?tab=zakladni&saved=1`);
    const [po] = await sql`SELECT active FROM shops WHERE id = ${ctx.toneracek.id}`;
    assert.equal(po.active, pred.active);
    const html = await (await get(`/nastaveni/eshopy/${ctx.toneracek.id}?tab=zakladni`)).text();
    assert.ok(/name="active"[^>]*disabled/.test(html), 'přepínač Toneráčku je zašedlý');
  });

  test('nesprávce základní informace neuloží', async () => {
    const res = await fetch(`${BASE}/nastaveni/eshopy/${ctx.shop.id}/zakladni`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: ctx.beznyCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'x', active: '1' }),
    });
    assert.equal(res.status, 403);
  });
});
