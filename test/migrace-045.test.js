// Migrace 045 poběží při startu nad živou tabulkou faktur. Hlídá se tu, že jen
// vymění index čísla přijaté faktury, že kolize server neshodí a že klíč IČO je
// v databázi i v importu z POHODY stejný. Databázová část jede v transakci, která
// se na konci vrátí.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… node --test test/migrace-045.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { icoKlic } from '../scripts/lib/dodavatel.js';

const OBSAH = readFileSync(new URL('../migrations/045_ico_v_klici_prijate_faktury.sql', import.meta.url), 'utf8');
const INDEX = 'accounting_invoices_received_number_supplier_idx';
const INDEX_044 = `CREATE UNIQUE INDEX ${INDEX} ON accounting_invoices (number, (COALESCE(NULLIF(ltrim(regexp_replace(supplier_ico, '[^0-9A-Za-z]', '', 'g'), '0'), ''), lower(btrim(supplier))))) WHERE type = 'received' AND number <> ''`;

test('migrace 045 jen vymění index a drží lock_timeout', () => {
  const bezKomentaru = OBSAH.split('\n').map((r) => r.replace(/--.*$/, '')).join('\n');
  assert.match(bezKomentaru.trimStart(), /^SET LOCAL lock_timeout = '2s';/);
  assert.doesNotMatch(bezKomentaru, /\bUPDATE\b|\bDELETE FROM\b|\bINSERT\b|CONCURRENTLY/);
});

const DATABASE_URL = process.env.DATABASE_URL || '';
const volby = { skip: !DATABASE_URL && 'bez DATABASE_URL' };
const ZRUSIT = new Error('rollback');

async function vTransakci(telo) {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(DATABASE_URL).hostname), 'jen lokální databáze');
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => { await telo(tx); throw ZRUSIT; });
  } catch (e) {
    if (e !== ZRUSIT) throw e;
  } finally {
    await sql.end();
  }
}

test('ico_klic v databázi a v importu z POHODY dávají totéž', volby, () => vTransakci(async (tx) => {
  const zapisy = ['28115708', 'CZ28115708', 'cz28115708', 'CZ 281 157 08', '028115708', '281-157-08', ' 123 45 678 ',
    '00000000', '0', 'CZ', 'cz00', '', '   ', '-', 'IE6388047V', 'ie6388047v', 'SK2020000000', 'ACZ123', 'Č28115708', 'CZCZ1'];
  for (const zapis of zapisy) {
    const [{ klic }] = await tx`SELECT ico_klic(${zapis}) AS klic`;
    assert.equal(klic ?? '', icoKlic(zapis), JSON.stringify(zapis));
  }
  const [{ prazdne }] = await tx`SELECT ico_klic(NULL) AS prazdne`;
  assert.equal(prazdne, null);
  assert.equal(icoKlic(null), '');
}));

test('blokuje IČO v jiném zápisu, různá IČO a čísla vydaných nechá být', volby, () => vTransakci(async (tx) => {
  const r = `m45${Date.now()}`;
  let i = 0;
  const pokus = async (radek) => {
    try {
      await tx.savepoint((sp) => sp`INSERT INTO accounting_invoices ${sp({ id: `${r}-${++i}`, type: 'received', supplier: '', supplier_ico: null, ...radek })}`);
      return 'projde';
    } catch (e) {
      if (e.code !== '23505') throw e;
      return 'blokuje';
    }
  };
  assert.equal(await pokus({ number: r, supplier: 'Alfa', supplier_ico: '28115708' }), 'projde');
  for (const ico of ['CZ28115708', 'cz28115708', 'CZ 281 157 08', '028115708']) {
    assert.equal(await pokus({ number: r, supplier: 'Jiný zápis', supplier_ico: ico }), 'blokuje', ico);
  }
  assert.equal(await pokus({ number: r, supplier: 'Alfa', supplier_ico: '28115709' }), 'projde', 'jiné IČO');
  assert.equal(await pokus({ number: r, supplier: 'Alfa', supplier_ico: null }), 'projde', 'bez IČO hlídá aplikace');
  assert.equal(await pokus({ number: r, supplier: 'ALFA ', supplier_ico: 'CZ' }), 'blokuje', 'samotné CZ je bez IČO, stejný název');
  assert.equal(await pokus({ type: 'issued', number: r }), 'projde');
  assert.equal(await pokus({ type: 'issued', number: r, supplier: 'Jiný', supplier_ico: '99999999' }), 'blokuje', 'vydané drží typ a číslo');
}));

test('kolize server neshodí: index z 044 zůstane a migrace projde', volby, () => vTransakci(async (tx) => {
  const r = `m45k${Date.now()}`;
  await tx.unsafe(`DROP INDEX ${INDEX}`);
  await tx.unsafe(INDEX_044);
  const radek = { type: 'received', number: r, supplier: 'Dvojice' };
  await tx`INSERT INTO accounting_invoices ${tx({ ...radek, id: `${r}-1`, supplier_ico: '28115708' })}`;
  await tx`INSERT INTO accounting_invoices ${tx({ ...radek, id: `${r}-2`, supplier_ico: 'CZ28115708' })}`;
  await tx.unsafe(OBSAH);
  const [{ indexdef }] = await tx`SELECT indexdef FROM pg_indexes WHERE indexname = ${INDEX}`;
  assert.doesNotMatch(indexdef, /ico_klic/, 'zůstal starý index');
  assert.match(indexdef, /supplier_ico/);
}));

test('nad čistými daty index používá ico_klic a jde spustit dvakrát', volby, () => vTransakci(async (tx) => {
  await tx.unsafe(OBSAH);
  await tx.unsafe(OBSAH);
  const [{ indexdef }] = await tx`SELECT indexdef FROM pg_indexes WHERE indexname = ${INDEX}`;
  assert.match(indexdef, /ico_klic\(supplier_ico\)/);
}));
