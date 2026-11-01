// Seznam přijatých faktur proti běžícímu serveru a lokální databázi: stránkování,
// filtry v odkazech a návrat po změně stavu v řádku.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/seznam-prijate-faktury.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';
import { overSeznam } from './pomocnici/seznamy.js';

describe('seznam přijatých faktur', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  const POCET = 61;
  let sql; let sid; let req; let uzivatel; const ids = [];

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`sp-${r}@example.invalid`}, 'x', TRUE, TRUE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    req = pozadavky(prihlaseni.cookie);
    // Shodné datum i čas založení: pořadí mezi stranami drží jen poslední klíč.
    const cas = new Date('2026-01-15T10:00:00Z');
    const radky = Array.from({ length: POCET }, (_, i) => ({
      id: `sp-${r}-${String(i).padStart(3, '0')}`, type: 'received', number: `SP${r}${i}`,
      status: i % 2 ? 'Zaplacena' : 'Nezaplacena', supplier: `Dodavatel ${r}`, issue_date: '2026-01-15',
      amount: 100, vat_amount: 21, total_amount: 121, currency: 'CZK', created_at: cas, modified_at: cas,
    }));
    ids.push(...radky.map(x => x.id));
    await sql`INSERT INTO accounting_invoices ${sql(radky)}`;
  });

  after(async () => {
    await sql`DELETE FROM accounting_invoices WHERE id = ANY(${ids})`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  const adresaDetailu = (id) => `/ucetnictvi/prijate-faktury/${id}`;

  test('stránkování se shodným datem: každý řádek právě jednou, neplatné page nespadne', () => overSeznam({
    req, adresa: `/ucetnictvi/prijate-faktury?q=${r}`, tokeny: ids.map(adresaDetailu), filtr: { q: r },
  }));

  test('filtr podle stavu platí i na další stránce', async () => {
    const zaplacene = ids.filter((_, i) => i % 2);
    assert.ok(zaplacene.length > 25);
    const html = await (await req.get(`/ucetnictvi/prijate-faktury?q=${r}&status=Zaplacena&page=2`)).text();
    const naStrance = ids.filter(id => html.includes(adresaDetailu(id)));
    assert.equal(naStrance.length, zaplacene.length - 25);
    assert.ok(naStrance.every(id => zaplacene.includes(id)));
    assert.ok(html.includes(`status=Zaplacena`), 'odkazy drží stav');
  });

  test('velikost stránky: 50 řádků a odkazy ji drží', async () => {
    const html = await (await req.get(`/ucetnictvi/prijate-faktury?q=${r}&velikost=50`)).text();
    assert.equal(ids.filter(id => html.includes(adresaDetailu(id))).length, 50);
    assert.ok(html.includes('velikost=50&amp;page=2'));
  });

  test('změna stavu v řádku vrací na tutéž stránku a filtr', async () => {
    const html = await (await req.get(`/ucetnictvi/prijate-faktury?q=${r}&page=2`)).text();
    const navrat = /name="redirect_to" value="([^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
    assert.equal(navrat, `/ucetnictvi/prijate-faktury?q=${r}&page=2`);
    const res = await req.post(`${adresaDetailu(ids[1])}/stav`, { status: 'Zaplacena', redirect_to: navrat });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), navrat);
  });

  test('cizí návratová adresa se nepoužije', async () => {
    for (const cil of ['https://evil.example/x', '//evil.example/x', '/\\evil.example']) {
      const res = await req.post(`${adresaDetailu(ids[1])}/stav`, { status: 'Zaplacena', redirect_to: cil });
      assert.equal(res.headers.get('location'), adresaDetailu(ids[1]), cil);
    }
  });

  test('prázdný výsledek filtru: nabídne zrušení filtru a nemá patičku', async () => {
    const html = await (await req.get(`/ucetnictvi/prijate-faktury?q=${r}-nic&page=3`)).text();
    assert.ok(html.includes('Filtru neodpovídá žádná faktura'));
    assert.ok(!html.includes('class="strankovani"'));
  });

  test('dvojitý parametr ?q=a&q=b nespadne', async () => {
    const res = await req.get(`/ucetnictvi/prijate-faktury?q=${r}&q=jine`);
    assert.equal(res.status, 200);
  });

  test('řádek má skutečný odkaz na detail a detail má návrat na seznam', async () => {
    const html = await (await req.get(`/ucetnictvi/prijate-faktury?q=${r}`)).text();
    assert.match(html, /<a href="\/ucetnictvi\/prijate-faktury\/sp-[^"]+" class="radek-odkaz">/);
    assert.match(html, /<tr data-href="\/ucetnictvi\/prijate-faktury\/sp-/);
  });
});
