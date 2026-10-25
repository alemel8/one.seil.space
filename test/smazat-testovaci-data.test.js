// Úklid testovacích dat e-shopu (scripts/smazat-testovaci-data.js) sahá jen
// na zákazníky TOHO e-shopu.
//
// Dřív bral registrované kontakty všech e-shopů (crm_contacts.is_registered
// na e-shop vázané není) a --cisla omezovalo jen objednávky. Ostré spuštění
// pro Dílnu by smazalo zákazníky Toneráčku bez objednávek a těm s objednávkami
// zrušilo registraci; totéž i úklid jediné objednávky samotného Toneráčku.
//
// Objednávka patří kontaktu i bez vazby crm_contact_id (zápis do CRM při
// objednávce selhal) — podle e-mailu. A kontakt s vazbou na jiný e-shop se
// nemaže: kaskáda by smazala i tu vazbu.
//
// Potřebuje databázi, běžící server ne. Skript se spouští jako samostatný
// proces s DATABASE_URL testovací databáze. Na Toneráček sahá jen přes
// --cisla s čísly objednávek, které si sám založí.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… node --test test/smazat-testovaci-data.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const SKRIPT = fileURLToPath(new URL('../scripts/smazat-testovaci-data.js', import.meta.url));
const r = crypto.randomBytes(4).toString('hex');
const n = parseInt(r.slice(0, 6), 16) % 900000 + 100000;

function lokalniDatabaze() {
  const url = process.env.DATABASE_URL || '';
  const host = url ? new URL(url).hostname : '';
  if (!['127.0.0.1', 'localhost'].includes(host) && process.env.TEST_DB_ALLOW_REMOTE !== '1') {
    throw new Error(`Test spouští ostrý úklid — DATABASE_URL musí mířit na 127.0.0.1/localhost, ne na "${host}"`);
  }
  return url;
}

let sql;
const ctx = { kontakty: {}, objednavky: {} };
const uklid = { contacts: [], orders: [], shops: [] };

function uklidit(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SKRIPT, ...args], {
      env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, DATABASE_SSL: 'false' },
      timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
  });
}

const mail = (klic) => `ukl-${klic}-${r}@example.invalid`;

async function kontakt(klic, { registrovany = false, source = null } = {}) {
  const id = `TEST-UKL-${r}-${klic}`;
  await sql`
    INSERT INTO crm_contacts (id, email, first_name, last_name, is_registered, source, notes)
    VALUES (${id}, ${mail(klic)}, 'Test', ${klic}, ${registrovany}, ${source},
            ${registrovany ? 'PWDHASH:toneracek' : ''})`;
  uklid.contacts.push(id);
  ctx.kontakty[klic] = id;
  return id;
}

async function ucetEshopu(contactId, shopId, registrovany) {
  await sql`
    INSERT INTO crm_contact_shops (contact_id, shop_id, is_registered, password_backup, registered_at)
    VALUES (${contactId}, ${shopId}, ${registrovany}, ${registrovany ? 'PWDHASH:eshop' : ''}, NOW())`;
}

async function objednavka(klic, shopId, contactId, cislo, email = mail(klic)) {
  const id = `TEST-UKL-O-${r}-${klic}`;
  await sql`
    INSERT INTO shop_orders (id, shop_id, order_number, status, email, crm_contact_id, total_price)
    VALUES (${id}, ${shopId}, ${cislo}, 'Přijata', ${email}, ${contactId}, 100)`;
  uklid.orders.push(id);
  ctx.objednavky[klic] = id;
  return id;
}

const existuje = async (tabulka, id) =>
  (await sql`SELECT 1 FROM ${sql(tabulka)} WHERE id = ${id}`).length === 1;
const registrovany = async (id) => (await sql`SELECT is_registered FROM crm_contacts WHERE id = ${id}`)[0]?.is_registered;
const ucty = async (id) => (await sql`SELECT shop_id, is_registered FROM crm_contact_shops WHERE contact_id = ${id} ORDER BY shop_id`)
  .map((x) => ({ ...x }));

before(async () => {
  sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
  [ctx.toneracek] = await sql`SELECT * FROM shops WHERE slug = 'toneracek'`;
  assert.ok(ctx.toneracek, 'migrace 030 zakládá e-shop toneracek');
  const [d] = await sql`
    INSERT INTO shops (slug, name, url) VALUES (${`test-uklid-${r}`}, ${`Úklid test ${r}`}, 'https://example.invalid')
    RETURNING *`;
  uklid.shops.push(d.id);
  ctx.dilna = d;
  const [treti] = await sql`
    INSERT INTO shops (slug, name, url, active) VALUES (${`test-uklid3-${r}`}, ${`Úklid třetí ${r}`}, 'https://example.invalid', FALSE)
    RETURNING *`;
  uklid.shops.push(treti.id);
  ctx.treti = treti;
  const T = ctx.toneracek.id;
  const D = d.id;

  // Zákazníci Toneráčku, na které úklid Dílny nesmí sáhnout.
  await kontakt('t-bez-obj', { registrovany: true, source: 'Toneráček.cz' });
  const tSObj = await kontakt('t-s-obj', { registrovany: true, source: 'Toneráček.cz' });
  await objednavka('t-s-obj', T, tSObj, `81${n}`);

  // Zákazníci jen Dílny — po úklidu Dílny zmizí.
  const dHost = await kontakt('d-host', { source: d.name });
  await ucetEshopu(dHost, D, false);
  await objednavka('d-host', D, dHost, `71${n}`);
  const dUcet = await kontakt('d-ucet', { source: d.name });
  await ucetEshopu(dUcet, D, true);

  // Zákazník Toneráčku (s účtem), který si na Dílně zkusil účet i objednávku.
  const oba = await kontakt('oba', { registrovany: true, source: 'Toneráček.cz' });
  await ucetEshopu(oba, D, true);
  await objednavka('oba', D, oba, `72${n}`);

  // Host Toneráčku, který na Dílně objednal.
  const hostT = await kontakt('host-t', { source: 'Toneráček.cz' });
  await objednavka('host-t-t', T, hostT, `82${n}`);
  await ucetEshopu(hostT, D, false);
  await objednavka('host-t-d', D, hostT, `73${n}`);

  // Host Toneráčku, jehož objednávka na Toneráčku vazbu na kontakt nemá
  // (zápis do CRM selhal); na Dílně objednal s vazbou.
  const nepropojeny = await kontakt('nepropojeny', { source: 'Toneráček.cz' });
  await objednavka('nepropojeny-t', T, null, `86${n}`, mail('nepropojeny'));
  await ucetEshopu(nepropojeny, D, false);
  await objednavka('nepropojeny-d', D, nepropojeny, `74${n}`, mail('nepropojeny'));

  // Zákazník Dílny s účtem, který je i hostem třetího e-shopu (jen vazba).
  const tretiHost = await kontakt('treti-host', { source: d.name });
  await ucetEshopu(tretiHost, D, true);
  await ucetEshopu(tretiHost, treti.id, false);

  // Zákazník Toneráčku: testovací objednávka s vazbou, skutečná bez vazby.
  const y = await kontakt('y', { registrovany: true, source: 'Toneráček.cz' });
  await objednavka('y-test', T, y, `87${n}`, mail('y'));
  await objednavka('y-skutecna', T, null, `88${n}`, mail('y'));

  // Pro úklid Toneráčku přes --cisla: zákazník s účtem, testovací a skutečnou
  // objednávkou, a host s jedinou testovací objednávkou.
  const z = await kontakt('z', { registrovany: true, source: 'Toneráček.cz' });
  await objednavka('z-test', T, z, `83${n}`);
  await objednavka('z-skutecna', T, z, `84${n}`);
  const w = await kontakt('w', { source: 'Toneráček.cz' });
  await objednavka('w-test', T, w, `85${n}`);
});

after(async () => {
  if (!sql) return;
  await sql`DELETE FROM shop_orders WHERE id = ANY(${uklid.orders})`;
  await sql`DELETE FROM crm_contacts WHERE id = ANY(${uklid.contacts})`;
  await sql`DELETE FROM shops WHERE id = ANY(${uklid.shops})`;
  await sql.end();
});

describe('úklid jiného e-shopu než Toneráčku', () => {
  test('nanečisto nic nezmění a vypíše, co by se stalo', async () => {
    const vysledek = await uklidit('--eshop', ctx.dilna.slug);
    assert.equal(vysledek.code, 0, vysledek.stderr);
    assert.match(vysledek.stdout, /nanečisto, nic se nesmaže/);
    assert.match(vysledek.stdout, new RegExp(`smazat .*ukl-d-host-${r}@`));
    assert.match(vysledek.stdout, new RegExp(`smazat .*ukl-d-ucet-${r}@`));
    assert.match(vysledek.stdout, new RegExp(`odpojit .*ukl-oba-${r}@`));
    assert.match(vysledek.stdout, new RegExp(`odpojit .*ukl-nepropojeny-${r}@.*objednávka v jiném e-shopu`));
    assert.match(vysledek.stdout, new RegExp(`odpojit .*ukl-treti-host-${r}@.*host v jiném e-shopu`));
    assert.doesNotMatch(vysledek.stdout, new RegExp(`ukl-t-bez-obj-${r}@`), 'zákazník Toneráčku do výpisu nepatří');
    assert.doesNotMatch(vysledek.stdout, new RegExp(`ukl-t-s-obj-${r}@`));
    assert.ok(await existuje('crm_contacts', ctx.kontakty['d-host']));
    assert.ok(await existuje('shop_orders', ctx.objednavky['d-host']));
  });

  test('ostře smaže jen data e-shopu a zákazníky Toneráčku nechá být', async () => {
    const vysledek = await uklidit('--eshop', ctx.dilna.slug, '--smazat');
    assert.equal(vysledek.code, 0, vysledek.stderr);

    // Toneráček beze změny.
    assert.equal(await registrovany(ctx.kontakty['t-bez-obj']), true, 'registrovaný zákazník Toneráčku bez objednávek zůstává');
    assert.equal(await registrovany(ctx.kontakty['t-s-obj']), true, 'registrovaný zákazník Toneráčku s objednávkou zůstává registrovaný');
    assert.ok(await existuje('shop_orders', ctx.objednavky['t-s-obj']));
    assert.ok(await existuje('shop_orders', ctx.objednavky['host-t-t']));

    // Data Dílny pryč.
    for (const klic of ['d-host', 'oba', 'host-t-d']) {
      assert.equal(await existuje('shop_orders', ctx.objednavky[klic]), false, `objednávka ${klic} smazána`);
    }
    assert.equal(await existuje('crm_contacts', ctx.kontakty['d-host']), false);
    assert.equal(await existuje('crm_contacts', ctx.kontakty['d-ucet']), false);

    // Zákazník obou e-shopů: kontakt i účet Toneráčku zůstávají, účet Dílny ne.
    assert.ok(await existuje('crm_contacts', ctx.kontakty.oba));
    assert.equal(await registrovany(ctx.kontakty.oba), true);
    const [{ notes }] = await sql`SELECT notes FROM crm_contacts WHERE id = ${ctx.kontakty.oba}`;
    assert.equal(notes, 'PWDHASH:toneracek', 'heslo Toneráčku zůstává');
    assert.deepEqual(await ucty(ctx.kontakty.oba), []);

    // Host Toneráčku: kontakt zůstává, vazba na Dílnu pryč.
    assert.ok(await existuje('crm_contacts', ctx.kontakty['host-t']));
    assert.deepEqual(await ucty(ctx.kontakty['host-t']), []);

    // Objednávka na Toneráčku bez vazby drží kontakt podle e-mailu.
    assert.ok(await existuje('crm_contacts', ctx.kontakty.nepropojeny), 'host Toneráčku s nepropojenou objednávkou zůstává');
    assert.ok(await existuje('shop_orders', ctx.objednavky['nepropojeny-t']));
    assert.equal(await existuje('shop_orders', ctx.objednavky['nepropojeny-d']), false);
    assert.deepEqual(await ucty(ctx.kontakty.nepropojeny), []);

    // Vazba na třetí e-shop: kontakt zůstává i s ní, jen účet Dílny je pryč.
    assert.ok(await existuje('crm_contacts', ctx.kontakty['treti-host']));
    assert.deepEqual(await ucty(ctx.kontakty['treti-host']), [{ shop_id: ctx.treti.id, is_registered: false }]);
  });
});

describe('úklid Toneráčku po jednotlivých objednávkách (--cisla)', () => {
  test('smaže jen vyjmenované objednávky a jen jejich zákazníky', async () => {
    const vysledek = await uklidit('--eshop', 'toneracek', '--cisla', `83${n},85${n}`, '--smazat');
    assert.equal(vysledek.code, 0, vysledek.stderr);

    assert.equal(await existuje('shop_orders', ctx.objednavky['z-test']), false);
    assert.equal(await existuje('shop_orders', ctx.objednavky['w-test']), false);
    assert.ok(await existuje('shop_orders', ctx.objednavky['z-skutecna']), 'skutečná objednávka zůstává');

    assert.equal(await registrovany(ctx.kontakty.z), true, 'zákazník se skutečnou objednávkou nepřijde o účet');
    assert.equal(await existuje('crm_contacts', ctx.kontakty.w), false, 'host s jedinou testovací objednávkou zmizí');
    assert.equal(await registrovany(ctx.kontakty['t-bez-obj']), true, 'registrovaný bez objednávek do --cisla nepatří');
    assert.ok(await existuje('crm_contacts', ctx.kontakty['t-bez-obj']));
  });

  test('skutečná objednávka bez vazby na kontakt drží účet podle e-mailu', async () => {
    const vysledek = await uklidit('--eshop', 'toneracek', '--cisla', `87${n}`, '--smazat');
    assert.equal(vysledek.code, 0, vysledek.stderr);
    assert.equal(await existuje('shop_orders', ctx.objednavky['y-test']), false);
    assert.ok(await existuje('shop_orders', ctx.objednavky['y-skutecna']));
    assert.ok(await existuje('crm_contacts', ctx.kontakty.y), 'zákazník se skutečnou objednávkou nezmizí');
    assert.equal(await registrovany(ctx.kontakty.y), true, 'ani nepřijde o účet');
  });
});
