// Test výběru objednávek k expedici a zámků běhu — potřebuje databázi,
// běžící server ne:
//
//   DATABASE_URL=postgresql://… node --test test/expedice-db.test.js
//
// Testuje se proti databázi z .env stejně jako test/finance.test.js. Zakládá
// si vlastní e-shop s náhodným slugem a po sobě ho uklidí — nikdy nesahá na
// data, která nevytvořil.
// Hlídá dvě věci, které by v provozu bolely nejvíc: aby se skladu neposlala
// nezaplacená objednávka, a aby dva souběžné běhy nikdy neodeslaly totéž
// dvakrát.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import {
  ExpediceBeziError, najdiObjednavkyKExpedici, prevezmiBeh, zalozBeh,
} from '../src/expedice.js';

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  onnotice: () => {},
});

const r = crypto.randomBytes(4).toString('hex');
const SLUG = `test-expedice-${r}`;
let shop;

/** Objednávka s rozumnými výchozími hodnotami; `over` přepíše, co je potřeba. */
async function objednavka(cislo, over = {}) {
  const o = {
    payment_method: 'Platba kartou', status: 'Zaplaceno', tracking_number: '',
    pickup_point_id: '123', created_at: new Date(), ...over,
  };
  const id = `TEST-EXP-${r}-${cislo}`;
  await sql`
    INSERT INTO shop_orders (id, shop_id, order_number, status, payment_method,
                             tracking_number, pickup_point_id, created_at)
    VALUES (${id}, ${shop.id}, ${cislo}, ${o.status}, ${o.payment_method},
            ${o.tracking_number}, ${o.pickup_point_id}, ${o.created_at})`;
  if (o.proforma) {
    await sql`
      INSERT INTO accounting_invoices (id, type, status, order_id, shop_id)
      VALUES (${`TEST-EXP-P-${r}-${cislo}`}, 'proforma', ${o.proforma}, ${id}, ${shop.id})`;
  }
  return id;
}

before(async () => {
  [shop] = await sql`
    INSERT INTO shops (slug, name, url, active, warehouse_email, warehouse_dispatch_since)
    VALUES (${SLUG}, 'Test expedice', 'https://example.invalid', TRUE,
            'sklad@example.invalid', '2026-01-01')
    RETURNING *`;
});

after(async () => {
  await sql`DELETE FROM accounting_invoices WHERE shop_id = ${shop.id}`;
  await sql`DELETE FROM warehouse_dispatches WHERE shop_id = ${shop.id}`;
  await sql`DELETE FROM shop_orders WHERE shop_id = ${shop.id}`;
  await sql`DELETE FROM shops WHERE id = ${shop.id}`;
  await sql.end();
});

describe('kdo patří do ranní expedice', () => {
  test('vybere se přesně to, co je zaplacené a sklad to ještě nemá', async () => {
    const ma = [
      await objednavka('K-ZAPLACENO'),
      await objednavka('K-VYRIZENA', { status: 'Vyřízena' }),
      // Obsluha může stav v administraci přepsat; u karty pak platí, že
      // e-shop podává balík až po potvrzené platbě Stripem.
      await objednavka('K-PRIJATA-TRACKING', { status: 'Přijata', tracking_number: 'Z864684' }),
      await objednavka('P-ZAPLACENA', { payment_method: 'Bankovní převod', status: 'Přijata', proforma: 'Zaplacena' }),
      await objednavka('DOBIRKA', { payment_method: 'Dobírka', status: 'Přijata', tracking_number: 'Z864685' }),
    ];
    const nema = [
      await objednavka('K-PRIJATA', { status: 'Přijata' }),
      await objednavka('K-CEKA', { status: 'Čeká na platbu' }),
      await objednavka('K-NEZDARILA', { status: 'Platba se nezdařila', tracking_number: 'Z864686' }),
      await objednavka('STORNO', { status: 'Stornována' }),
      // Balík u převodu vzniká i po neúspěšné kartě, dokud je nezaplaceno
      await objednavka('P-NEZAPLACENA', { payment_method: 'Bankovní převod', status: 'Přijata', tracking_number: 'Z864687', proforma: 'Nezaplacena' }),
      // Upomínkový worker přepíše nezaplacenou zálohovku na „Po splatnosti"
      await objednavka('P-PO-SPLATNOSTI', { payment_method: 'Bankovní převod', status: 'Přijata', proforma: 'Po splatnosti' }),
      await objednavka('STARA', { created_at: new Date('2025-06-01') }),
    ];

    const vybrane = (await najdiObjednavkyKExpedici(sql, shop)).map(o => o.id);
    for (const id of ma)   assert.ok(vybrane.includes(id), `chybí ${id}`);
    for (const id of nema) assert.ok(!vybrane.includes(id), `nemá tam být ${id}`);
  });

  test('orazítkovaná objednávka se skladu neposílá znovu', async () => {
    const id = await objednavka('ORAZITKOVANA');
    await sql`UPDATE shop_orders SET warehouse_sent_at = NOW() WHERE id = ${id}`;
    const vybrane = (await najdiObjednavkyKExpedici(sql, shop)).map(o => o.id);
    assert.ok(!vybrane.includes(id));
  });

  test('seznam objednávek zná stav skladu', async () => {
    const radky = await najdiObjednavkyKExpedici(sql, shop);
    assert.ok(radky.length > 0);
    assert.ok(radky.every(r => r.sklad_stav === 'ceka'),
      'co čeká na expedici, musí mít v seznamu stav „ceka"');
  });
});

describe('zámky běhu', () => {
  const den = '2026-09-07';

  test('druhý automatický běh téhož dne se nezaloží', async () => {
    const prvni = await zalozBeh(sql, { shop, kind: 'auto', runDate: den });
    assert.ok(prvni, 'první běh se má založit');
    const druhy = await zalozBeh(sql, { shop, kind: 'auto', runDate: den });
    assert.equal(druhy, null, 'druhý běh nesmí vzniknout');
    await sql`UPDATE warehouse_dispatches SET status = 'odeslano' WHERE id = ${prvni.id}`;
  });

  test('ruční běh během rozběhnutého skončí srozumitelnou chybou', async () => {
    const bezici = await zalozBeh(sql, { shop, kind: 'rucni', runDate: den });
    await assert.rejects(
      () => zalozBeh(sql, { shop, kind: 'rucni', runDate: den }),
      ExpediceBeziError);
    await sql`UPDATE warehouse_dispatches SET status = 'chyba' WHERE id = ${bezici.id}`;
  });

  test('opakování po chybě zabere řádek jen jednou', async () => {
    const [chybny] = await sql`
      INSERT INTO warehouse_dispatches (shop_id, kind, run_date, status, attempt, started_at)
      VALUES (${shop.id}, 'rucni', ${den}, 'chyba', 1, NOW() - INTERVAL '20 minutes')
      RETURNING *`;
    const prvni = await prevezmiBeh(sql, chybny);
    assert.ok(prvni, 'první pokus řádek zabere');
    assert.equal(prvni.attempt, 2, 'pokus se počítá');
    assert.equal(await prevezmiBeh(sql, chybny), null, 'podruhé už není co zabrat');
    await sql`UPDATE warehouse_dispatches SET status = 'odeslano' WHERE id = ${chybny.id}`;
  });
});
