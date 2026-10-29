// API pro další e-shopy (/api/eshop/*) — klíč určuje e-shop, každý dotaz
// je omezený na jeho data a zákaznické účty jsou po e-shopech.
//
// Jede proti běžícímu serveru a testovací databázi; zakládá si vlastní
// e-shopy s náhodným slugem, klíči a číselnými řadami a po sobě je uklidí.
// Na Toneráček sahá jen přes jeho API a jen na data, která sám založí.
// Od migrace 042 hlídá i kontrakt zdroje objednávky a nákupní ceny
// (`marketing`, `items[].costPrice`, docs/api.md) pro /api/eshop i /api/toneracek.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   TONERACEK_API_KEY=<tentýž jako u serveru> node --test test/eshop-api.test.js
//
// Databáze musí být lokální (127.0.0.1/localhost) — test zakládá e-shopy,
// objednávky a doklady. Jinou jen s TEST_DB_ALLOW_REMOTE=1.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { SLOUPCE_ATRIBUCE } from '../src/atribuce-objednavky.js';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const TONERACEK_KEY = process.env.TONERACEK_API_KEY || '';
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
const uklid = { shops: [], orders: [], emails: [] };
const ctx = {};

const email = (jmeno) => {
  const e = `${jmeno}-${r}@example.invalid`;
  uklid.emails.push(e);
  return e;
};

async function call(key, method, path, body) {
  const headers = {};
  if (key !== null) headers.authorization = `Bearer ${key}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}

/**
 * E-shop s vyplněnou identitou, klíčem a třemi řadami. Doklady mají
 * v čísle písmeno podle pořadí založení (Alfa = A, Beta = B…) a náhodnou
 * část běhu — čísla dokladů jsou jedinečná napříč e-shopy.
 */
async function zalozEshop(nazev, cislice, { identita = true, aktivni = true } = {}) {
  const slug = `test-${nazev.toLowerCase()}-${r}`;
  const kod = String.fromCharCode(65 + uklid.shops.length);
  const [shop] = await sql`
    INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address, webhook_secret)
    VALUES (${slug}, ${`Test ${nazev} ${r}`}, 'https://example.invalid', ${aktivni},
            ${identita ? `Test ${nazev}` : ''}, ${identita ? 'noreply@example.invalid' : ''}, '')
    RETURNING *`;
  uklid.shops.push(shop.id);
  const klic = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(klic).digest('hex');
  const [k] = await sql`
    INSERT INTO eshop_api_keys (shop_id, key_hash, label) VALUES (${shop.id}, ${hash}, 'test') RETURNING id`;
  await sql`
    INSERT INTO invoice_number_series (name, prefix, format, current_number, start_number, padding, shop_id, entity_type, active)
    VALUES (${`Obj ${slug}`}, '', ${`${cislice}NNNNNNN`}, 0, 1, 4, ${shop.id}, 'objednavka', TRUE),
           (${`ZF ${slug}`}, '', ${`Z${kod}${r}-NNNN`}, 0, 1, 4, ${shop.id}, 'zalohova_faktura', TRUE),
           (${`FV ${slug}`}, '', ${`F${kod}${r}-NNNN`}, 0, 1, 4, ${shop.id}, 'faktura', TRUE)`;
  return { ...shop, klic, keyId: k.id };
}

const objednavka = (mail, over = {}) => ({
  customer: { firstName: 'Jana', lastName: 'Testová', email: mail, phone: '777000111', city: 'Praha', ...over.customer },
  shipping: { method: 'Zásilkovna', pickupPointId: '1234', pickupPointName: 'Z-BOX Praha 7' },
  paymentMethod: over.paymentMethod ?? 'transfer',
  ...(over.status ? { status: over.status } : {}),
  items: over.items ?? [{ sku: 'PRIZE-1', supplierCode: '', name: 'Merino příze', quantity: 2, price: 149.4 }],
  totalPrice: over.totalPrice ?? 298.8,
  ...(over.marketing ? { marketing: over.marketing } : {}),
});

async function zalozObjednavku(shop, mail, over) {
  const res = await call(shop.klic, 'POST', '/api/eshop/orders', objednavka(mail, over));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  uklid.orders.push(res.body.orderId);
  return res.body;
}

async function zalozObjednavkuToneracku(mail, over) {
  const res = await call(TONERACEK_KEY, 'POST', '/api/toneracek/orders', objednavka(mail, over));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  uklid.orders.push(res.body.orderId);
  return res.body;
}

// ── Zdroj objednávky a nákupní cena (migrace 042, docs/api.md) ──

// Časy dotyků relativně k „teď“: One SEIL bere jen čas do ±1 roku od přijetí.
const PRVNI_DOTYK_AT = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
const POSLEDNI_DOTYK_AT = new Date(Date.now() - 3600_000).toISOString();
const MARKETING = {
  consent: 'all',
  first: {
    source: 'Google', medium: 'CPC', campaign: 'Tonery HP', term: 'hp 12a', content: 'textovy',
    clickIdKind: 'gclid', clickId: 'Cj0KCQ-abc_123', referrerHost: 'www.google.com',
    landingPage: '/produkty/hp-12a?gclid=Cj0KCQ-abc_123', at: PRVNI_DOTYK_AT,
  },
  last: {
    source: 'seznam', medium: 'cpc', campaign: 'sklik-tonery', clickIdKind: 'sznclid', clickId: 'szn-1',
    referrerHost: 'search.seznam.cz', landingPage: '/', at: POSLEDNI_DOTYK_AT,
  },
};
const POLOZKY_S_NAKUPNI_CENOU = [
  { sku: 'PRIZE-1', supplierCode: '', name: 'Merino příze', quantity: 2, price: 149.4, costPrice: 210.456, costPriceVatIncluded: false },
  { sku: 'DOPRAVA', name: 'Doprava', quantity: 1, price: 79, costPrice: null, costPriceVatIncluded: null },
];
/** Sloupce položky, které by-number smí vrátit — bez cost_price a cost_price_vat_included. */
const SLOUPCE_POLOZKY = ['id', 'order_id', 'sku', 'name', 'quantity', 'price', 'product_id', 'multipack_id', 'supplier_code'];

/**
 * Kontrakt zdroje objednávky a nákupní ceny pro jedno API (`prefix` + klíč):
 * POST s `marketing` a `costPrice` → by-number vrací 21 sloupců atribuce
 * vyčištěné podle src/atribuce-objednavky.js a položky jen s povolenými
 * sloupci; `cost_price` nikdy neopustí One SEIL (jen v databázi, na haléře);
 * bez marketingového souhlasu se click-id neuloží; nepoužitelný čas dotyku
 * nahradí čas přijetí; bez `marketing` a `costPrice` zůstanou výchozí '' a NULL.
 */
async function overZdrojANakupniCenu(prefix, klic, mail) {
  const post = async (telo) => {
    const res = await call(klic, 'POST', `${prefix}/orders`, telo);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    uklid.orders.push(res.body.orderId);
    return res.body;
  };
  const detail = async (o) => {
    const res = await call(klic, 'GET', `${prefix}/orders/by-number/${o.orderNumber}?email=${encodeURIComponent(mail)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const atribuce = (order) => Object.fromEntries(SLOUPCE_ATRIBUCE.map((k) => [k, order[k]]));

  // Plná objednávka: atribuce vyčištěná (malá písmena, jen hostitel, jen cesta), položky bez nákupní ceny.
  const plna = await post(objednavka(mail, { marketing: MARKETING, items: POLOZKY_S_NAKUPNI_CENOU, totalPrice: 377.8 }));
  const telo = await detail(plna);
  assert.deepEqual(atribuce(telo.order), {
    utm_source_first: 'google', utm_medium_first: 'cpc', utm_campaign_first: 'Tonery HP', utm_term_first: 'hp 12a',
    utm_content_first: 'textovy', click_id_kind_first: 'gclid', click_id_first: 'Cj0KCQ-abc_123',
    referrer_host_first: 'google.com', landing_page_first: '/produkty/hp-12a', touch_first_at: PRVNI_DOTYK_AT,
    utm_source_last: 'seznam', utm_medium_last: 'cpc', utm_campaign_last: 'sklik-tonery', utm_term_last: '',
    utm_content_last: '', click_id_kind_last: 'sznclid', click_id_last: 'szn-1',
    referrer_host_last: 'search.seznam.cz', landing_page_last: '/', touch_last_at: POSLEDNI_DOTYK_AT,
    attribution_consent: 'all',
  });
  assert.equal(telo.order.items.length, 2);
  for (const polozka of telo.order.items) assert.deepEqual(Object.keys(polozka), SLOUPCE_POLOZKY);
  assert.ok(!JSON.stringify(telo).includes('cost_price'), 'nákupní cena nesmí z by-number odejít');
  const seznam = await call(klic, 'GET', `${prefix}/orders?email=${encodeURIComponent(mail)}`);
  assert.equal(seznam.status, 200);
  assert.ok(!JSON.stringify(seznam.body).includes('cost_price'), 'ani ze seznamu objednávek');
  assert.ok(seznam.body.orders.every((o) => o.items.every((p) => Object.keys(p).sort().join() === 'name,quantity')),
    'seznam nese u položky jen název a počet');
  const polozky = await sql`SELECT sku, cost_price, cost_price_vat_included FROM shop_order_items WHERE order_id = ${plna.orderId} ORDER BY id`;
  assert.deepEqual(polozky.map((p) => ({ ...p })), [
    { sku: 'PRIZE-1', cost_price: '210.46', cost_price_vat_included: false }, // NUMERIC vrací postgres.js jako text; na haléře
    { sku: 'DOPRAVA', cost_price: null, cost_price_vat_included: null },
  ]);

  // Bez marketingového souhlasu se click-id neuloží (druh ani hodnota), zbytek dotyku ano.
  const analytics = await post(objednavka(mail, { marketing: { consent: 'analytics', last: MARKETING.last } }));
  const [a] = await sql`
    SELECT attribution_consent, utm_source_last, click_id_kind_last, click_id_last, touch_last_at, utm_source_first, touch_first_at
    FROM shop_orders WHERE id = ${analytics.orderId}`;
  assert.deepEqual({ ...a, touch_last_at: a.touch_last_at.toISOString() }, {
    attribution_consent: 'analytics', utm_source_last: 'seznam', click_id_kind_last: '', click_id_last: '',
    touch_last_at: POSLEDNI_DOTYK_AT, utm_source_first: '', touch_first_at: null,
  });

  // Nepoužitelný čas dotyku → čas přijetí, ne NULL (touch_last_at IS NULL = atribuce neposlána).
  const rozbity = await post(objednavka(mail, { marketing: { consent: 'none', last: { source: 'google', medium: 'cpc', at: 'not-a-date' } } }));
  const [r] = await sql`SELECT utm_source_last, touch_last_at FROM shop_orders WHERE id = ${rozbity.orderId}`;
  assert.equal(r.utm_source_last, 'google');
  assert.ok(r.touch_last_at && Math.abs(r.touch_last_at.getTime() - Date.now()) < 60_000, 'čas přijetí objednávky');

  // Starší e-shop bez `marketing` a `costPrice`: výchozí hodnoty sloupců.
  const bez = await post(objednavka(mail));
  const bezTelo = await detail(bez);
  assert.deepEqual(atribuce(bezTelo.order), Object.fromEntries(SLOUPCE_ATRIBUCE.map((k) => [k, k.startsWith('touch_') ? null : ''])));
  const [p] = await sql`SELECT cost_price, cost_price_vat_included FROM shop_order_items WHERE order_id = ${bez.orderId}`;
  assert.deepEqual({ ...p }, { cost_price: null, cost_price_vat_included: null });
}

before(async () => {
  sql = postgres(lokalniDatabaze(), { max: 3, onnotice: () => {} });
  const health = await fetch(BASE + '/health').catch(() => null);
  assert.ok(health?.ok, `server neběží na ${BASE}`);

  ctx.a = await zalozEshop('Alfa', 7);
  ctx.b = await zalozEshop('Beta', 8);
});

after(async () => {
  if (!sql) return;
  const shops = uklid.shops.length ? uklid.shops : [0];
  const orders = uklid.orders.length ? uklid.orders : [''];
  await sql`DELETE FROM accounting_invoices WHERE order_id = ANY(${orders}) OR shop_id = ANY(${shops})`;
  await sql`DELETE FROM shop_orders WHERE id = ANY(${orders}) OR shop_id = ANY(${shops})`;
  if (uklid.emails.length) await sql`DELETE FROM crm_contacts WHERE LOWER(email) = ANY(${uklid.emails})`;
  await sql`DELETE FROM crm_companies WHERE name LIKE ${`%${r}%`}`;
  await sql`DELETE FROM invoice_number_series WHERE shop_id = ANY(${shops})`;
  await sql`DELETE FROM shops WHERE id = ANY(${shops})`;
  await sql.end();
});

// ── Klíč ───────────────────────────────────────────────────────

describe('ověření klíčem', () => {
  test('bez klíče, se špatným a s klíčem bez „Bearer“ je 401', async () => {
    const cesta = `${BASE}/api/eshop/orders?email=x@example.invalid`;
    for (const headers of [{}, { authorization: `Bearer ${'0'.repeat(64)}` }, { authorization: ctx.a.klic }]) {
      const res = await fetch(cesta, { headers });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'Unauthorized' });
    }
  });

  test('klíč Toneráčku na /api/eshop neplatí', { skip: !TONERACEK_KEY && 'chybí TONERACEK_API_KEY' }, async () => {
    const res = await call(TONERACEK_KEY, 'GET', '/api/eshop/orders?email=x@example.invalid');
    assert.equal(res.status, 401);
  });

  test('platný klíč projde a zapíše se, kdy byl naposledy použit', async () => {
    const res = await call(ctx.a.klic, 'GET', '/api/eshop/orders?email=nikdo@example.invalid');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { orders: [] });
    // Zápis je fire-and-forget, chvíli počkat.
    let pouzit = null;
    for (let i = 0; i < 20 && !pouzit; i++) {
      [{ last_used_at: pouzit }] = await sql`SELECT last_used_at FROM eshop_api_keys WHERE id = ${ctx.a.keyId}`;
      if (!pouzit) await new Promise((ok) => setTimeout(ok, 100));
    }
    assert.ok(pouzit, 'last_used_at se měl vyplnit');
  });

  test('zrušený klíč přestane platit hned', async () => {
    const klic = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(klic).digest('hex');
    const [k] = await sql`INSERT INTO eshop_api_keys (shop_id, key_hash) VALUES (${ctx.a.id}, ${hash}) RETURNING id`;
    assert.equal((await call(klic, 'GET', '/api/eshop/orders?email=x@example.invalid')).status, 200);
    await sql`UPDATE eshop_api_keys SET active = FALSE, revoked_at = NOW() WHERE id = ${k.id}`;
    assert.equal((await call(klic, 'GET', '/api/eshop/orders?email=x@example.invalid')).status, 401);
  });

  test('klíč vypnutého e-shopu neplatí', async () => {
    const vypnuty = await zalozEshop('Vypnuty', 6, { aktivni: false });
    assert.equal((await call(vypnuty.klic, 'GET', '/api/eshop/orders?email=x@example.invalid')).status, 401);
  });

  test('v databázi je jen otisk klíče', async () => {
    const radky = await sql`SELECT key_hash FROM eshop_api_keys WHERE shop_id = ${ctx.a.id}`;
    assert.ok(radky.length >= 1);
    assert.ok(radky.every((x) => x.key_hash !== ctx.a.klic && /^[0-9a-f]{64}$/.test(x.key_hash)));
    await assert.rejects(
      sql`INSERT INTO eshop_api_keys (shop_id, key_hash) VALUES (${ctx.a.id}, 'neni-otisk')`,
      /eshop_api_keys_hash_chk/,
    );
  });
});

// ── Objednávky ─────────────────────────────────────────────────

describe('objednávky po e-shopech', () => {
  test('nová objednávka dostane číslo z řady svého e-shopu a zálohovku', async () => {
    const mail = email('obj-a');
    const o1 = await zalozObjednavku(ctx.a, mail);
    const o2 = await zalozObjednavku(ctx.a, mail, { paymentMethod: 'card', status: 'Čeká na platbu' });
    assert.match(o1.orderNumber, /^7\d{7}$/);
    assert.equal(Number(o2.orderNumber), Number(o1.orderNumber) + 1, 'řada N jde po jedné');
    assert.equal(o1.invoiceNumber, '');
    ctx.oA = o1;
    ctx.oAkarta = o2;
    ctx.mailA = mail;

    const [row] = await sql`SELECT * FROM shop_orders WHERE id = ${o1.orderId}`;
    assert.equal(row.shop_id, ctx.a.id);
    assert.equal(row.payment_method, 'Bankovní převod');
    assert.equal(row.status, 'Přijata');
    assert.equal(Number(row.total_price), 299, 'celé koruny');

    const [proforma] = await sql`SELECT * FROM accounting_invoices WHERE order_id = ${o1.orderId} AND type = 'proforma'`;
    assert.ok(proforma, 'převod má zálohovku hned');
    assert.equal(proforma.shop_id, ctx.a.id);
    assert.match(proforma.number, new RegExp(`^ZA${r}-0001$`));

    const [karta] = await sql`SELECT status, paid_at FROM shop_orders WHERE id = ${o2.orderId}`;
    assert.equal(karta.status, 'Čeká na platbu');
    assert.equal(karta.paid_at, null);
  });

  test('zákazník z objednávky je v CRM se zdrojem e-shopu, ale bez účtu', async () => {
    const [c] = await sql`SELECT * FROM crm_contacts WHERE LOWER(email) = ${ctx.mailA}`;
    assert.equal(c.source, ctx.a.name);
    assert.equal(c.is_registered, false);
    const [cs] = await sql`SELECT * FROM crm_contact_shops WHERE contact_id = ${c.id} AND shop_id = ${ctx.a.id}`;
    assert.ok(cs, 'host je přihlášený k e-shopu');
    assert.equal(cs.is_registered, false, 'host nesmí vypadat jako registrovaný (výchozí hodnota sloupce je TRUE)');
    const res = await call(ctx.a.klic, 'GET', `/api/eshop/users?email=${encodeURIComponent(ctx.mailA)}`);
    assert.equal(res.status, 404);
  });

  test('dotazy na objednávky vidí jen vlastní e-shop', async () => {
    const vlastni = await call(ctx.a.klic, 'GET', `/api/eshop/orders?email=${encodeURIComponent(ctx.mailA)}`);
    assert.equal(vlastni.status, 200);
    assert.deepEqual(vlastni.body.orders.map((o) => o.id).sort(), [ctx.oA.orderId, ctx.oAkarta.orderId].sort());
    assert.ok(vlastni.body.orders.every((o) => o.invoice_number === '' && Array.isArray(o.items)));

    const cizi = await call(ctx.b.klic, 'GET', `/api/eshop/orders?email=${encodeURIComponent(ctx.mailA)}`);
    assert.deepEqual(cizi.body, { orders: [] });

    const detail = await call(ctx.a.klic, 'GET', `/api/eshop/orders/by-number/${ctx.oA.orderNumber}?email=${encodeURIComponent(ctx.mailA)}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.order.id, ctx.oA.orderId);
    assert.equal(detail.body.order.items.length, 1);

    assert.equal((await call(ctx.a.klic, 'GET', `/api/eshop/orders/by-number/${ctx.oA.orderNumber}?email=cizi@example.invalid`)).status, 403);
    assert.equal((await call(ctx.b.klic, 'GET', `/api/eshop/orders/by-number/${ctx.oA.orderNumber}`)).status, 404);
  });

  test('zdroj objednávky a nákupní cena: by-number vrací atribuci, cost_price nikdy neopustí One SEIL', async () => {
    await overZdrojANakupniCenu('/api/eshop', ctx.a.klic, email('atribuce'));
  });

  test('cizí klíč objednávku nezmění ani nepřečte', async () => {
    const id = ctx.oA.orderId;
    assert.equal((await call(ctx.b.klic, 'PATCH', `/api/eshop/orders/${id}/payment-status`, { status: 'Zaplaceno' })).status, 404);
    assert.equal((await call(ctx.b.klic, 'PATCH', `/api/eshop/orders/${id}/payment-method`, { paymentMethod: 'cod' })).status, 404);
    assert.equal((await call(ctx.b.klic, 'PATCH', `/api/eshop/orders/${id}/tracking`, { trackingNumber: 'Z1' })).status, 404);
    assert.equal((await call(ctx.b.klic, 'GET', `/api/eshop/orders/${id}/payment-details`)).status, 404);
    const [row] = await sql`SELECT status, payment_method, tracking_number FROM shop_orders WHERE id = ${id}`;
    assert.deepEqual({ ...row }, { status: 'Přijata', payment_method: 'Bankovní převod', tracking_number: '' });
  });

  test('platební údaje: variabilní symbol z čísla objednávky, zálohovka e-shopu, PDF na vyžádání', async () => {
    const res = await call(ctx.a.klic, 'GET', `/api/eshop/orders/${ctx.oA.orderId}/payment-details`);
    assert.equal(res.status, 200);
    assert.equal(res.body.variableSymbol, ctx.oA.orderNumber);
    assert.equal(res.body.amount, 299);
    assert.equal(res.body.currency, 'CZK');
    assert.match(res.body.proformaNumber, new RegExp(`^ZA${r}-0001$`));
    assert.equal(res.body.pdf, null);
    assert.deepEqual(Object.keys(res.body).sort(),
      ['amount', 'bankAccount', 'bankName', 'currency', 'dueDate', 'iban', 'pdf', 'proformaNumber', 'swift', 'variableSymbol']);

    const sPdf = await call(ctx.a.klic, 'GET', `/api/eshop/orders/${ctx.oA.orderId}/payment-details?pdf=1`);
    assert.equal(sPdf.status, 200);
    assert.equal(sPdf.body.pdf.filename, `zalohova-faktura-${res.body.proformaNumber}.pdf`);
    assert.ok(Buffer.from(sPdf.body.pdf.contentBase64, 'base64').subarray(0, 5).toString() === '%PDF-');

    const karta = await call(ctx.a.klic, 'GET', `/api/eshop/orders/${ctx.oAkarta.orderId}/payment-details`);
    assert.equal(karta.status, 409);
    assert.deepEqual(karta.body, { error: 'not-transfer' });
  });

  test('platba: první potvrzení zapíše okamžik, opakované ho nepřepíše', async () => {
    const id = ctx.oAkarta.orderId;
    assert.deepEqual((await call(ctx.a.klic, 'PATCH', `/api/eshop/orders/${id}/payment-status`, { status: 'Zaplaceno' })).body, { ok: true });
    const [{ paid_at: prvni }] = await sql`SELECT paid_at FROM shop_orders WHERE id = ${id}`;
    assert.ok(prvni);
    await new Promise((ok) => setTimeout(ok, 20));
    await call(ctx.a.klic, 'PATCH', `/api/eshop/orders/${id}/payment-status`, { status: 'Zaplaceno' });
    const [{ paid_at: druhy }] = await sql`SELECT paid_at FROM shop_orders WHERE id = ${id}`;
    assert.equal(druhy.getTime(), prvni.getTime());
    assert.equal((await call(ctx.a.klic, 'PATCH', `/api/eshop/orders/${id}/payment-status`, {})).status, 400);
  });

  test('přepnutí na převod vystaví zálohovku jednou, tracking se uloží', async () => {
    const mail = email('prepnuti');
    const o = await zalozObjednavku(ctx.a, mail, { paymentMethod: 'card', status: 'Čeká na platbu' });
    assert.equal((await call(ctx.a.klic, 'PATCH', `/api/eshop/orders/${o.orderId}/payment-method`, { paymentMethod: 'nesmysl' })).status, 400);
    for (let i = 0; i < 2; i++) {
      const res = await call(ctx.a.klic, 'PATCH', `/api/eshop/orders/${o.orderId}/payment-method`,
        { paymentMethod: 'transfer', totalPrice: 338.6, status: 'Přijata' });
      assert.deepEqual(res.body, { ok: true });
    }
    const zalohovky = await sql`SELECT * FROM accounting_invoices WHERE order_id = ${o.orderId} AND type = 'proforma'`;
    assert.equal(zalohovky.length, 1);
    const [row] = await sql`SELECT payment_method, total_price, status FROM shop_orders WHERE id = ${o.orderId}`;
    assert.deepEqual({ ...row, total_price: Number(row.total_price) },
      { payment_method: 'Bankovní převod', total_price: 339, status: 'Přijata' });

    assert.deepEqual((await call(ctx.a.klic, 'PATCH', `/api/eshop/orders/${o.orderId}/tracking`, { trackingNumber: 'Z123456789' })).body, { ok: true });
    const [t] = await sql`SELECT tracking_number FROM shop_orders WHERE id = ${o.orderId}`;
    assert.equal(t.tracking_number, 'Z123456789');
  });

  test('chybějící data objednávky jsou 400', async () => {
    const res = await call(ctx.a.klic, 'POST', '/api/eshop/orders', { customer: {}, items: [] });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Chybí povinná data objednávky' });
    assert.equal((await call(ctx.a.klic, 'GET', '/api/eshop/orders')).status, 400);
  });

  test('e-shop bez vyplněné identity objednávku odmítne a nic nezaloží', async () => {
    const bez = await zalozEshop('Bezidentity', 5, { identita: false });
    const res = await call(bez.klic, 'POST', '/api/eshop/orders', objednavka(email('bez-identity')));
    assert.equal(res.status, 503);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM shop_orders WHERE shop_id = ${bez.id}`;
    assert.equal(n, 0);
  });
});

// ── Hranice mezi e-shopy a Toneráčkem ──────────────────────────

describe('Toneráček a další e-shop se navzájem nevidí', { skip: !TONERACEK_KEY && 'chybí TONERACEK_API_KEY' }, () => {
  test('klíč Toneráčku nedostane platební údaje ani objednávku jiného e-shopu', async () => {
    const res = await call(TONERACEK_KEY, 'GET', `/api/toneracek/orders/${ctx.oA.orderId}/payment-details`);
    assert.equal(res.status, 404, 'platební údaje Toneráčku jsou jen k jeho objednávkám');
    const pocet = await sql`SELECT COUNT(*)::int AS n FROM accounting_invoices WHERE order_id = ${ctx.oA.orderId}`;
    assert.equal(pocet[0].n, 1, 'cizí klíč nesmí nechat vystavit další doklad');
    assert.equal((await call(TONERACEK_KEY, 'GET', `/api/toneracek/orders/by-number/${ctx.oA.orderNumber}`)).status, 404);
    assert.equal((await call(TONERACEK_KEY, 'PATCH', `/api/toneracek/orders/${ctx.oA.orderId}/payment-status`, { status: 'Zaplaceno' })).status, 404);
  });

  test('klíč e-shopu nedosáhne na objednávku Toneráčku', async () => {
    const mail = email('toneracek-obj');
    const t = await zalozObjednavkuToneracku(mail);
    ctx.oT = t;
    assert.equal((await call(ctx.a.klic, 'GET', `/api/eshop/orders/${t.orderId}/payment-details`)).status, 404);
    assert.equal((await call(ctx.a.klic, 'PATCH', `/api/eshop/orders/${t.orderId}/payment-status`, { status: 'Zaplaceno' })).status, 404);
    assert.equal((await call(ctx.a.klic, 'GET', `/api/eshop/orders/by-number/${t.orderNumber}`)).status, 404);
    // Toneráček svoje platební údaje dostane dál.
    const vlastni = await call(TONERACEK_KEY, 'GET', `/api/toneracek/orders/${t.orderId}/payment-details`);
    assert.equal(vlastni.status, 200);
    assert.equal(vlastni.body.variableSymbol, t.orderNumber);
  });

  test('/api/toneracek drží tentýž kontrakt zdroje objednávky a nákupní ceny', async () => {
    await overZdrojANakupniCenu('/api/toneracek', TONERACEK_KEY, email('toneracek-atribuce'));
  });
});

// ── Účty po e-shopech ──────────────────────────────────────────

describe('zákaznické účty po e-shopech', { skip: !TONERACEK_KEY && 'chybí TONERACEK_API_KEY' }, () => {
  test('zákazník Toneráčku se na e-shopu registruje zvlášť a Toneráčku se nic nezmění', async () => {
    const mail = email('oba');
    ctx.mailOba = mail;
    const reg = await call(TONERACEK_KEY, 'POST', '/api/toneracek/users',
      { email: mail, jmeno: 'Petr', prijmeni: 'Oba', telefon: '111', souhlasGdpr: true, souhlasMarketing: false });
    assert.equal(reg.status, 201);
    ctx.idOba = reg.body.id;
    await call(TONERACEK_KEY, 'PATCH', `/api/toneracek/users/${reg.body.id}`, { poznamka: 'PWDHASH:toneracek' });
    const [pred] = await sql`SELECT * FROM crm_contacts WHERE id = ${reg.body.id}`;

    // Na e-shopu účet není, i když na Toneráčku je.
    assert.equal((await call(ctx.a.klic, 'GET', `/api/eshop/users?email=${encodeURIComponent(mail)}`)).status, 404);

    const registrace = await call(ctx.a.klic, 'POST', '/api/eshop/users',
      { email: mail, jmeno: 'Petr', prijmeni: 'Oba', telefon: '222', souhlasGdpr: true, souhlasMarketing: true });
    assert.equal(registrace.status, 200, 'kontakt už existoval → 200 jako u Toneráčku');
    assert.equal(registrace.body.id, reg.body.id, 'kontakt v CRM je jeden');
    assert.equal(registrace.body.telefon, '222', 'profil e-shopu');
    assert.equal(registrace.body.souhlasMarketing, true);
    assert.equal(registrace.body.poznamka, undefined, 'poznámka jen přes withNote');

    const [po] = await sql`SELECT * FROM crm_contacts WHERE id = ${reg.body.id}`;
    for (const sloupec of ['is_registered', 'notes', 'marketing_consent', 'phone', 'first_name', 'last_name']) {
      assert.deepEqual(po[sloupec], pred[sloupec], `crm_contacts.${sloupec} se nesmí změnit`);
    }
    assert.equal(po.gdpr_consent_at.getTime(), pred.gdpr_consent_at.getTime());

    const t = await call(TONERACEK_KEY, 'GET', `/api/toneracek/users?email=${encodeURIComponent(mail)}&withNote=1`);
    assert.equal(t.status, 200);
    assert.equal(t.body.poznamka, 'PWDHASH:toneracek');
    assert.equal(t.body.telefon, '111');
    assert.equal(t.body.souhlasMarketing, false);
  });

  test('heslo, souhlasy a profil e-shopu žijí odděleně', async () => {
    const id = ctx.idOba;
    const upr = await call(ctx.a.klic, 'PATCH', `/api/eshop/users/${id}`,
      { poznamka: 'PWDHASH:eshop', telefon: '333', souhlasNotifikace: true, posledniPrihlaseni: '2026-10-25T10:00:00.000Z' });
    assert.equal(upr.status, 200);
    assert.equal(upr.body.telefon, '333');
    assert.equal(upr.body.souhlasNotifikace, true);

    const eshop = await call(ctx.a.klic, 'GET', `/api/eshop/users?email=${encodeURIComponent(ctx.mailOba)}&withNote=1`);
    assert.equal(eshop.body.poznamka, 'PWDHASH:eshop');
    const toneracek = await call(TONERACEK_KEY, 'GET', `/api/toneracek/users?email=${encodeURIComponent(ctx.mailOba)}&withNote=1`);
    assert.equal(toneracek.body.poznamka, 'PWDHASH:toneracek', 'heslo z e-shopu nesmí otevřít Toneráček');
    assert.equal(toneracek.body.telefon, '111', 'neprázdný sdílený údaj se nepřepisuje');
    assert.equal(toneracek.body.souhlasNotifikace, false);

    const [cs] = await sql`SELECT last_login FROM crm_contact_shops WHERE contact_id = ${id} AND shop_id = ${ctx.a.id}`;
    assert.equal(cs.last_login.toISOString(), '2026-10-25T10:00:00.000Z');
    const [c] = await sql`SELECT last_login FROM crm_contacts WHERE id = ${id}`;
    assert.equal(c.last_login, null);

    const podleId = await call(ctx.a.klic, 'GET', `/api/eshop/users/${id}`);
    assert.equal(podleId.status, 200);
    assert.equal(podleId.body.poznamka, undefined);
  });

  test('druhá registrace v tomtéž e-shopu je 409, v jiném e-shopu účet není', async () => {
    const znovu = await call(ctx.a.klic, 'POST', '/api/eshop/users', { email: ctx.mailOba, jmeno: 'X' });
    assert.equal(znovu.status, 409);
    assert.deepEqual(znovu.body, { error: 'Účet s tímto e-mailem již existuje' });
    assert.equal((await call(ctx.b.klic, 'GET', `/api/eshop/users?email=${encodeURIComponent(ctx.mailOba)}`)).status, 404);
    assert.equal((await call(ctx.b.klic, 'GET', `/api/eshop/users/${ctx.idOba}`)).status, 404);
    assert.equal((await call(ctx.b.klic, 'PATCH', `/api/eshop/users/${ctx.idOba}`, { poznamka: 'PWDHASH:cizi' })).status, 404);
    const [cs] = await sql`SELECT password_backup FROM crm_contact_shops WHERE contact_id = ${ctx.idOba} AND shop_id = ${ctx.a.id}`;
    assert.equal(cs.password_backup, 'PWDHASH:eshop');
  });

  test('nový zákazník e-shopu nevypadá jako registrovaný u Toneráčku', async () => {
    const mail = email('jen-eshop');
    const reg = await call(ctx.a.klic, 'POST', '/api/eshop/users',
      { email: mail.toUpperCase(), jmeno: 'Eva', prijmeni: 'Nová', souhlasGdpr: true, souhlasMarketing: true });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.email, mail);
    assert.equal(reg.body.souhlasGdpr, true);

    const [c] = await sql`SELECT * FROM crm_contacts WHERE id = ${reg.body.id}`;
    assert.equal(c.is_registered, false);
    assert.equal(c.notes, '');
    assert.equal(c.marketing_consent, false);
    assert.equal(c.gdpr_consent_at, null);
    assert.equal(c.source, ctx.a.name);

    assert.equal((await call(TONERACEK_KEY, 'GET', `/api/toneracek/users?email=${encodeURIComponent(mail)}`)).status, 404);
    // Toneráček ho pořád může zaregistrovat (povýšení existujícího kontaktu).
    const t = await call(TONERACEK_KEY, 'POST', '/api/toneracek/users', { email: mail, jmeno: 'Eva', prijmeni: 'Nová' });
    assert.equal(t.status, 200);
    // …a účet na e-shopu tím nezmizí.
    assert.equal((await call(ctx.a.klic, 'GET', `/api/eshop/users?email=${encodeURIComponent(mail)}`)).status, 200);
  });

  test('host s objednávkou se může zaregistrovat; profil jde do účtu e-shopu, telefon do CRM jen z objednávky', async () => {
    const mail = email('host');
    await zalozObjednavku(ctx.a, mail, { customer: { phone: '' } });
    assert.equal((await call(ctx.a.klic, 'GET', `/api/eshop/users?email=${encodeURIComponent(mail)}`)).status, 404);
    const reg = await call(ctx.a.klic, 'POST', '/api/eshop/users',
      { email: mail, jmeno: 'Jana', prijmeni: 'Testová', telefon: '606', ulice: 'Pletená 1' });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.telefon, '606');
    assert.equal(reg.body.ulice, 'Pletená 1');
    let [c] = await sql`SELECT phone, address, is_registered FROM crm_contacts WHERE LOWER(email) = ${mail}`;
    assert.equal(c.phone, '', 'registrace sdílený kontakt nemění — e-mail ještě nikdo neověřil');
    assert.equal(c.address, '');
    assert.equal(c.is_registered, false);
    assert.equal((await call(ctx.a.klic, 'GET', `/api/eshop/users?email=${encodeURIComponent(mail)}`)).status, 200);

    // Objednávka prázdné jméno a telefon kontaktu, který není účtem Toneráčku, doplní.
    await zalozObjednavku(ctx.a, mail, { customer: { phone: '777000222' } });
    [c] = await sql`SELECT phone FROM crm_contacts WHERE LOWER(email) = ${mail}`;
    assert.equal(c.phone, '777000222');
  });

  test('účet Toneráčku s prázdnými údaji: registrace, úprava profilu ani objednávka na e-shopu ho nedoplní', async () => {
    // Pokladna Toneráčku předvyplňuje firmu a adresu z účtu. Registraci na
    // e-shopu může s cizím e-mailem poslat kdokoli, ověření přijde až potom.
    const mail = email('prazdny-toneracek');
    const reg = await call(TONERACEK_KEY, 'POST', '/api/toneracek/users', { email: mail, jmeno: 'Tomáš', prijmeni: 'Toner' });
    assert.equal(reg.status, 201);
    const toneracekPred = (await call(TONERACEK_KEY, 'GET', `/api/toneracek/users?email=${encodeURIComponent(mail)}`)).body;
    assert.deepEqual([toneracekPred.telefon, toneracekPred.firma, toneracekPred.ulice, toneracekPred.mesto, toneracekPred.psc],
      ['', '', '', '', '']);
    const [radekPred] = await sql`SELECT * FROM crm_contacts WHERE id = ${reg.body.id}`;

    const cizi = await call(ctx.a.klic, 'POST', '/api/eshop/users', {
      email: mail.toUpperCase(), jmeno: 'Cizí', prijmeni: 'Člověk', telefon: '600111222',
      firma: `Vlna ${r} s.r.o.`, ulice: 'Pletená 1', mesto: 'Brno', psc: '60200',
    });
    assert.equal(cizi.status, 200);
    assert.equal(cizi.body.firma, `Vlna ${r} s.r.o.`, 'na e-shopu má účet svůj profil');
    const upr = await call(ctx.a.klic, 'PATCH', `/api/eshop/users/${reg.body.id}`, { telefon: '600333444', mesto: 'Olomouc' });
    assert.equal(upr.status, 200);
    assert.equal(upr.body.mesto, 'Olomouc');
    await zalozObjednavku(ctx.a, mail, { customer: { phone: '600555666', company: `Vlna ${r} s.r.o.` } });

    const toneracekPo = (await call(TONERACEK_KEY, 'GET', `/api/toneracek/users?email=${encodeURIComponent(mail)}`)).body;
    assert.deepEqual(toneracekPo, toneracekPred, 'Toneráček vidí účet přesně jako předtím');
    const [radekPo] = await sql`SELECT * FROM crm_contacts WHERE id = ${reg.body.id}`;
    assert.deepEqual({ ...radekPo }, { ...radekPred }, 'řádek účtu Toneráčku v CRM se nezměnil ani v jednom sloupci');
  });

  test('klíč Toneráčku nepřečte zákazníka jen jiného e-shopu ani úpravou bez polí', async () => {
    const mail = email('jen-eshop-cteni');
    const reg = await call(ctx.a.klic, 'POST', '/api/eshop/users',
      { email: mail, jmeno: 'Dita', prijmeni: 'Dílnová', telefon: '777123456', ulice: 'Tajná 1' });
    assert.equal(reg.status, 201);
    assert.equal((await call(TONERACEK_KEY, 'GET', `/api/toneracek/users/${reg.body.id}`)).status, 404);
    const prazdna = await call(TONERACEK_KEY, 'PATCH', `/api/toneracek/users/${reg.body.id}`, {});
    assert.equal(prazdna.status, 404, 'dřív 200 se jménem, telefonem a adresou zákazníka jiného e-shopu');
    assert.deepEqual(prazdna.body, { error: 'Not found' });
    assert.equal((await call(TONERACEK_KEY, 'PATCH', '/api/toneracek/users/neexistuje', {})).status, 404, 'neznámé id není 500');
    // Registrovaný zákazník Toneráčku dostane úpravou bez polí svůj účet jako dřív
    // (celou odpověď hlídá i test/toneracek-kontrakt.test.js).
    const vlastni = await call(TONERACEK_KEY, 'PATCH', `/api/toneracek/users/${ctx.idOba}`, {});
    assert.equal(vlastni.status, 200);
    assert.equal(vlastni.body.id, ctx.idOba);
  });

  test('chybějící e-mail je 400 a neznámé id 404', async () => {
    assert.equal((await call(ctx.a.klic, 'GET', '/api/eshop/users')).status, 400);
    assert.equal((await call(ctx.a.klic, 'POST', '/api/eshop/users', {})).status, 400);
    assert.equal((await call(ctx.a.klic, 'GET', '/api/eshop/users/neexistuje')).status, 404);
    assert.equal((await call(ctx.a.klic, 'PATCH', '/api/eshop/users/neexistuje', {})).status, 404);
  });
});
