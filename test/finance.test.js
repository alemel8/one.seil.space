// Náklady firmy — co do nich patří a co ne.
//
// Testuje se proti databázi z .env; všechna vytvořená data se na konci mažou.
//   TEST_BASE_URL=… node --test test/finance.test.js

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { naklady, popisNakladu } from '../src/finance.js';

let sql;
const r = crypto.randomBytes(4).toString('hex');
const OD = '2031-03-01', DO = '2031-03-31';   // období daleko od reálných dat
const uklid = { userId: null };

before(async () => {
  sql = postgres(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === 'true', max: 3 });

  const [u] = await sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${`fin-${r}@example.invalid`}, 'x', 'Fin', 'Test') RETURNING id
  `;
  uklid.userId = u.id;

  await sql`
    INSERT INTO accounting_invoices (id, type, number, supplier, issue_date, total_amount)
    VALUES (${'fin_inv_' + r}, 'received', ${'FINTEST' + r}, 'Dodavatel', ${OD}, 1000)
  `;
  await sql`
    INSERT INTO receipts (vendor, total_amount, receipt_date)
    VALUES (${'FINTEST ' + r}, 200, ${OD})
  `;
  // Mzda: uhrazeno 700, ale nákladem firmy je 900 (hrubá + odvody firmy)
  await sql`
    INSERT INTO hr_payroll_runs (id, user_id, period, gross, net, social, health, company_cost)
    VALUES (${'fin_run_' + r}, ${u.id}, ${OD}, 500, 400, 200, 100, 900)
  `;
  // Záloha NENÍ náklad, proplacený nákup ano
  await sql`
    INSERT INTO hr_payroll_items (id, user_id, kind, paid_on, amount, description)
    VALUES (${'fin_zal_' + r}, ${u.id}, 'zaloha',            ${OD}, 50000, 'Záloha'),
           (${'fin_nak_' + r}, ${u.id}, 'proplaceny_naklad', ${OD}, 300,   'Sluchátka')
  `;
});

after(async () => {
  if (!sql) return;
  await sql`DELETE FROM accounting_invoices WHERE id = ${'fin_inv_' + r}`;
  await sql`DELETE FROM receipts WHERE vendor = ${'FINTEST ' + r}`;
  await sql`DELETE FROM hr_payroll_items WHERE user_id = ${uklid.userId}`;
  await sql`DELETE FROM hr_payroll_runs  WHERE user_id = ${uklid.userId}`;
  await sql`DELETE FROM users WHERE id = ${uklid.userId}`;
  await sql.end();
});

describe('náklady firmy', () => {
  test('sčítají faktury, účtenky, mzdy i proplacené nákupy', async () => {
    const n = await naklady(sql, OD, DO);
    assert.equal(n.faktury, 1000);
    assert.equal(n.uctenky, 200);
    assert.equal(n.platby, 300, 'proplacený nákup je náklad');
    assert.equal(n.celkem, 1000 + 200 + 900 + 300);
  });

  test('záloha zaměstnanci není náklad', async () => {
    // 50 000 Kč zálohy je pohledávka za zaměstnancem (335), ne náklad.
    // Kdyby prosákla do nákladů, hrubý zisk by byl o padesát tisíc mimo.
    const n = await naklady(sql, OD, DO);
    assert.ok(n.celkem < 50000, `zálohy prosákly do nákladů: ${n.celkem}`);
    assert.equal(n.pocty.platby, 1, 'do počtu se má započítat jen ten nákup');
  });

  test('do zisku jde náklad firmy, ne to, co odešlo z účtu', async () => {
    // Mzdový list má uhrazeno 700 (400+200+100), ale zaměstnavatele stál 900.
    // Účetní náklad je těch 900 — a právě to je rozdíl, kvůli kterému se
    // osobní zůstatek a hrubý zisk nesmí počítat ze stejného čísla.
    const n = await naklady(sql, OD, DO);
    assert.equal(n.mzdy, 900);
  });

  test('období se respektuje', async () => {
    const jinde = await naklady(sql, '2031-04-01', '2031-04-30');
    assert.equal(jinde.celkem, 0);
  });

  test('popisek říká, z čeho se číslo skládá', async () => {
    const n = await naklady(sql, OD, DO);
    const popis = popisNakladu(n);
    assert.match(popis, /faktur/);
    assert.match(popis, /mezd/);
    assert.doesNotMatch(popis, /^Přijaté faktury$/, 'nesmí tvrdit, že jsou to jen faktury');
  });
});
