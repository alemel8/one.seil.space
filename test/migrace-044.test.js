// Migrace 044 poběží při startu nad živou tabulkou faktur. Hlídá se tu, že jen
// vymění indexy čísla faktury (žádná data, zámek nejvýš 2 s od prvního příkazu)
// a že pustí a zablokuje přesně to, co má. Databázová část jede v transakci,
// která se na konci vrátí.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… node --test test/migrace-044.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const OBSAH = readFileSync(new URL('../migrations/044_cislo_prijate_faktury_podle_dodavatele.sql', import.meta.url), 'utf8');
const prikazy = () => OBSAH.split('\n').map((r) => r.replace(/--.*$/, '')).join('\n')
  .split(';').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);

test('migrace 044 jen vymění indexy a drží lock_timeout', () => {
  const [prvni, ...zbytek] = prikazy();
  assert.match(prvni, /^SET LOCAL lock_timeout = '2s'$/);
  assert.match(zbytek[0], /^DROP INDEX IF EXISTS accounting_invoices_type_number_idx$/, 'DROP první, bez povyšování zámku');
  for (const p of zbytek.slice(1)) assert.match(p, /^CREATE UNIQUE INDEX IF NOT EXISTS /);
  assert.doesNotMatch(OBSAH, /CONCURRENTLY\s+accounting|\bUPDATE\b.*SET|\bDELETE FROM\b/);
});

const DATABASE_URL = process.env.DATABASE_URL || '';

test('nad databází: blokuje a pouští přesně to, co má', { skip: !DATABASE_URL && 'bez DATABASE_URL' }, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(DATABASE_URL).hostname), 'jen lokální databáze');
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const ZRUSIT = new Error('rollback');
  const r = `m44${Date.now()}`;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(OBSAH);
      await tx.unsafe(OBSAH);   // podruhé nic nezmění
      let i = 0;
      const pokus = async (radek) => {
        try {
          await tx.savepoint((sp) => sp`INSERT INTO accounting_invoices ${sp({ id: `${r}-${++i}`, supplier: '', supplier_ico: null, ...radek })}`);
          return 'projde';
        } catch (e) {
          if (e.code !== '23505') throw e;
          return 'blokuje';
        }
      };
      const n = (x) => `${r}-${x}`;
      assert.equal(await pokus({ type: 'received', number: n('a'), supplier: 'Alfa', supplier_ico: '11111111' }), 'projde');
      assert.equal(await pokus({ type: 'received', number: n('a'), supplier: 'Beta', supplier_ico: '22222222' }), 'projde', 'různé IČO');
      assert.equal(await pokus({ type: 'received', number: n('a'), supplier: 'Alfa', supplier_ico: '33333333' }), 'projde', 'stejný název, různé IČO');
      assert.equal(await pokus({ type: 'received', number: n('a'), supplier: 'Cokoli', supplier_ico: '111 111 11' }), 'blokuje', 'stejné IČO');
      assert.equal(await pokus({ type: 'received', number: n('b'), supplier: 'Tuzka', supplier_ico: null }), 'projde');
      assert.equal(await pokus({ type: 'received', number: n('b'), supplier: ' TUZKA ', supplier_ico: '' }), 'blokuje', 'bez IČO, stejný název');
      assert.equal(await pokus({ type: 'received', number: n('b'), supplier: 'Pero', supplier_ico: null }), 'projde', 'bez IČO, jiný název');
      assert.equal(await pokus({ type: 'received', number: '', supplier: 'Tuzka' }), 'projde', 'prázdné číslo');
      assert.equal(await pokus({ type: 'received', number: '', supplier: 'Tuzka' }), 'projde', 'prázdné číslo podruhé');
      for (const type of ['issued', 'proforma']) {
        assert.equal(await pokus({ type, number: n('v') }), 'projde');
        assert.equal(await pokus({ type, number: n('v'), supplier: 'Jiny', supplier_ico: '99999999' }), 'blokuje', type);
      }
      assert.equal(await pokus({ type: 'received', number: n('v'), supplier: 'Tuzka' }), 'projde', 'číslo vydané smí mít i přijatá');
      throw ZRUSIT;
    });
  } catch (e) {
    if (e !== ZRUSIT) throw e;
  } finally {
    await sql.end();
  }
});
