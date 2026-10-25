// Kontrakt API Toneráčku: odpovědi /api/toneracek/* se nesmí změnit
// a /api/eshop/* musí odpovídat úplně stejně.
//
// Jeden scénář (uživatelé, objednávky, platby, platební údaje, chyby) projde
// oběma API. Odpovědi se znormalizují — id, čísla objednávek a dokladů, časy
// a data nahradí zástupné značky — a porovnají se celé: stavové kódy, klíče
// i hodnoty. Vzor (test/fixtures/toneracek-kontrakt.json) vznikl během scénáře
// proti main před zásahem pro druhý e-shop:
//
//   KONTRAKT_ZAPSAT=1 TEST_BASE_URL=<server z main> DATABASE_URL=… \
//   TONERACEK_API_KEY=… node --test test/toneracek-kontrakt.test.js
//
// (v režimu zápisu běží jen část Toneráčku — main /api/eshop nemá).
//
// Jede proti běžícímu serveru a testovací databázi. Zakládá si vlastní e-shop
// s klíčem a řadami a vlastní objednávky a kontakty, po sobě je uklidí.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   TONERACEK_API_KEY=<tentýž jako u serveru> node --test test/toneracek-kontrakt.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const TONERACEK_KEY = process.env.TONERACEK_API_KEY || '';
const ZAPSAT = process.env.KONTRAKT_ZAPSAT === '1';
const VZOR = new URL('./fixtures/toneracek-kontrakt.json', import.meta.url);

function lokalniDatabaze() {
  const url = process.env.DATABASE_URL || '';
  const host = url ? new URL(url).hostname : '';
  if (!['127.0.0.1', 'localhost'].includes(host) && process.env.TEST_DB_ALLOW_REMOTE !== '1') {
    throw new Error(`Test zakládá objednávky a doklady — DATABASE_URL musí mířit na 127.0.0.1/localhost, ne na "${host}"`);
  }
  return url;
}

let sql;
const uklid = { orders: [], emails: [], shops: [] };

// ── Scénář ─────────────────────────────────────────────────────

/**
 * Projde API s předponou `prefix` a klíčem `key`; vrací seznam kroků
 * `{ krok, status, body }` s neupravenými odpověďmi. `run` odliší e-maily
 * běhu, aby se scénář dal pustit opakovaně proti téže databázi.
 */
async function scenar(prefix, key, run) {
  const kroky = [];
  const mail = `kontrakt-${run}@example.invalid`;
  uklid.emails.push(mail);

  async function volej(krok, method, path, body, { bezKlice = false } = {}) {
    const headers = {};
    if (!bezKlice) headers.authorization = `Bearer ${key}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${BASE}${prefix}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    kroky.push({ krok, status: res.status, body: data });
    return data;
  }

  const zakaznik = {
    firstName: 'Jana', lastName: 'Kontraktová', email: mail, phone: '+420777123456',
    company: '', ic: '', dic: '', address: 'Dělnická 12', city: 'Praha', zip: '17000', stat: 'Česká republika',
  };
  const doprava = { method: 'Zásilkovna', pickupPointId: '4321', pickupPointName: 'Z-BOX Praha 7, Dělnická' };
  const polozky = [
    { sku: 'K-1', supplierCode: ' 11208 ', name: 'Položka jedna', quantity: 2, price: 149.4, productId: 'rec1' },
    { sku: 'DOPRAVA', name: 'Doprava', quantity: 1, price: 79 },
  ];

  // Uživatelé
  await volej('uživatel neexistuje', 'GET', `/users?email=${encodeURIComponent(mail)}`);
  const user = await volej('registrace', 'POST', '/users', {
    email: mail, jmeno: 'Jana', prijmeni: 'Kontraktová', telefon: '777123456', firma: 'Firma s.r.o.',
    ulice: 'Dělnická 12', mesto: 'Praha', psc: '17000', souhlasMarketing: true, souhlasGdpr: true,
  });
  await volej('registrace podruhé', 'POST', '/users', { email: mail, jmeno: 'X' });
  await volej('uživatel podle e-mailu', 'GET', `/users?email=${encodeURIComponent(mail)}`);
  await volej('úprava uživatele', 'PATCH', `/users/${user.id}`, {
    poznamka: 'PWDHASH:kontrakt', telefon: '999888777', souhlasNotifikace: true,
    posledniPrihlaseni: '2026-10-25T10:00:00.000Z',
  });
  await volej('uživatel s poznámkou', 'GET', `/users?email=${encodeURIComponent(mail.toUpperCase())}&withNote=1`);
  await volej('uživatel podle id', 'GET', `/users/${user.id}`);
  await volej('úprava bez polí', 'PATCH', `/users/${user.id}`, {});
  await volej('neznámé id', 'GET', '/users/neexistuje');
  await volej('uživatel bez e-mailu', 'GET', '/users');
  await volej('registrace bez e-mailu', 'POST', '/users', {});

  // Objednávky
  const prevod = await volej('objednávka převodem', 'POST', '/orders', {
    customer: zakaznik, shipping: doprava, paymentMethod: 'transfer', items: polozky,
    totalPrice: 377.8, ipAddress: '192.0.2.10', isRegistered: true,
  });
  const karta = await volej('objednávka kartou', 'POST', '/orders', {
    customer: zakaznik, shipping: doprava, paymentMethod: 'card', status: 'Čeká na platbu',
    items: polozky, totalPrice: 377.8,
  });
  const dobirka = await volej('objednávka na dobírku', 'POST', '/orders', {
    customer: { ...zakaznik, company: '' }, shipping: doprava, paymentMethod: 'cod', items: polozky, totalPrice: 417.8,
  });
  for (const o of [prevod, karta, dobirka]) if (o?.orderId) uklid.orders.push(o.orderId);
  await volej('objednávka bez dat', 'POST', '/orders', {});

  await volej('seznam objednávek', 'GET', `/orders?email=${encodeURIComponent(mail)}`);
  await volej('seznam bez e-mailu', 'GET', '/orders');
  await volej('detail objednávky', 'GET', `/orders/by-number/${prevod.orderNumber}?email=${encodeURIComponent(mail)}`);
  await volej('detail s cizím e-mailem', 'GET', `/orders/by-number/${prevod.orderNumber}?email=cizi@example.invalid`);
  await volej('detail neexistující', 'GET', '/orders/by-number/00000000');

  await volej('platební údaje', 'GET', `/orders/${prevod.orderId}/payment-details`);
  await volej('platební údaje s PDF', 'GET', `/orders/${prevod.orderId}/payment-details?pdf=1`);
  await volej('platební údaje u karty', 'GET', `/orders/${karta.orderId}/payment-details`);
  await volej('platební údaje neexistující', 'GET', '/orders/neexistuje/payment-details');

  await volej('zaplaceno', 'PATCH', `/orders/${karta.orderId}/payment-status`, { status: 'Zaplaceno' });
  await volej('stav platby bez stavu', 'PATCH', `/orders/${karta.orderId}/payment-status`, {});
  await volej('stav platby neexistující', 'PATCH', '/orders/neexistuje/payment-status', { status: 'Zaplaceno' });
  await volej('přepnutí na převod', 'PATCH', `/orders/${karta.orderId}/payment-method`,
    { paymentMethod: 'transfer', totalPrice: 340.4, status: 'Přijata' });
  await volej('přepnutí na nesmysl', 'PATCH', `/orders/${karta.orderId}/payment-method`, { paymentMethod: 'bitcoin' });
  await volej('přepnutí neexistující', 'PATCH', '/orders/neexistuje/payment-method', { paymentMethod: 'cod' });
  await volej('tracking', 'PATCH', `/orders/${karta.orderId}/tracking`, { trackingNumber: 'Z1112223334', labelUrl: '' });
  await volej('tracking neexistující', 'PATCH', '/orders/neexistuje/tracking', { trackingNumber: 'Z1' });
  await volej('detail po změnách', 'GET', `/orders/by-number/${karta.orderNumber}?email=${encodeURIComponent(mail)}`);
  await volej('platební údaje po přepnutí', 'GET', `/orders/${karta.orderId}/payment-details`);

  await volej('bez klíče', 'GET', `/orders?email=${encodeURIComponent(mail)}`, undefined, { bezKlice: true });

  return { kroky, run };
}

// ── Normalizace ────────────────────────────────────────────────

const ID_KLICE = new Set(['id', 'orderId', 'order_id', 'crm_contact_id', 'crm_company_id', 'shop_id',
  'warehouse_dispatch_id', 'warehouse_sent_by']);
const CASY = new Set(['created_at', 'modified_at', 'paid_at', 'datumRegistrace', 'warehouse_sent_at']);

/**
 * Nahradí hodnoty, které se mezi běhy a mezi e-shopy liší, zástupnými
 * značkami. Před nahrazením ověří tvar — čísla objednávek jen z číslic,
 * časy parsovatelné, variabilní symbol z čísla objednávky —, takže se tím
 * neschová rozbitá hodnota.
 */
function normalizuj({ kroky, run }) {
  const cislaObjednavek = new Set();

  function hodnota(klic, v, rodic) {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map((x) => hodnota(null, x, v));
    if (typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hodnota(k, x, v)]));
    }
    if (ID_KLICE.has(klic)) return '<id>';
    if (klic === 'orderNumber' || klic === 'order_number') {
      assert.match(String(v), /^\d+$/, 'číslo objednávky jen z číslic');
      cislaObjednavek.add(String(v));
      return '<cislo-objednavky>';
    }
    if (CASY.has(klic)) {
      assert.ok(!Number.isNaN(Date.parse(v)), `${klic} je čas`);
      return '<cas>';
    }
    if (klic === 'dueDate') {
      assert.ok(!Number.isNaN(Date.parse(v)), 'dueDate je datum');
      return '<datum>';
    }
    if (klic === 'variableSymbol') {
      assert.ok(cislaObjednavek.has(String(v)), 'variabilní symbol zálohovky = číslo objednávky');
      return '<vs>';
    }
    if (klic === 'proformaNumber') return '<cislo-zalohovky>';
    if (klic === 'filename' && rodic?.contentBase64 !== undefined) return 'zalohova-faktura-<cislo-zalohovky>.pdf';
    if (klic === 'contentBase64') {
      assert.equal(Buffer.from(v, 'base64').subarray(0, 5).toString(), '%PDF-', 'PDF zálohovky');
      return '<pdf>';
    }
    if (typeof v === 'string') return v.split(run).join('<run>');
    return v;
  }

  return kroky.map(({ krok, status, body }) => ({ krok, status, body: hodnota(null, body, null) }));
}

// ── Testy ──────────────────────────────────────────────────────

before(async () => {
  sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
  const health = await fetch(BASE + '/health').catch(() => null);
  assert.ok(health?.ok, `server neběží na ${BASE}`);
  assert.ok(TONERACEK_KEY, 'chybí TONERACEK_API_KEY (stejný, jaký má server)');
});

after(async () => {
  if (!sql) return;
  const orders = uklid.orders.length ? uklid.orders : [''];
  await sql`DELETE FROM accounting_invoices WHERE order_id = ANY(${orders})`;
  await sql`DELETE FROM shop_orders WHERE id = ANY(${orders})`;
  if (uklid.emails.length) await sql`DELETE FROM crm_contacts WHERE LOWER(email) = ANY(${uklid.emails})`;
  if (uklid.shops.length) {
    await sql`DELETE FROM accounting_invoices WHERE shop_id = ANY(${uklid.shops})`;
    await sql`DELETE FROM shop_orders WHERE shop_id = ANY(${uklid.shops})`;
    await sql`DELETE FROM invoice_number_series WHERE shop_id = ANY(${uklid.shops})`;
    await sql`DELETE FROM shops WHERE id = ANY(${uklid.shops})`;
  }
  await sql.end();
});

describe('kontrakt /api/toneracek', () => {
  test(ZAPSAT ? 'zápis vzoru z běžícího serveru' : 'odpovědi jsou stejné jako na main', async () => {
    const vysledek = normalizuj(await scenar('/api/toneracek', TONERACEK_KEY, crypto.randomBytes(4).toString('hex')));
    if (ZAPSAT) {
      writeFileSync(VZOR, JSON.stringify(vysledek, null, 2) + '\n');
      return;
    }
    const vzor = JSON.parse(readFileSync(VZOR, 'utf8'));
    assert.deepEqual(vysledek, vzor);
  });
});

describe('kontrakt /api/eshop', { skip: ZAPSAT && 'main /api/eshop nemá' }, () => {
  test('odpovídá stejně jako /api/toneracek', async () => {
    const r = crypto.randomBytes(4).toString('hex');
    const [shop] = await sql`
      INSERT INTO shops (slug, name, url, email_from_name, email_from_address)
      VALUES (${`test-kontrakt-${r}`}, ${`Kontrakt ${r}`}, 'https://example.invalid', 'Kontrakt', 'noreply@example.invalid')
      RETURNING id`;
    uklid.shops.push(shop.id);
    const klic = crypto.randomBytes(32).toString('hex');
    await sql`INSERT INTO eshop_api_keys (shop_id, key_hash) VALUES (${shop.id}, ${crypto.createHash('sha256').update(klic).digest('hex')})`;
    await sql`
      INSERT INTO invoice_number_series (name, prefix, format, current_number, start_number, padding, shop_id, entity_type, active)
      VALUES (${`Obj ${r}`}, '', '6YYNNNNN', 0, 1, 4, ${shop.id}, 'objednavka', TRUE),
             (${`ZF ${r}`}, '', ${`ZK${r}-NNNN`}, 0, 1, 4, ${shop.id}, 'zalohova_faktura', TRUE),
             (${`FV ${r}`}, '', ${`FK${r}-NNNN`}, 0, 1, 4, ${shop.id}, 'faktura', TRUE)`;

    const vysledek = normalizuj(await scenar('/api/eshop', klic, crypto.randomBytes(4).toString('hex')));
    const vzor = JSON.parse(readFileSync(VZOR, 'utf8'));
    assert.deepEqual(vysledek, vzor);
  });
});
