// Sledování zásilek a vyřízení objednávky po převzetí – potřebuje databázi,
// běžící server ne:
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… node --test test/sledovani-zasilek-db.test.js
//
// Zásilkovna, e-mail zákazníkovi i push jsou podstrčené, takže se nikam nic
// neposílá. Zakládá si vlastní e-shop s náhodným slugem a po sobě ho uklidí.
//
// Hlídá hlavně dvě věci: aby se objednávka vyřídila až po skutečném převzetí
// balíku, a aby souběh automatu s obsluhou nikdy nevystavil dvě faktury ani
// neposlal zákazníkovi dva e-maily.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { najdiSledovaneZasilky, tikSledovaniZasilek } from '../src/sledovani-zasilek.js';
import { vyridObjednavku } from '../src/vyrizeni-objednavky.js';
import { closeAll } from '../src/db.js';

const url = process.env.DATABASE_URL ?? '';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  throw new Error('Test zakládá a maže objednávky – pusť ho jen proti lokální databázi');
}

const sql = postgres(url, { onnotice: () => {} });
const r = crypto.randomBytes(4).toString('hex');
const SLUG = `test-zasilky-${r}`;
const HODINA = 3_600_000;
// Čísla zásilek tohoto běhu. Podstrčená Zásilkovna na cizí čísla odpoví
// chybou, takže tik nevyřídí objednávku, kterou test nezaložil.
const PREFIX_ZASILKY = `Z${String(parseInt(r, 16) % 1_000_000).padStart(6, '0')}`;
let shop;
let poradi = 0;

/** Objednávka odeslaná do skladu; `over` přepíše, co je potřeba. */
async function objednavka(over = {}) {
  poradi += 1;
  const o = {
    payment_method: 'Platba kartou', status: 'Zaplaceno', tracking_number: `${PREFIX_ZASILKY}${String(poradi).padStart(4, '0')}`,
    warehouse_sent_at: new Date(Date.now() - 2 * HODINA), email: 'zakaznik@example.invalid',
    packet_status: '', packet_checked_at: null, auto_fulfilled_at: null, ...over,
  };
  const id = `TEST-ZAS-${r}-${poradi}`;
  await sql`
    INSERT INTO shop_orders (id, shop_id, order_number, status, payment_method, tracking_number,
                             pickup_point_id, email, first_name, last_name, total_price, paid_at,
                             warehouse_sent_at, packet_status, packet_checked_at, auto_fulfilled_at, created_at)
    VALUES (${id}, ${shop.id}, ${`ZAS${r}${poradi}`}, ${o.status}, ${o.payment_method}, ${o.tracking_number},
            '123', ${o.email}, 'Jan', 'Test', 1210, ${new Date(Date.now() - 24 * HODINA)},
            ${o.warehouse_sent_at}, ${o.packet_status}, ${o.packet_checked_at}, ${o.auto_fulfilled_at},
            ${new Date(Date.now() - 24 * HODINA)})`;
  if (o.proforma) {
    await sql`
      INSERT INTO accounting_invoices (id, type, status, order_id, shop_id)
      VALUES (${`TEST-ZAS-P-${r}-${poradi}`}, 'proforma', ${o.proforma}, ${id}, ${shop.id})`;
  }
  return id;
}

/** Zásilkovna, která na všechno odpoví zadaným stavem (nebo chybou). */
function zasilkovna(stavy) {
  const dotazy = [];
  const nactiStav = async (cislo) => {
    dotazy.push(cislo);
    const stav = typeof stavy === 'function' ? stavy(cislo) : stavy;
    if (stav instanceof Error) throw stav;
    return { codeText: stav, statusText: `popis ${stav}`, dateTime: new Date('2026-11-18T13:02:00Z'), isReturning: false };
  };
  return { nactiStav, dotazy };
}

/** Podstrčené doručení faktury: zapíše si, komu by šla. */
function posta({ selze = false } = {}) {
  const odeslane = [];
  const odesliFakturu = async (_sql, order, invoice) => {
    if (selze) throw new Error('Resend nedostupný');
    odeslane.push({ order: order.id, invoice: invoice.id, tracking: order.tracking_number });
  };
  return { odesliFakturu, odeslane };
}

function tik({ stav, post = posta(), pushe = [] } = {}) {
  const z = zasilkovna(stav);
  return tikSledovaniZasilek(null, {
    sql,
    nactiStav: async (c) => (c.startsWith(PREFIX_ZASILKY) ? z.nactiStav(c) : Promise.reject(new Error('cizí zásilka'))),
    vyrid: (s, log, id, opts) => vyridObjednavku(s, log, id, { ...opts, odesliFakturu: post.odesliFakturu }),
    notify: async (payload) => { pushe.push(payload); },
  }).then(v => ({ ...v, dotazy: z.dotazy, post, pushe }));
}

async function radek(id) {
  const [o] = await sql`SELECT * FROM shop_orders WHERE id = ${id}`;
  const faktury = await sql`SELECT id, status FROM accounting_invoices WHERE order_id = ${id} AND type = 'issued'`;
  return { ...o, faktury };
}

/** Výběr jen z objednávek tohoto testu – databáze může nést cizí data. */
async function vybraneIds() {
  const vse = await najdiSledovaneZasilky(sql, { davka: 1000 });
  return vse.filter(x => x.id.startsWith(`TEST-ZAS-${r}-`)).map(x => x.id);
}

before(async () => {
  [shop] = await sql`
    INSERT INTO shops (slug, name, url, active, warehouse_email, warehouse_dispatch_since)
    VALUES (${SLUG}, 'Test zásilky', 'https://example.invalid', TRUE, 'sklad@example.invalid', '2026-01-01')
    RETURNING *`;
});

// Každý test si zakládá vlastní objednávky; staré by se mu pletly do výběru.
beforeEach(async () => {
  await sql`DELETE FROM accounting_invoice_items WHERE invoice_id IN (SELECT id FROM accounting_invoices WHERE shop_id = ${shop.id})`;
  await sql`DELETE FROM accounting_invoices WHERE shop_id = ${shop.id}`;
  await sql`DELETE FROM shop_orders WHERE shop_id = ${shop.id}`;
});

after(async () => {
  await sql`DELETE FROM notification_log WHERE event_type = 'vyrizeni_po_prevzeti' AND event_key LIKE ${`TEST-ZAS-${r}-%`}`;
  await sql`DELETE FROM accounting_invoice_items WHERE invoice_id IN (SELECT id FROM accounting_invoices WHERE shop_id = ${shop.id})`;
  await sql`DELETE FROM accounting_invoices WHERE shop_id = ${shop.id}`;
  await sql`DELETE FROM shop_orders WHERE shop_id = ${shop.id}`;
  await sql`DELETE FROM shops WHERE id = ${shop.id}`;
  await sql.end();
  await closeAll();
});

describe('na které zásilky se ptát', () => {
  test('jen odeslané do skladu, nevyřízené, s číslem zásilky a bez faktury', async () => {
    const ano = [
      await objednavka(),
      await objednavka({ status: 'Přijata', payment_method: 'Dobírka' }),
      await objednavka({ packet_status: 'received data', packet_checked_at: new Date(Date.now() - 31 * 60_000) }),
    ];
    const ne = [
      await objednavka({ warehouse_sent_at: null }),
      await objednavka({ status: 'Vyřízena' }),
      await objednavka({ status: 'Stornována' }),
      await objednavka({ tracking_number: '' }),
      // Sleduje se jen čtrnáct dní po odeslání.
      await objednavka({ warehouse_sent_at: new Date(Date.now() - 15 * 24 * HODINA) }),
      // Na tutéž zásilku nejvýš jednou za půl hodiny.
      await objednavka({ packet_status: 'received data', packet_checked_at: new Date(Date.now() - 10 * 60_000) }),
      // Zrušená zásilka se už nezmění.
      await objednavka({ packet_status: 'cancelled' }),
      // Automat ji už jednou vyřídil a člověk ji vrátil – nepřepisovat ho.
      await objednavka({ status: 'Přijata', auto_fulfilled_at: new Date() }),
    ];
    const sFakturou = await objednavka();
    await sql`
      INSERT INTO accounting_invoices (id, type, number, status, order_id, shop_id)
      VALUES (${`TEST-ZAS-F-${r}`}, 'issued', ${`TESTZAS-${r}`}, 'Zaplacena', ${sFakturou}, ${shop.id})`;
    ne.push(sFakturou);

    const vybrane = await vybraneIds();
    for (const id of ano) assert.ok(vybrane.includes(id), `má se sledovat: ${id}`);
    for (const id of ne) assert.ok(!vybrane.includes(id), `nemá se sledovat: ${id}`);
  });
});

describe('vyřízení po převzetí', () => {
  test('dokud má Zásilkovna jen data, nic se nevyřizuje – jen se zapíše stav', async () => {
    const id = await objednavka();
    const v = await tik({ stav: 'received data' });

    const o = await radek(id);
    assert.equal(o.status, 'Zaplaceno');
    assert.equal(o.packet_status, 'received data');
    assert.equal(o.packet_status_text, 'popis received data');
    assert.ok(o.packet_checked_at);
    assert.equal(o.faktury.length, 0);
    assert.equal(v.post.odeslane.length, 0);
    // Druhý tik hned potom se na ni neptá.
    const znovu = await tik({ stav: 'received data' });
    assert.equal(znovu.dotazy.length, 0);
  });

  test('převzatý balík: faktura, jeden e-mail se sledovacím číslem a stav Vyřízena', async () => {
    const id = await objednavka();
    const v = await tik({ stav: 'arrived' });

    const o = await radek(id);
    assert.equal(o.status, 'Vyřízena');
    assert.ok(o.auto_fulfilled_at, 'vyřízení automatem je poznat');
    assert.equal(o.auto_fulfill_error, '');
    assert.equal(o.faktury.length, 1);
    assert.equal(o.faktury[0].status, 'Zaplacena');
    assert.deepEqual(v.post.odeslane, [{ order: id, invoice: o.faktury[0].id, tracking: o.tracking_number }]);
    assert.equal(v.pushe.length, 0, 'když se všechno povede, nebzučí');

    // Vyřízená objednávka už sledovaná není, druhý e-mail nikdy.
    const znovu = await tik({ stav: 'delivered' });
    assert.equal(znovu.dotazy.length, 0);
  });

  test('chyba Zásilkovny u jedné zásilky nezastaví ostatní', async () => {
    const rozbita = await objednavka();
    const dobra = await objednavka();
    const cisloRozbite = (await radek(rozbita)).tracking_number;
    await tik({ stav: (c) => (c === cisloRozbite ? new Error('Packeta API: timeout') : 'arrived') });

    const r1 = await radek(rozbita);
    assert.equal(r1.status, 'Zaplaceno');
    assert.ok(r1.packet_checked_at, 'čas dotazu se zapíše i po chybě');
    assert.equal(r1.packet_status, '');
    assert.equal((await radek(dobra)).status, 'Vyřízena');
  });

  test('neodeslaný e-mail: objednávka vyřízená, důvod u ní a jeden push', async () => {
    const id = await objednavka();
    const pushe = [];
    await tik({ stav: 'arrived', post: posta({ selze: true }), pushe });

    const o = await radek(id);
    assert.equal(o.status, 'Vyřízena');
    assert.equal(o.faktury.length, 1);
    assert.match(o.auto_fulfill_error, /E-mail s fakturou zákazníkovi neodešel: Resend nedostupný/);
    assert.equal(pushe.length, 1);
    assert.match(pushe[0].body, /neodešel/);
    assert.equal(pushe[0].url, `/ucetnictvi/objednavky/${encodeURIComponent(id)}`);
  });

  test('převod bez zaplacené zálohovky zůstane nevyřízený a push přijde jednou za týden', async () => {
    const id = await objednavka({ payment_method: 'Bankovní převod', status: 'Přijata', proforma: 'Nezaplacena' });
    const pushe = [];
    await tik({ stav: 'arrived', pushe });

    let o = await radek(id);
    assert.equal(o.status, 'Přijata');
    assert.equal(o.faktury.length, 0);
    assert.match(o.auto_fulfill_error, /Zálohová faktura není zaplacená/);
    assert.equal(pushe.length, 1);

    // Za půl hodiny znovu: pořád nevyřízená, ale bez dalšího pushe.
    await sql`UPDATE shop_orders SET packet_checked_at = NOW() - INTERVAL '31 minutes' WHERE id = ${id}`;
    await tik({ stav: 'arrived', pushe });
    o = await radek(id);
    assert.equal(o.status, 'Přijata');
    assert.equal(pushe.length, 1);
  });

  test('vracející se zásilka se nevyřizuje', async () => {
    const id = await objednavka();
    await tikSledovaniZasilek(null, {
      sql,
      nactiStav: async (c) => {
        if (!c.startsWith(PREFIX_ZASILKY)) throw new Error('cizí zásilka');
        return { codeText: 'ready for pickup', statusText: '', dateTime: null, isReturning: true };
      },
      vyrid: () => assert.fail('vracející se zásilka se nemá vyřizovat'),
      notify: async () => {},
    });
    assert.equal((await radek(id)).status, 'Zaplaceno');
  });
});

describe('souběh automatu a obsluhy', () => {
  test('dvě vyřízení naráz: jedna faktura a jeden e-mail', async () => {
    const id = await objednavka();
    const post = posta();
    const vysledky = await Promise.all([
      vyridObjednavku(sql, null, id, { automat: true, odesliFakturu: post.odesliFakturu }),
      vyridObjednavku(sql, null, id, { odesliFakturu: post.odesliFakturu }),
      vyridObjednavku(sql, null, id, { automat: true, odesliFakturu: post.odesliFakturu }),
    ]);

    const o = await radek(id);
    assert.equal(o.status, 'Vyřízena');
    assert.equal(o.faktury.length, 1, 'jen jedna vydaná faktura');
    assert.equal(post.odeslane.length, 1, 'jen jeden e-mail');
    assert.equal(vysledky.filter(v => v.novaFaktura).length, 1);
    // Bez zámku by druhá faktura spadla až na unikátním čísle (e-shop testu
    // nemá řadu, obě by dostaly „FV-<rok>-<objednávka>“) – s řadou by prošla.
    // Proto se hlídá i to, že žádné vyřízení neskončilo chybou.
    assert.deepEqual(vysledky.map(v => v.chyba ?? ''), ['', '', '']);
  });

  test('automat nepřepíše objednávku, kterou mezitím stornoval člověk', async () => {
    const id = await objednavka({ status: 'Stornována' });
    const post = posta();
    const v = await vyridObjednavku(sql, null, id, { automat: true, odesliFakturu: post.odesliFakturu });
    assert.equal(v.vysledek, 'preskoceno');
    const o = await radek(id);
    assert.equal(o.status, 'Stornována');
    assert.equal(o.faktury.length, 0);
    assert.equal(post.odeslane.length, 0);
  });

  test('ruční vyřízení maže starou chybu automatu', async () => {
    const id = await objednavka({ payment_method: 'Bankovní převod', status: 'Přijata', proforma: 'Nezaplacena' });
    await tik({ stav: 'arrived' });
    assert.notEqual((await radek(id)).auto_fulfill_error, '');

    await sql`UPDATE accounting_invoices SET status = 'Zaplacena' WHERE order_id = ${id} AND type = 'proforma'`;
    const post = posta();
    const v = await vyridObjednavku(sql, null, id, { odesliFakturu: post.odesliFakturu });
    assert.equal(v.vysledek, 'vyrizena');
    const o = await radek(id);
    assert.equal(o.auto_fulfill_error, '');
    assert.equal(o.auto_fulfilled_at, null, 'vyřídil ji člověk, ne automat');
    assert.equal(post.odeslane.length, 1);
  });
});
