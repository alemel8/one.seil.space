// Podání balíku u e-shopu podepsané tajemstvím TOHO e-shopu.
//
// Dřív jedno globální SHOP_WEBHOOK_SECRET pro všechny e-shopy — Dílna by
// musela znát tajemství Toneráčku. Teď: Toneráček jen globální (sloupec
// shops.webhook_secret se u něj nečte), ostatní e-shopy jen vlastní
// shops.webhook_secret. Bez něj se jejich balík nepodá — globální jim
// nikdy nejde, ani když se tajemství nepodaří načíst.
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

let sql, server, url, expedice, toneracek;
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
  [toneracek] = await sql`SELECT * FROM shops WHERE slug = 'toneracek'`;
  assert.ok(toneracek, 'migrace 030 zakládá e-shop toneracek');
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
  test('Toneráček jen globální, ostatní e-shopy jen vlastní', async () => {
    process.env.SHOP_WEBHOOK_SECRET = SECRET_GLOBALNI;
    assert.equal(await expedice.webhookSecretEshopu(shops.vlastni.id), SECRET_ESHOPU);
    assert.equal(await expedice.webhookSecretEshopu(shops.bez.id), '',
      'jiný e-shop bez vlastního tajemství globální (= Toneráčku) nedostane');
    assert.equal(await expedice.webhookSecretEshopu(null), '');
    assert.equal(await expedice.webhookSecretEshopu(toneracek.id), SECRET_GLOBALNI);
    assert.equal(await expedice.webhookSecretEshopu(toneracek.id, null, { id: toneracek.id, slug: 'toneracek' }),
      SECRET_GLOBALNI, 'se značkou Toneráčku bez dotazu do databáze');
    assert.equal(await expedice.webhookSecretEshopu(shops.bez.id, null, { id: toneracek.id, slug: 'toneracek' }), '',
      'značka jiného e-shopu, než je objednávka, nic neotevře');
  });

  test('když se tajemství nepodaří načíst, jiný e-shop nedostane nic', async () => {
    process.env.SHOP_WEBHOOK_SECRET = SECRET_GLOBALNI;
    // Nečíselné id shodí dotaz — stejná cesta jako výpadek databáze.
    assert.equal(await expedice.webhookSecretEshopu('neni-cislo'), '');
  });

  test('Toneráček vlastní tajemství z databáze nepoužije', async () => {
    process.env.SHOP_WEBHOOK_SECRET = SECRET_GLOBALNI;
    const puvodni = toneracek.webhook_secret ?? '';
    try {
      await sql`UPDATE shops SET webhook_secret = ${'e'.repeat(40)} WHERE id = ${toneracek.id}`;
      assert.equal(await expedice.webhookSecretEshopu(toneracek.id), SECRET_GLOBALNI);
    } finally {
      await sql`UPDATE shops SET webhook_secret = ${puvodni} WHERE id = ${toneracek.id}`;
    }
  });

  test('žádost o balík nese tajemství e-shopu objednávky', async () => {
    process.env.SHOP_WEBHOOK_SECRET = SECRET_GLOBALNI;
    prijate.length = 0;
    const brand = { id: shops.vlastni.id, slug: shops.vlastni.slug, url };
    const vysledek = await expedice.pozadejEshopOPodaniBaliku(null, brand,
      { shop_id: shops.vlastni.id, order_number: '70000001', email: 'x@example.invalid' });
    assert.deepEqual(vysledek, { ok: true, httpStatus: 200, tracking: 'Z9876543210', uzPodano: false });
    assert.equal(prijate.length, 1);
    assert.equal(prijate[0].url, '/api/orders/podat-balik');
    assert.equal(prijate[0].secret, SECRET_ESHOPU);
    assert.deepEqual(prijate[0].body, { orderNumber: '70000001', email: 'x@example.invalid' });
  });

  test('Toneráček jede na globálním jako dřív', async () => {
    process.env.SHOP_WEBHOOK_SECRET = SECRET_GLOBALNI;
    prijate.length = 0;
    await expedice.pozadejEshopOPodaniBaliku(null, { id: toneracek.id, slug: 'toneracek', url },
      { shop_id: toneracek.id, order_number: '10001', email: 'x@example.invalid' });
    assert.equal(prijate.length, 1);
    assert.equal(prijate[0].secret, SECRET_GLOBALNI);
  });

  test('e-shop bez vlastního tajemství nic neodešle, ani s globálním v prostředí', async () => {
    process.env.SHOP_WEBHOOK_SECRET = SECRET_GLOBALNI;
    prijate.length = 0;
    const vysledek = await expedice.pozadejEshopOPodaniBaliku(null, { id: shops.bez.id, slug: shops.bez.slug, url },
      { shop_id: shops.bez.id, order_number: '10002', email: 'x@example.invalid' });
    assert.deepEqual(vysledek, { ok: false, error: 'E-shop nemá tajemství pro podání balíku' });
    assert.equal(prijate.length, 0);
  });

  test('bez SHOP_WEBHOOK_SECRET se balík Toneráčku nepodá', async () => {
    delete process.env.SHOP_WEBHOOK_SECRET;
    prijate.length = 0;
    const vysledek = await expedice.pozadejEshopOPodaniBaliku(null, { id: toneracek.id, slug: 'toneracek', url },
      { shop_id: toneracek.id, order_number: '10003', email: 'x@example.invalid' });
    assert.deepEqual(vysledek, { ok: false, error: 'SHOP_WEBHOOK_SECRET není nastaveno' });
    assert.equal(prijate.length, 0);
  });
});
