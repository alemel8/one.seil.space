// Sekce Marketing: přehled, ruční náklady, synchronizace a přístupová matice
// (src/routes/marketing.js, src/marketing/prehled.js).
//
// Čísla v přehledu se počítají z objednávek a nákladů konkrétního e-shopu —
// test si založí vlastní e-shop s objednávkami (zaplacená kartou s gclid,
// stornovaná, čekající na platbu bez atribuce), řádkem statistik Skliku
// a ručním nákladem Heureky a kontroluje tržby bez DPH, PNO, kanály a marži
// přímo v HTML. Mazání ručního nákladu cizího e-shopu nesmí projít,
// nesprávce bez práva v matici dostane 403.
//
// Jede proti běžícímu serveru a testovací databázi; přihlášení obchází
// vložením session. Po sobě uklidí.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   node --test test/marketing-route.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { prazskyCas, pridejDny } from '../src/prazsky-cas.js';

const BASE   = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.SESSION_SECRET || 'one-seil-space-secret-change-in-production-32chars';
const DATABASE_URL = process.env.DATABASE_URL || '';
const r = crypto.randomBytes(4).toString('hex');

function lokalniDatabaze() {
  const host = DATABASE_URL ? new URL(DATABASE_URL).hostname : '';
  if (!['127.0.0.1', 'localhost'].includes(host) && process.env.TEST_DB_ALLOW_REMOTE !== '1') {
    throw new Error(`Test zakládá e-shopy a objednávky — DATABASE_URL musí mířit na 127.0.0.1/localhost, ne na "${host}"`);
  }
  return DATABASE_URL;
}

let sql;
const uklid = { shops: [], users: [], sids: [], orders: [] };
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
// Čísla v HTML mají české oddělovače tisíců jako U+00A0 — pro porovnání se sjednotí na mezeru.
const text = async (res) => (await res.text()).replace(/\u00a0/g, ' ');
const post = (p, body = {}, cookie = ctx.cookie) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});

async function zalozObjednavku(over) {
  const id = `mkt-${r}-${crypto.randomBytes(3).toString('hex')}`;
  uklid.orders.push(id);
  const o = {
    status: 'Přijata', payment_method: 'Bankovní převod', total_price: 0, created_at: ctx.uprostred,
    utm_source_last: '', utm_medium_last: '', click_id_kind_last: '', referrer_host_last: '', touch_last_at: null,
    ...over,
  };
  await sql`
    INSERT INTO shop_orders (id, shop_id, order_number, status, payment_method, total_price, created_at, email,
                             utm_source_last, utm_medium_last, click_id_kind_last, referrer_host_last, touch_last_at, attribution_consent)
    VALUES (${id}, ${ctx.shop.id}, ${id}, ${o.status}, ${o.payment_method}, ${o.total_price}, ${o.created_at}, ${`o-${r}@example.invalid`},
            ${o.utm_source_last}, ${o.utm_medium_last}, ${o.click_id_kind_last}, ${o.referrer_host_last}, ${o.touch_last_at}, ${o.touch_last_at ? 'marketing' : ''})`;
  for (const p of over.items ?? []) {
    await sql`
      INSERT INTO shop_order_items (order_id, sku, name, quantity, price, cost_price, cost_price_vat_included)
      VALUES (${id}, ${p.sku}, ${p.name}, ${p.quantity}, ${p.price}, ${p.cost_price ?? null}, ${p.cost_price == null ? null : false})`;
  }
  return id;
}

describe('sekce Marketing', { skip: !DATABASE_URL && 'bez DATABASE_URL' }, () => {
  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 3, onnotice: () => {} });
    const health = await fetch(BASE + '/health').catch(() => null);
    assert.ok(health?.ok, `server neběží na ${BASE}`);

    const [u] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`mkt-${r}@example.invalid`}, 'x', 'Test', 'Marketér', TRUE) RETURNING id`;
    uklid.users.push(u.id);
    ctx.userId = u.id;
    ctx.cookie = await prihlas(u.id);

    const [bezny] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`mkt-bezny-${r}@example.invalid`}, 'x', 'Test', 'Sklad', FALSE) RETURNING id`;
    uklid.users.push(bezny.id);
    ctx.beznyId = bezny.id;
    ctx.beznyCookie = await prihlas(bezny.id);

    const [shop] = await sql`
      INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address, marketing_margin_pct)
      VALUES (${`test-mkt-${r}`}, ${`Marketing test ${r}`}, 'https://example.invalid', TRUE,
              'Test', 'noreply@example.invalid', 0)
      RETURNING *`;
    uklid.shops.push(shop.id);
    ctx.shop = shop;

    // Období: posledních 10 dní včetně dneška; objednávky uprostřed, ať je
    // pražský den jistě v okně a test nezávisí na hodině spuštění.
    ctx.dnes = prazskyCas().datum;
    ctx.od = pridejDny(ctx.dnes, -10);
    ctx.uprostred = new Date(`${pridejDny(ctx.dnes, -5)}T10:00:00Z`);
    ctx.vcera = pridejDny(ctx.dnes, -1);

    ctx.o1 = await zalozObjednavku({
      status: 'Zaplaceno', payment_method: 'Platba kartou', total_price: 1210,
      utm_source_last: 'google', utm_medium_last: 'cpc', click_id_kind_last: 'gclid', touch_last_at: ctx.uprostred,
      items: [
        { sku: 'T-1', name: 'Toner', quantity: 1, price: 1165, cost_price: 500 },
        { sku: 'DOPRAVA', name: 'Doprava', quantity: 1, price: 45 },
      ],
    });
    ctx.o2 = await zalozObjednavku({ status: 'Stornována', total_price: 5000 });
    ctx.o3 = await zalozObjednavku({ status: 'Přijata', total_price: 605 });

    await sql`
      INSERT INTO marketing_daily_stats (shop_id, platform, date, segment_kind, segment, cost, clicks, conversions, conversion_value)
      VALUES (${shop.id}, 'sklik', ${ctx.vcera}, '', '', 100, 40, 1, 1000)`;
    await sql`
      INSERT INTO marketing_manual_costs (shop_id, platform, date_from, date_to, amount, note, created_by)
      VALUES (${shop.id}, 'heureka', ${ctx.od}, ${ctx.dnes}, 62, 'kredit test', ${u.id})`;
  });

  after(async () => {
    if (!sql) return;
    const shops = uklid.shops.length ? uklid.shops : [0];
    await sql`DELETE FROM shop_orders WHERE shop_id = ANY(${shops})`;
    await sql`DELETE FROM marketing_daily_stats WHERE shop_id = ANY(${shops})`;
    await sql`DELETE FROM marketing_manual_costs WHERE shop_id = ANY(${shops})`;
    await sql`DELETE FROM marketing_sources WHERE shop_id = ANY(${shops})`;
    await sql`DELETE FROM shops WHERE id = ANY(${shops})`;
    if (uklid.users.length) await sql`DELETE FROM user_access WHERE user_id = ANY(${uklid.users})`;
    if (uklid.sids.length)  await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
    if (uklid.users.length) await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
    await sql.end();
  });

  const cestaPrehledu = () => `/marketing?eshop=${encodeURIComponent(ctx.shop.slug)}&obdobi=vlastni&od=${ctx.od}&do=${ctx.dnes}`;

  test('nepřihlášený jde na přihlášení', async () => {
    const res = await fetch(BASE + '/marketing', { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/prihlasit');
  });

  test('přehled: tržby bez DPH bez storna, PNO z API i ručních nákladů, kanály a marže', async () => {
    const res = await get(cestaPrehledu());
    assert.equal(res.status, 200);
    const html = await text(res);
    assert.ok(html.includes(ctx.shop.name), 'přepínač/nadpis nese e-shop');
    // (1210 + 605) / 1,21 = 1 500,00 — stornovaná za 5 000 se nepočítá
    assert.ok(html.includes('1 500,00 Kč'), 'tržby bez DPH');
    assert.ok(!html.includes('5 000,00'), 'storno nepatří do tržeb');
    // náklady 100 (Sklik z API) + 62 (Heureka ručně, celé období) = 162 → PNO 10,8 %
    assert.ok(html.includes('162,00 Kč'), 'náklady celkem');
    assert.ok(html.includes('10,8 %'), 'PNO');
    // kanály: Google Ads (gclid) 1 objednávka, Sklik má náklad bez objednávky, neznámý 1
    assert.ok(/Google Ads<\/td>\s*<td[^>]*>1</.test(html), 'Google Ads s jednou objednávkou');
    assert.ok(/Neznámý \(bez atribuce\)<\/td>\s*<td[^>]*>1</.test(html), 'objednávka bez atribuce');
    assert.ok(html.includes('zdroj objednávky zná 50 %'), 'pokrytí atribuce');
    // marže ze známé nákupní ceny: 1165/1,21 − 500 = 462,81 (DOPRAVA se přeskočí)
    assert.ok(html.includes('462,81 Kč'), 'marže ze známé nákupní ceny');
    // zaplaceno jen karta se stavem Zaplaceno: 1210/1,21 = 1 000,00
    assert.ok(html.includes('zaplaceno 1 000,00 Kč'), 'z toho zaplaceno');
    assert.ok(html.includes('Heureka'), 'ruční náklad v tabulce platforem');
    assert.ok(html.includes('id="marketing-data"'), 'data pro graf');
  });

  test('přehled bez dat ukazuje pomlčky a varování o nenastavených platformách', async () => {
    const res = await get(`/marketing?eshop=${encodeURIComponent(ctx.shop.slug)}&obdobi=vlastni&od=2020-01-01&do=2020-01-31`);
    assert.equal(res.status, 200);
    const html = await text(res);
    assert.ok(html.includes('Žádná platforma není napojená'));
    assert.ok(html.includes('nejsou objednávky ani náklady'));
  });

  test('neplatné vlastní období spadne na tento měsíc s vysvětlením', async () => {
    const html = await (await get(`/marketing?eshop=${encodeURIComponent(ctx.shop.slug)}&obdobi=vlastni&od=2026-13-01&do=x`)).text();
    assert.ok(html.includes('vlastní období se nepoužilo'));
  });

  test('ruční náklady: založit, odmítnout špatné období, smazat jen vlastní e-shop', async () => {
    const seznam = await get(`/marketing/naklady?eshop=${encodeURIComponent(ctx.shop.slug)}`);
    assert.equal(seznam.status, 200);
    assert.ok((await seznam.text()).includes('kredit test'));

    let res = await post('/marketing/naklady/vytvorit', { eshop: ctx.shop.slug, platform: 'meta', date_from: ctx.od, date_to: ctx.dnes, amount: '250,5', note: 'test meta' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/marketing/naklady?eshop=${encodeURIComponent(ctx.shop.slug)}&saved=1`);
    const [n] = await sql`SELECT * FROM marketing_manual_costs WHERE shop_id = ${ctx.shop.id} AND platform = 'meta'`;
    assert.ok(n, 'náklad uložený');
    assert.equal(Number(n.amount), 250.5);
    assert.equal(n.created_by, ctx.userId);

    res = await post('/marketing/naklady/vytvorit', { eshop: ctx.shop.slug, platform: 'meta', date_from: ctx.dnes, date_to: ctx.od, amount: '10' });
    assert.match(res.headers.get('location'), /error=obdobi/);
    res = await post('/marketing/naklady/vytvorit', { eshop: ctx.shop.slug, platform: 'meta', date_from: ctx.od, date_to: ctx.dnes, amount: '-5' });
    assert.match(res.headers.get('location'), /error=castka/);
    res = await post('/marketing/naklady/vytvorit', { eshop: ctx.shop.slug, platform: 'tiktok', date_from: ctx.od, date_to: ctx.dnes, amount: '5' });
    assert.match(res.headers.get('location'), /error=platforma/);

    // Smazání přes cizí e-shop (Toneráček) náklad nechá
    res = await post(`/marketing/naklady/${n.id}/smazat`, { eshop: 'toneracek' });
    assert.equal(res.status, 302);
    assert.ok((await sql`SELECT 1 FROM marketing_manual_costs WHERE id = ${n.id}`).length, 'cizí e-shop nesmaže');
    res = await post(`/marketing/naklady/${n.id}/smazat`, { eshop: ctx.shop.slug });
    assert.equal(res.status, 302);
    assert.equal((await sql`SELECT 1 FROM marketing_manual_costs WHERE id = ${n.id}`).length, 0, 'vlastní e-shop smaže');
  });

  test('synchronizace: stránka se vykreslí, ruční běh jen správce', async () => {
    const res = await get(`/marketing/sync?eshop=${encodeURIComponent(ctx.shop.slug)}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Napojené platformy'));
    assert.ok(html.includes('Poslední běhy'));

    const bezny = await post('/marketing/sync/spustit', { eshop: ctx.shop.slug, platform: 'vse' }, ctx.beznyCookie);
    assert.equal(bezny.status, 403);
    const admin = await post('/marketing/sync/spustit', { eshop: ctx.shop.slug, platform: 'vse' });
    assert.equal(admin.status, 302, 'správce dostane přesměrování (sync nasazený, nebo hlášku, že není)');
    assert.match(admin.headers.get('location'), /^\/marketing\/sync\?eshop=/);
  });

  test('přístupová matice: odebrané právo dá 403, bez záznamu vidí', async () => {
    assert.equal((await get('/marketing', ctx.beznyCookie)).status, 200);
    await sql`INSERT INTO user_access (user_id, access_key, allowed) VALUES (${ctx.beznyId}, 'marketing.prehled', FALSE)`;
    assert.equal((await get('/marketing', ctx.beznyCookie)).status, 403);
    assert.equal((await get('/marketing/naklady', ctx.beznyCookie)).status, 200, 'jiná položka sekce zůstává');
  });
});
