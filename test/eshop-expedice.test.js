// Podání balíku u e-shopu podepsané tajemstvím TOHO e-shopu.
//
// Dřív jedno globální SHOP_WEBHOOK_SECRET pro všechny e-shopy — Dílna by
// musela znát tajemství Toneráčku. Teď shops.webhook_secret, prázdné =
// globální (Toneráček jede dál na globálním).
//
// Potřebuje databázi, běžící server ne. „E-shop“ je lokální HTTP server na
// 127.0.0.1, ven nejde nic.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… node --test test/eshop-expedice.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import postgres from 'postgres';

function lokalniDatabaze() {
  const url = process.env.DATABASE_URL || '';
  const host = url ? new URL(url).hostname : '';
  if (!['127.0.0.1', 'localhost'].includes(host) && process.env.TEST_DB_ALLOW_REMOTE !== '1') {
    throw new Error(`Test zakládá e-shopy — DATABASE_URL musí mířit na 127.0.0.1/localhost, ne na "${host}"`);
  }
  return url;
}

const r = crypto.randomBytes(4).toString('hex');
const SECRET_ESHOPU = crypto.randomBytes(32).toString('hex');
const SECRET_GLOBALNI = `globalni-${crypto.randomBytes(16).toString('hex')}`;

let sql, server, url, expedice;
const prijate = [];
const shops = {};
const puvodniEnv = process.env.SHOP_WEBHOOK_SECRET;

before(async () => {
  lokalniDatabaze();
  sql = postgres(process.env.DATABASE_URL, { max: 2, onnotice: () => {} });
  expedice = await import('../src/expedice.js');

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      prijate.push({ url: req.url, secret: req.headers['x-webhook-secret'], body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tracking: 'Z9876543210', uzPodano: false }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${server.address().port}`;

  for (const [klic, secret] of [['vlastni', SECRET_ESHOPU], ['bez', '']]) {
    const [s] = await sql`
      INSERT INTO shops (slug, name, url, webhook_secret)
      VALUES (${`test-exp-${klic}-${r}`}, ${`Test expedice ${klic} ${r}`}, ${url}, ${secret})
      RETURNING *`;
    shops[klic] = s;
  }
});

after(async () => {
  if (puvodniEnv === undefined) delete process.env.SHOP_WEBHOOK_SECRET;
  else process.env.SHOP_WEBHOOK_SECRET = puvodniEnv;
  await new Promise((ok) => server?.close(ok));
  if (sql) {
    await sql`DELETE FROM shops WHERE id = ANY(${Object.values(shops).map((s) => s.id)})`;
    await sql.end();
  }
  const { closeAll } = await import('../src/db.js');
  await closeAll();
});

describe('tajemství pro podání balíku', () => {
  test('vlastní tajemství e-shopu má přednost před globálním', async () => {
    process.env.SHOP_WEBHOOK_SECRET = SECRET_GLOBALNI;
    assert.equal(await expedice.webhookSecretEshopu(shops.vlastni.id), SECRET_ESHOPU);
    assert.equal(await expedice.webhookSecretEshopu(shops.bez.id), SECRET_GLOBALNI, 'prázdné = globální');
    assert.equal(await expedice.webhookSecretEshopu(null), SECRET_GLOBALNI);
  });

  test('žádost o balík nese tajemství e-shopu objednávky', async () => {
    process.env.SHOP_WEBHOOK_SECRET = SECRET_GLOBALNI;
    prijate.length = 0;
    const brand = { id: shops.vlastni.id, url };
    const vysledek = await expedice.pozadejEshopOPodaniBaliku(null, brand,
      { shop_id: shops.vlastni.id, order_number: '70000001', email: 'x@example.invalid' });
    assert.deepEqual(vysledek, { ok: true, httpStatus: 200, tracking: 'Z9876543210', uzPodano: false });
    assert.equal(prijate.length, 1);
    assert.equal(prijate[0].url, '/api/orders/podat-balik');
    assert.equal(prijate[0].secret, SECRET_ESHOPU);
    assert.deepEqual(prijate[0].body, { orderNumber: '70000001', email: 'x@example.invalid' });
  });

  test('e-shop bez vlastního tajemství (Toneráček) jede na globálním jako dřív', async () => {
    process.env.SHOP_WEBHOOK_SECRET = SECRET_GLOBALNI;
    prijate.length = 0;
    await expedice.pozadejEshopOPodaniBaliku(null, { id: shops.bez.id, url },
      { shop_id: shops.bez.id, order_number: '10001', email: 'x@example.invalid' });
    assert.equal(prijate[0].secret, SECRET_GLOBALNI);
  });

  test('bez jakéhokoli tajemství se nic neodešle', async () => {
    delete process.env.SHOP_WEBHOOK_SECRET;
    prijate.length = 0;
    const vysledek = await expedice.pozadejEshopOPodaniBaliku(null, { id: shops.bez.id, url },
      { shop_id: shops.bez.id, order_number: '10002', email: 'x@example.invalid' });
    assert.equal(vysledek.ok, false);
    assert.equal(prijate.length, 0);
  });
});
