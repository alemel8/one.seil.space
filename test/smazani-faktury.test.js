// Smazání vydaného dokladu: jen bez vazby na POHODU, objednávku, banku a podklad.
// Jede proti běžícímu serveru a lokální databázi, po sobě uklidí.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/smazani-faktury.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { rokVPraze } from '../src/series-format.js';
import { PRESKOCIT, lokalniDatabaze, serverBezi, prihlas, pozadavky } from './pomocnici/server.js';

const r = crypto.randomBytes(4).toString('hex');
const SEZNAM = '/ucetnictvi/vydane-faktury';

describe('smazání vydaného dokladu', { skip: PRESKOCIT }, () => {
  let sql, req, adminId, rada, shop, ucet;
  const uklid = { sids: [], faktury: [], banka: [], podklady: [] };
  const rr = String(rokVPraze() % 100);
  let citac = 0;

  const faktura = async (over = {}) => {
    const id = `TEST-SM-${r}-${++citac}`;
    await sql`
      INSERT INTO accounting_invoices ${sql({ id, type: 'issued', number: `SM-${r}-${citac}`, client_name: `Klient ${r}`, issue_date: new Date(), total_amount: 121, ...over })}`;
    uklid.faktury.push(id);
    return id;
  };
  const existuje = async (id) => (await sql`SELECT 1 FROM accounting_invoices WHERE id = ${id}`).length === 1;
  const smaz = (id) => req.post(`${SEZNAM}/${id}/smazat`);
  const detail = async (id) => (await req.get(`${SEZNAM}/${id}`)).text();
  const citacRady = async () => (await sql`SELECT current_number FROM invoice_number_series WHERE id = ${rada.id}`)[0].current_number;
  const zRady = async () => {
    const res = await req.post(`${SEZNAM}/vytvorit`, { client_name: `Klient ${r}`, series_id: String(rada.id), item_name: 'S', item_qty: '1', item_unit: 'ks', item_price: '100', item_vat: '21' });
    const id = res.headers.get('location').split('/').pop();
    uklid.faktury.push(id);
    return id;
  };

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 3, onnotice: () => {} });
    await serverBezi();
    [{ id: adminId }] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_active, is_admin)
      VALUES (${`sm-${r}@example.invalid`}, 'x', 'Test', 'Mazání', TRUE, TRUE) RETURNING id`;
    const s = await prihlas(sql, adminId);
    uklid.sids.push(s.sid);
    req = pozadavky(s.cookie);
    [rada] = await sql`
      INSERT INTO invoice_number_series (name, prefix, format, current_number, start_number, padding, entity_type, active, rok_citace)
      VALUES (${`Mazání ${r}`}, '', ${`sm${r}-YYNNNN`}, 0, 1, 4, 'faktura', TRUE, ${rokVPraze()}) RETURNING *`;
    [shop] = await sql`INSERT INTO shops (slug, name, url, active) VALUES (${`sm-${r}`}, ${`Sm ${r}`}, '', TRUE) RETURNING id`;
    [ucet] = await sql`INSERT INTO accounting_bank_accounts (name) VALUES (${`Sm ${r}`}) RETURNING id`;
  });

  after(async () => {
    if (!sql) return;
    if (uklid.banka.length) await sql`DELETE FROM accounting_bank_transactions WHERE id = ANY(${uklid.banka})`;
    if (ucet) await sql`DELETE FROM accounting_bank_accounts WHERE id = ${ucet.id}`;
    if (uklid.podklady.length) await sql`DELETE FROM hr_work_reports WHERE id = ANY(${uklid.podklady})`;
    await sql`DELETE FROM accounting_invoices WHERE id = ANY(${uklid.faktury})`;
    await sql`DELETE FROM shop_orders WHERE id = ${`TEST-SM-${r}`}`;
    if (shop) await sql`DELETE FROM shops WHERE id = ${shop.id}`;
    if (rada) await sql`DELETE FROM invoice_number_series WHERE id = ${rada.id}`;
    await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
    if (adminId) await sql`DELETE FROM users WHERE id = ${adminId}`;
    await sql.end();
  });

  test('doklad mimo POHODU zmizí i s položkami, e-maily a upomínkami a seznam to řekne', async () => {
    const id = await faktura({ due_date: '2020-01-01', status: 'Po splatnosti' });
    await sql`INSERT INTO accounting_invoice_items (invoice_id, name, quantity, unit, price_per_unit, vat_rate, amount, vat_amount, total) VALUES (${id}, 'P', 1, 'ks', 100, 21, 100, 21, 121)`;
    await sql`INSERT INTO invoice_emails (invoice_id, email, status) VALUES (${id}, 'k@example.invalid', 'chyba')`;
    await sql`INSERT INTO invoice_reminders (invoice_id, level, days_overdue) VALUES (${id}, 1, 5)`;

    const html = await detail(id);
    assert.ok(html.includes(`action="${SEZNAM}/${id}/smazat"`));
    assert.ok(html.includes('data-potvrdit="Smazat doklad'));

    const res = await smaz(id);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${SEZNAM}?smazano=1`);
    assert.equal(await existuje(id), false);
    for (const t of ['accounting_invoice_items', 'invoice_emails', 'invoice_reminders']) {
      assert.equal((await sql`SELECT 1 FROM ${sql(t)} WHERE invoice_id = ${id}`).length, 0, t);
    }
    assert.ok((await (await req.get(res.headers.get('location'))).text()).includes('Doklad byl smazán.'));
  });

  const prekazky = [
    ['V POHODĚ', { pohoda_v_evidenci: true }, 'pohoda', 'Doklad je v POHODĚ'],
    ['Odesláno do POHODY', { pohoda_exported_at: new Date() }, 'pohoda', 'Doklad je v POHODĚ'],
  ];
  for (const [nazev, over, kod, text] of prekazky) {
    test(`${nazev}: tlačítko není, karta řekne proč a POST nic nesmaže`, async () => {
      const id = await faktura(over);
      const html = await detail(id);
      assert.ok(!html.includes(`${id}/smazat`));
      assert.ok(html.includes(text));
      const res = await smaz(id);
      assert.equal(res.headers.get('location'), `${SEZNAM}/${id}?smazatError=${kod}`);
      assert.equal(await existuje(id), true);
      assert.ok((await (await req.get(res.headers.get('location'))).text()).includes('Doklad se nesmazal'));
    });
  }

  test('doklad k objednávce se nesmaže, i když příznak POHODY nemá', async () => {
    await sql`
      INSERT INTO shop_orders (id, shop_id, order_number, status, payment_method, email, first_name, last_name, total_price)
      VALUES (${`TEST-SM-${r}`}, ${shop.id}, ${`9${crypto.randomInt(1e8)}`}, 'Přijata', 'Platba kartou', 'o@example.invalid', 'T', 'M', 121)`;
    const id = await faktura({ order_id: `TEST-SM-${r}`, shop_id: shop.id });
    assert.equal((await smaz(id)).headers.get('location'), `${SEZNAM}/${id}?smazatError=objednavka`);
    assert.equal(await existuje(id), true);
  });

  test('spárovaná platba a fakturační podklad doklad drží', async () => {
    const a = await faktura();
    const [tx] = await sql`INSERT INTO accounting_bank_transactions (bank_account_id, type, amount, transaction_date, matched_invoice_id) VALUES (${ucet.id}, 'credit', 121, CURRENT_DATE, ${a}) RETURNING id`;
    uklid.banka.push(tx.id);
    assert.equal((await smaz(a)).headers.get('location'), `${SEZNAM}/${a}?smazatError=banka`);
    assert.equal(await existuje(a), true);

    const b = await faktura();
    const [podklad] = await sql`INSERT INTO hr_work_reports (id, user_id, invoice_id) VALUES (${`TEST-SM-${r}`}, ${adminId}, ${b}) RETURNING id`;
    uklid.podklady.push(podklad.id);
    assert.equal((await smaz(b)).headers.get('location'), `${SEZNAM}/${b}?smazatError=podklad`);
    assert.equal(await existuje(b), true);
  });

  test('zálohová bez objednávky se smaže, s navázanou fakturou ne; přijatá faktura tudy nejde', async () => {
    const z = await faktura({ type: 'proforma' });
    assert.equal((await smaz(z)).headers.get('location'), `${SEZNAM}?typ=zalohove&smazano=1`);
    assert.equal(await existuje(z), false);

    const z2 = await faktura({ type: 'proforma' });
    await faktura({ proforma_invoice_id: z2 });
    assert.equal((await smaz(z2)).headers.get('location'), `${SEZNAM}/${z2}?smazatError=zalohova`);

    const prijata = await faktura({ type: 'received' });
    assert.equal((await smaz(prijata)).status, 404);
    assert.equal(await existuje(prijata), true);
    assert.equal((await smaz('neexistuje')).status, 404);
  });

  test('poslední číslo řady se vrátí, starší ani odeslané e-mailem ne', async () => {
    const start = await citacRady();
    const prvni = await zRady();
    const druha = await zRady();
    assert.equal(await citacRady(), start + 2);

    await smaz(prvni);
    assert.equal(await citacRady(), start + 2, 'uprostřed řady zůstane díra, číslo se nesmí opakovat');

    await smaz(druha);
    assert.equal(await citacRady(), start + 1);
    const treti = await zRady();
    assert.equal((await sql`SELECT number FROM accounting_invoices WHERE id = ${treti}`)[0].number, `sm${r}-${rr}${String(start + 2).padStart(4, '0')}`);

    await sql`INSERT INTO invoice_emails (invoice_id, email, status) VALUES (${treti}, 'k@example.invalid', 'odeslano')`;
    assert.ok((await detail(treti)).includes('Doklad už byl odeslán e-mailem.'));
    await smaz(treti);
    assert.equal(await existuje(treti), false);
    assert.equal(await citacRady(), start + 2, 'číslo, které klient dostal, se znovu nepřidělí');
  });
});
