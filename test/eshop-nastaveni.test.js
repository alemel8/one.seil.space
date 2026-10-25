// Nastavení e-shopu: klíče pro /api/eshop a tajemství pro podání balíku.
//
// Klíč se ukáže jednou přímo v odpovědi (ne v URL, kde by skončil v logu)
// a v databázi zůstane jen jeho SHA-256 otisk. Toneráčku se klíč pro
// /api/eshop nevydává — má vlastní API a účty v crm_contacts. Starší klíče
// pro /api/v1 fungují jako dřív.
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

    const detail = await (await get(`/nastaveni/eshopy/${ctx.shop.id}`)).text();
    assert.ok(detail.includes(hash.slice(0, 8)), 'detail ukazuje otisk');
    assert.ok(!detail.includes(klic), 'detail klíč neukazuje');

    const zrus = await post(`/nastaveni/eshopy/${ctx.shop.id}/eshop-klic/${k.id}/zrusit`);
    assert.equal(zrus.status, 302);
    const po = await fetch(`${BASE}/api/eshop/orders?email=x@example.invalid`, { headers: { authorization: `Bearer ${klic}` } });
    assert.equal(po.status, 401);
  });

  test('Toneráčku se klíč pro /api/eshop nevydá', async () => {
    const res = await post(`/nastaveni/eshopy/${ctx.toneracek.id}/eshop-klic/vytvorit`, { label: 'nesmí' });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${ctx.toneracek.id}?error=eshop-klic-toneracek`);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM eshop_api_keys WHERE shop_id = ${ctx.toneracek.id}`;
    assert.equal(n, 0);

    const detail = await get(`/nastaveni/eshopy/${ctx.toneracek.id}?error=eshop-klic-toneracek`);
    assert.equal(detail.status, 200);
    const html = await detail.text();
    assert.ok(html.includes('klíč pro <code>/api/eshop</code> se mu nevydává'), 'vysvětlení místo formuláře');
    assert.ok(!html.includes(`/nastaveni/eshopy/${ctx.toneracek.id}/eshop-klic/vytvorit`), 'bez formuláře na klíč');
    assert.ok(html.includes(`/nastaveni/eshopy/${ctx.toneracek.id}/webhook-secret`), 'tajemství jde nastavit i Toneráčku');
  });

  test('tajemství pro podání balíku: vygenerovat, odmítnout krátké, vrátit na globální', async () => {
    const res = await post(`/nastaveni/eshopy/${ctx.shop.id}/webhook-secret`, { akce: 'vygenerovat' });
    assert.equal(res.status, 200);
    const secret = (await res.text()).match(/<code[^>]*>([0-9a-f]{64})<\/code>/)?.[1];
    assert.ok(secret);
    let [s] = await sql`SELECT webhook_secret FROM shops WHERE id = ${ctx.shop.id}`;
    assert.equal(s.webhook_secret, secret);

    const kratke = await post(`/nastaveni/eshopy/${ctx.shop.id}/webhook-secret`, { akce: 'nastavit', webhook_secret: 'kratke' });
    assert.equal(kratke.headers.get('location'), `/nastaveni/eshopy/${ctx.shop.id}?error=webhook-secret`);
    [s] = await sql`SELECT webhook_secret FROM shops WHERE id = ${ctx.shop.id}`;
    assert.equal(s.webhook_secret, secret, 'krátké tajemství se neuloží');

    const vlastni = 'v'.repeat(40);
    await post(`/nastaveni/eshopy/${ctx.shop.id}/webhook-secret`, { akce: 'nastavit', webhook_secret: vlastni });
    [s] = await sql`SELECT webhook_secret FROM shops WHERE id = ${ctx.shop.id}`;
    assert.equal(s.webhook_secret, vlastni);
    const detail = await (await get(`/nastaveni/eshopy/${ctx.shop.id}`)).text();
    assert.ok(!detail.includes(vlastni), 'tajemství se v administraci neukazuje');

    await post(`/nastaveni/eshopy/${ctx.shop.id}/webhook-secret`, { akce: 'vymazat' });
    [s] = await sql`SELECT webhook_secret FROM shops WHERE id = ${ctx.shop.id}`;
    assert.equal(s.webhook_secret, '');
  });

  test('starší API klíče (/api/v1) fungují jako dřív', async () => {
    const res = await post('/nastaveni/eshopy/api-klic/vytvorit', { shop_id: String(ctx.shop.id) });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/nastaveni\/eshopy\?saved=1&newKey=[0-9a-f]{64}$/);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM api_keys WHERE shop_id = ${ctx.shop.id}`;
    assert.equal(n, 1);
  });
});
