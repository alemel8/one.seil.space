// Interní řada přijatých dokladů a výběr v importu z Disku proti lokální databázi.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/interni-rada.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';

describe('interní řada', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  // Vzdálené roky: běžící testy jiných souborů čítač neposunou.
  const ROK = 2090 + Math.floor(Math.random() * 9);
  const YY = String(ROK).slice(-2);
  const RADA = ROK % 100;
  let sql;
  const zaloz = (id, datum, prepis = {}) => sql`
    INSERT INTO accounting_invoices ${sql({
      id: `ir-${r}-${id}`, type: 'received', number: `IR${r}${id}`, status: 'Nezaplacena', supplier: `Dodavatel ${r}`,
      issue_date: datum, amount: 1, vat_amount: 0, total_amount: 1, currency: 'CZK', ...prepis,
    })}
    RETURNING internal_number, source, pohoda_v_evidenci
  `;

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await sql`DELETE FROM interni_rady WHERE rok = ${RADA}`;
  });

  after(async () => {
    await sql`DELETE FROM accounting_invoices WHERE id LIKE ${`ir-${r}-%`}`;
    await sql`DELETE FROM receipts WHERE vendor = ${`Prodejce ${r}`}`;
    await sql`DELETE FROM interni_rady WHERE rok = ${RADA}`;
    await sql.end();
  });

  test('čísla jdou po sobě a nezávisí na cestě založení', async () => {
    const [a] = await zaloz('a', `${ROK}-03-01`);
    const [b] = await zaloz('b', `${ROK}-01-01`);
    assert.equal(a.internal_number, `PF${YY}-0001`);
    assert.equal(b.internal_number, `PF${YY}-0002`, 'pořadí je podle založení, ne podle data');
    assert.equal(a.source, 'rucne');
    assert.equal(a.pohoda_v_evidenci, false);
  });

  test('neúspěšné založení číslo nespotřebuje', async () => {
    await assert.rejects(zaloz('a', `${ROK}-03-02`), { code: '23505' });
    const [c] = await zaloz('c', `${ROK}-03-02`);
    assert.equal(c.internal_number, `PF${YY}-0003`);
  });

  test('rollback transakce číslo vrátí', async () => {
    await assert.rejects(sql.begin(async tx => {
      await tx`INSERT INTO accounting_invoices (id, type, number, status, supplier, issue_date, amount, vat_amount, total_amount, currency)
               VALUES (${`ir-${r}-t`}, 'received', ${`IR${r}t`}, 'Nezaplacena', ${`Dodavatel ${r}`}, ${`${ROK}-03-03`}, 1, 0, 1, 'CZK')`;
      throw new Error('schválně');
    }), /schválně/);
    const [d] = await zaloz('d', `${ROK}-03-03`);
    assert.equal(d.internal_number, `PF${YY}-0004`);
  });

  test('doklad před rokem 2026 číslo nedostane, oprava data na 2026 a dál ano', async () => {
    const [stary] = await zaloz('stary', '2025-12-31');
    assert.equal(stary.internal_number, null);
    const [opraveny] = await sql`UPDATE accounting_invoices SET issue_date = ${`${ROK}-05-01`} WHERE id = ${`ir-${r}-stary`} RETURNING internal_number`;
    assert.equal(opraveny.internal_number, `PF${YY}-0005`);
  });

  test('přidělené číslo oprava data ani jiná úprava nezmění', async () => {
    const [opraveny] = await sql`UPDATE accounting_invoices SET issue_date = ${`${ROK}-05-02`}, notes = 'x' WHERE id = ${`ir-${r}-a`} RETURNING internal_number`;
    assert.equal(opraveny.internal_number, `PF${YY}-0001`);
  });

  test('vydaná faktura číslo nedostane', async () => {
    const [vydana] = await zaloz('v', `${ROK}-03-01`, { type: 'issued', client_name: 'x' });
    assert.equal(vydana.internal_number, null);
  });

  test('jiný rok začíná od jedničky, pátá číslice se neořízne', async () => {
    const dalsi = ROK + 1;
    await sql`DELETE FROM interni_rady WHERE rok = ${dalsi % 100}`;
    try {
      const [e] = await zaloz('e', `${dalsi}-01-01`);
      assert.equal(e.internal_number, `PF${String(dalsi).slice(-2)}-0001`);
      await sql`UPDATE interni_rady SET posledni = 9999 WHERE druh = 'PF' AND rok = ${dalsi % 100}`;
      const [f] = await zaloz('f', `${dalsi}-01-02`);
      assert.equal(f.internal_number, `PF${String(dalsi).slice(-2)}-10000`);
    } finally {
      await sql`DELETE FROM accounting_invoices WHERE id LIKE ${`ir-${r}-%`} AND issue_date >= ${`${dalsi}-01-01`}`;
      await sql`DELETE FROM interni_rady WHERE rok = ${dalsi % 100}`;
    }
  });

  test('překlep ve století nespadne na duplicitě, jde do téže řady', async () => {
    const [{ posledni }] = await sql`SELECT posledni FROM interni_rady WHERE druh = 'PF' AND rok = ${RADA}`;
    const [g] = await zaloz('g', `${ROK + 100}-03-01`);
    assert.equal(g.internal_number, `PF${YY}-${String(posledni + 1).padStart(4, '0')}`);
  });

  test('souběžné založení nedá dvakrát stejné číslo', async () => {
    const vysledky = await Promise.all(Array.from({ length: 8 }, (_, i) => zaloz(`s${i}`, `${ROK}-06-01`)));
    const cisla = vysledky.map(([x]) => x.internal_number);
    assert.equal(new Set(cisla).size, 8);
  });

  test('účtenky mají vlastní řadu UC', async () => {
    const [u] = await sql`
      INSERT INTO receipts (vendor, amount, vat_amount, total_amount, currency, receipt_date, category, status)
      VALUES (${`Prodejce ${r}`}, 1, 0, 1, 'CZK', ${`${ROK}-02-01`}, 'Ostatní', 'Nezaúčtována')
      RETURNING internal_number
    `;
    assert.equal(u.internal_number, `UC${YY}-0001`);
    const [stara] = await sql`
      INSERT INTO receipts (vendor, amount, vat_amount, total_amount, currency, receipt_date, category, status)
      VALUES (${`Prodejce ${r}`}, 1, 0, 1, 'CZK', '2025-02-01', 'Ostatní', 'Nezaúčtována')
      RETURNING internal_number
    `;
    assert.equal(stara.internal_number, null);
  });

  test('neznámý zdroj databáze odmítne', async () => {
    await assert.rejects(zaloz('z', `${ROK}-03-01`, { source: 'nesmysl' }), { code: '23514' });
  });
});

describe('výběr v importu z Disku', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  const POST = '/ucetnictvi/prijate-faktury/gdrive/import';
  let sql; let sid; let req; let uzivatel;
  const stav = async () => (await req.get('/ucetnictvi/prijate-faktury/gdrive/status')).json();
  const dokonceno = async () => {
    for (let i = 0; i < 50; i++) {
      const s = await stav();
      if (!s.running) return s;
      await new Promise(v => setTimeout(v, 100));
    }
    throw new Error('job neskončil');
  };

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`ir-${r}@example.invalid`}, 'x', TRUE, TRUE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    req = pozadavky(prihlaseni.cookie);
    await sql`INSERT INTO gdrive_soubory ${sql([
      { file_id: `ir-${r}-stary`, nazev: 's.pdf', slozka: '', stav: 'vychozi' },
      { file_id: `ir-${r}-nesp`, nazev: 'n.pdf', slozka: '', stav: 'nesparovano' },
    ])}`;
  });

  after(async () => {
    await sql`DELETE FROM gdrive_soubory WHERE file_id LIKE ${`ir-${r}-%`}`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  test('Založit vybrané vezme z výběru jen nespárované', async () => {
    await dokonceno();
    const res = await req.post(POST, new URLSearchParams([
      ['file_ids', `ir-${r}-stary`], ['file_ids', `ir-${r}-nesp`], ['zalozit_vybrane', '1'], ['year', '2026'], ['month', '10'],
    ]));
    assert.equal(res.status, 302);
    assert.equal((await dokonceno()).total, 1);
    const [stary] = await sql`SELECT stav FROM gdrive_soubory WHERE file_id = ${`ir-${r}-stary`}`;
    assert.equal(stary.stav, 'vychozi', 'starý doklad se nedotkl');
  });

  test('Založit vybrané bez nespárovaných nic nespustí a nespadne', async () => {
    const pred = await dokonceno();
    const res = await req.post(POST, new URLSearchParams([['zalozit_vybrane', '1'], ['year', '2026'], ['month', '10']]));
    assert.equal(res.status, 302);
    assert.equal((await dokonceno()).total, pred.total);
  });
});
