// Administrace objednávek pro víc e-shopů.
//
// Seznam objednávek je po e-shopech (?eshop=<slug>, bez parametru Toneráček
// jako dřív). Detail a akce nad objednávkou berou e-shop z objednávky, takže
// odkazy /ucetnictvi/objednavky/:id fungují pro každý e-shop.
//
// Jede proti běžícímu serveru a testovací databázi; přihlášení obchází
// vložením session (jako test/invoices.test.js). Zakládá si vlastní e-shop,
// objednávky a správce a po sobě je uklidí. Žádný e-mail ani balík neodejde:
// adresy jsou v .invalid a objednávky k vyřízení mají sledovací číslo.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   node --test test/eshop-admin.test.js

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
    throw new Error(`Test zakládá e-shopy a objednávky — DATABASE_URL musí mířit na 127.0.0.1/localhost, ne na "${host}"`);
  }
  return url;
}

let sql;
const uklid = { shops: [], orders: [], users: [], sids: [] };
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

async function objednavka(shopId, cislo, over = {}) {
  const id = `TEST-ADM-${r}-${cislo}`;
  const o = {
    status: 'Přijata', payment_method: 'Platba kartou', tracking_number: '', paid_at: null,
    email: `adm-${cislo}-${r}@example.invalid`, ...over,
  };
  await sql`
    INSERT INTO shop_orders (id, shop_id, order_number, status, payment_method, email,
                             first_name, last_name, total_price, tracking_number, paid_at)
    VALUES (${id}, ${shopId}, ${cislo}, ${o.status}, ${o.payment_method}, ${o.email},
            'Test', 'Admin', 500, ${o.tracking_number}, ${o.paid_at})`;
  await sql`
    INSERT INTO shop_order_items (order_id, sku, name, quantity, price)
    VALUES (${id}, 'TEST-1', 'Testovací položka', 1, 500)`;
  uklid.orders.push(id);
  return id;
}

before(async () => {
  sql = postgres(lokalniDatabaze(), { max: 3, onnotice: () => {} });
  const health = await fetch(BASE + '/health').catch(() => null);
  assert.ok(health?.ok, `server neběží na ${BASE}`);

  const [u] = await sql`
    INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
    VALUES (${`adm-${r}@example.invalid`}, 'x', 'Test', 'Správce', TRUE) RETURNING id`;
  uklid.users.push(u.id);
  ctx.userId = u.id;
  ctx.cookie = await prihlas(u.id);

  const [shop] = await sql`
    INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address)
    VALUES (${`test-adm-${r}`}, ${`Dílna test ${r}`}, 'https://example.invalid', TRUE,
            'Dílna test', 'noreply@example.invalid')
    RETURNING *`;
  uklid.shops.push(shop.id);
  ctx.shop = shop;
  await sql`
    INSERT INTO invoice_number_series (name, prefix, format, current_number, start_number, padding, shop_id, entity_type, active)
    VALUES (${`FV adm ${r}`}, '', ${`FD${r}-NNNN`}, 0, 1, 4, ${shop.id}, 'faktura', TRUE)`;

  [ctx.toneracek] = await sql`SELECT * FROM shops WHERE slug = 'toneracek'`;
  assert.ok(ctx.toneracek, 'migrace 030 zakládá e-shop toneracek');

  // Čísla objednávek s náhodnou částí, ať se nepotkají s jinými testy.
  const n = parseInt(r.slice(0, 6), 16) % 900000 + 100000;
  ctx.cislo = { karta: `91${n}`, prevod: `92${n}`, storno: `93${n}`, sklad: `94${n}`, toneracek: `95${n}` };
  ctx.karta = await objednavka(shop.id, ctx.cislo.karta,
    { status: 'Zaplaceno', tracking_number: 'Z1234567890', paid_at: new Date('2026-10-20T10:00:00Z') });
  ctx.prevod = await objednavka(shop.id, ctx.cislo.prevod, { payment_method: 'Bankovní převod' });
  ctx.storno = await objednavka(shop.id, ctx.cislo.storno);
  ctx.sklad = await objednavka(shop.id, ctx.cislo.sklad);
  ctx.objToneracku = await objednavka(ctx.toneracek.id, ctx.cislo.toneracek);
});

after(async () => {
  if (!sql) return;
  const shops = uklid.shops.length ? uklid.shops : [0];
  const orders = uklid.orders.length ? uklid.orders : [''];
  await sql`DELETE FROM accounting_invoices WHERE order_id = ANY(${orders}) OR shop_id = ANY(${shops})`;
  await sql`DELETE FROM shop_orders WHERE id = ANY(${orders}) OR shop_id = ANY(${shops})`;
  await sql`DELETE FROM invoice_number_series WHERE shop_id = ANY(${shops})`;
  await sql`DELETE FROM shops WHERE id = ANY(${shops})`;
  if (uklid.sids.length)  await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
  if (uklid.users.length) await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
  await sql.end();
});

// ── Seznam objednávek ──────────────────────────────────────────

describe('seznam objednávek po e-shopech', () => {
  test('bez ?eshop= je to Toneráček s dosavadním nadpisem a adresami', async () => {
    const res = await get('/ucetnictvi/objednavky');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<h1>Objednávky Toneráček<\/h1>/);
    assert.match(html, /<title>[^<]*Objednávky Toneráček/);
    assert.ok(html.includes(`#${ctx.cislo.toneracek}`), 'objednávka Toneráčku je v seznamu');
    assert.ok(!html.includes(`#${ctx.cislo.karta}`), 'objednávka jiného e-shopu v seznamu Toneráčku není');
    assert.ok(html.includes('href="/ucetnictvi/objednavky?status='), 'chipy stavů beze změny');
    assert.ok(!html.includes('name="shop_id"'), 'expedice Toneráčku bez skrytého e-shopu');
    // Přepínač — v testovací databázi je e-shopů víc.
    assert.ok(html.includes(`href="/ucetnictvi/objednavky?eshop=${ctx.shop.slug}"`));
  });

  test('?eshop=<slug> ukáže jen objednávky toho e-shopu a parametr drží v odkazech', async () => {
    const res = await get(`/ucetnictvi/objednavky?eshop=${ctx.shop.slug}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(`<h1>Objednávky ${ctx.shop.name}</h1>`));
    for (const cislo of [ctx.cislo.karta, ctx.cislo.prevod, ctx.cislo.storno]) {
      assert.ok(html.includes(`#${cislo}`), `objednávka ${cislo} v seznamu`);
    }
    assert.ok(!html.includes(`#${ctx.cislo.toneracek}`));
    assert.ok(html.includes(`href="/ucetnictvi/objednavky?eshop=${ctx.shop.slug}&amp;status=`), 'chipy drží e-shop');
    assert.ok(html.includes(`<input type="hidden" name="shop_id" value="${ctx.shop.id}">`), 'ruční expedice ví, který e-shop');
    assert.ok(html.includes(`<input type="hidden" name="eshop" value="${ctx.shop.slug}">`), 'filtr drží e-shop');
  });

  test('neznámý e-shop je 404', async () => {
    assert.equal((await get('/ucetnictvi/objednavky?eshop=neexistuje-' + r)).status, 404);
  });
});

// ── Detail a akce podle e-shopu objednávky ─────────────────────

describe('detail a akce berou e-shop z objednávky', () => {
  test('detail objednávky jiného e-shopu se otevře i s označením e-shopu', async () => {
    const res = await get(`/ucetnictvi/objednavky/${ctx.karta}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(`Objednávka #${ctx.cislo.karta}`));
    assert.ok(html.includes(ctx.shop.name), 'značka e-shopu');
    assert.ok(html.includes(`href="/ucetnictvi/objednavky?eshop=${ctx.shop.slug}"`), 'zpět na seznam e-shopu');
  });

  test('detail objednávky Toneráčku je beze změny, neznámá objednávka 404', async () => {
    const res = await get(`/ucetnictvi/objednavky/${ctx.objToneracku}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(`Objednávka #${ctx.cislo.toneracek}`));
    assert.ok(html.includes('href="/ucetnictvi/objednavky" style'), 'zpět bez ?eshop=');
    assert.ok(!html.includes('Toneráček.cz</span>'), 'Toneráček bez štítku e-shopu');
    assert.equal((await get(`/ucetnictvi/objednavky/neexistuje-${r}`)).status, 404);
  });

  test('Vyřízena vystaví fakturu z řady e-shopu objednávky', async () => {
    const res = await post(`/ucetnictvi/objednavky/${ctx.karta}/stav`, { status: 'Vyřízena' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/ucetnictvi/objednavky/${ctx.karta}`);
    const [o] = await sql`SELECT status, invoice_number FROM shop_orders WHERE id = ${ctx.karta}`;
    assert.equal(o.status, 'Vyřízena');
    const [f] = await sql`SELECT * FROM accounting_invoices WHERE order_id = ${ctx.karta} AND type = 'issued'`;
    assert.ok(f, 'faktura vznikla');
    assert.equal(f.shop_id, ctx.shop.id);
    assert.equal(f.number, `FD${r}-0001`);
    assert.equal(o.invoice_number, f.number);
    assert.equal(f.status, 'Zaplacena');
  });

  test('převod bez zaplacené zálohovky Vyřízena nepustí', async () => {
    const res = await post(`/ucetnictvi/objednavky/${ctx.prevod}/stav`, { status: 'Vyřízena' });
    assert.equal(res.headers.get('location'), `/ucetnictvi/objednavky/${ctx.prevod}?error=proforma-nezaplacena`);
    const [o] = await sql`SELECT status FROM shop_orders WHERE id = ${ctx.prevod}`;
    assert.equal(o.status, 'Přijata');
  });

  test('storno projde i s e-mailem (adresa .invalid se neodešle)', async () => {
    const res = await post(`/ucetnictvi/objednavky/${ctx.storno}/stav`, { status: 'Stornována', send_email: 'on' });
    assert.equal(res.status, 302);
    const [o] = await sql`SELECT status FROM shop_orders WHERE id = ${ctx.storno}`;
    assert.equal(o.status, 'Stornována');
  });

  test('značka „sklad to má“ a poznámka u objednávky jiného e-shopu', async () => {
    assert.equal((await post(`/ucetnictvi/objednavky/${ctx.sklad}/sklad`, { akce: 'oznacit' })).status, 302);
    let [o] = await sql`SELECT warehouse_sent_at, warehouse_sent_by FROM shop_orders WHERE id = ${ctx.sklad}`;
    assert.ok(o.warehouse_sent_at);
    assert.equal(o.warehouse_sent_by, ctx.userId);
    await post(`/ucetnictvi/objednavky/${ctx.sklad}/sklad`, { akce: 'zrusit' });
    [o] = await sql`SELECT warehouse_sent_at FROM shop_orders WHERE id = ${ctx.sklad}`;
    assert.equal(o.warehouse_sent_at, null);

    await post(`/ucetnictvi/objednavky/${ctx.sklad}/poznamka`, { notes: 'testovací poznámka' });
    [o] = await sql`SELECT notes FROM shop_orders WHERE id = ${ctx.sklad}`;
    assert.equal(o.notes, 'testovací poznámka');
  });

  test('štítek: bez zásilky 404, se zásilkou jde na Packetu (bez hesla v testu 502)', async () => {
    assert.equal((await get(`/ucetnictvi/objednavky/${ctx.sklad}/stitek`)).status, 404);
    // PACKETA_API_PASSWORD test nemá — chyba vznikne dřív, než by šel požadavek ven.
    assert.equal((await get(`/ucetnictvi/objednavky/${ctx.karta}/stitek`)).status, 502);
  });

  test('ruční expedice jde na e-shop z formuláře, bez něj na Toneráček', async () => {
    const jiny = await post('/ucetnictvi/objednavky/expedice', { shop_id: String(ctx.shop.id) });
    assert.equal(jiny.headers.get('location'), `/ucetnictvi/objednavky?error=sklad-email&eshop=${ctx.shop.slug}`);
    if (!ctx.toneracek.warehouse_email) {
      const toneracek = await post('/ucetnictvi/objednavky/expedice', {});
      assert.equal(toneracek.headers.get('location'), '/ucetnictvi/objednavky?error=sklad-email');
    }
    assert.equal((await post('/ucetnictvi/objednavky/expedice', { shop_id: '999999' })).status, 404);
  });
});
