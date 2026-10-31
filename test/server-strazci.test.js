// Hlídání na úrovni serveru proti běžícímu serveru a lokální databázi: přístupová
// matice nesmí jít obejít zakódovanou cestou, deaktivovaný účet s živou session
// se k routě nedostane a neočekávaná chyba ukáže prohlížeči stránku místo
// surového JSONu, zatímco API dál dostává JSON.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \\
//   SESSION_SECRET=<stejný jako server> node --test test/server-strazci.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { BASE, PRESKOCIT, lokalniDatabaze, serverBezi, prihlas, pozadavky } from './pomocnici/server.js';

describe('proti serveru', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(4).toString('hex');
  const firma = `tstrf${r}`, faktura = `tstrp${r}`;
  const uklid = { users: [], sids: [] };
  let sql, omezeny, neaktivni, spravce;

  async function uzivatel(prefix, sloupce = {}) {
    const [u] = await sql`INSERT INTO users (email, password_hash, first_name, last_name, is_admin, is_active)
      VALUES (${`${prefix}-${r}@example.invalid`}, 'x', 'Test', ${prefix}, ${sloupce.is_admin ?? false}, TRUE) RETURNING id`;
    uklid.users.push(u.id);
    const { sid, cookie } = await prihlas(sql, u.id);
    uklid.sids.push(sid);
    return { id: u.id, sid, cookie, http: pozadavky(cookie) };
  }

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    omezeny = await uzivatel('omezeny');
    neaktivni = await uzivatel('neaktivni');
    spravce = await uzivatel('spravce', { is_admin: true });
    for (const klic of ['crm.firmy', 'ucetnictvi.banka']) {
      await sql`INSERT INTO user_access (user_id, access_key, allowed) VALUES (${omezeny.id}, ${klic}, FALSE)`;
    }
    await sql`INSERT INTO crm_companies (id, name, company_type, notes) VALUES (${firma}, ${`Strážci ${r}`}, 'Zákazník', 'Původní')`;
    await sql`INSERT INTO accounting_invoices (id, type, number, supplier, amount, vat_amount, total_amount, currency, issue_date, status)
      VALUES (${faktura}, 'received', ${`PS-${r}`}, 'Dodavatel', 1, 0, 1, 'CZK', '2026-02-02', 'Nezaplacena')`;
  });

  after(async () => {
    if (!sql) return;
    await sql`DELETE FROM accounting_invoices WHERE id = ${faktura}`;
    await sql`DELETE FROM crm_companies WHERE id = ${firma}`;
    if (uklid.sids.length) await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
    if (uklid.users.length) await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
    await sql.end();
  });

  test('matice: zakódovaná cesta nic neobejde, čtení ani zápis', async () => {
    for (const cesta of [`/crm/firmy/${firma}`, `/crm/%66irmy/${firma}`, `/%63rm/firmy/${firma}`]) {
      assert.equal((await omezeny.http.get(cesta)).status, 403, cesta);
    }
    for (const cesta of [`/crm/firmy/${firma}/poznamky`, `/crm/%66irmy/${firma}/poznamky`]) {
      assert.equal((await omezeny.http.post(cesta, { notes: 'obchvat' })).status, 403, cesta);
    }
    const [f] = await sql`SELECT notes FROM crm_companies WHERE id = ${firma}`;
    assert.equal(f.notes, 'Původní');
    assert.equal((await spravce.http.get(`/crm/%66irmy/${firma}`)).status, 200, 'komu sekce patří, tomu zakódovaná cesta dál funguje');
  });

  test('matice: seznam dokladů pro párování hlídá právo na banku', async () => {
    assert.equal((await omezeny.http.get('/api/banka/doklady?type=invoice&q=')).status, 403);
    assert.equal((await spravce.http.get('/api/banka/doklady?type=invoice&q=')).status, 200);
  });

  test('deaktivovaný účet: živá session nedojde k routě ani jediným požadavkem', async () => {
    await sql`UPDATE users SET is_active = FALSE WHERE id = ${neaktivni.id}`;
    const res = await neaktivni.http.post(`/crm/firmy/${firma}/poznamky`, { notes: 'po deaktivaci' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/prihlasit');
    const [f] = await sql`SELECT notes FROM crm_companies WHERE id = ${firma}`;
    assert.equal(f.notes, 'Původní');
    assert.equal((await sql`SELECT 1 FROM session WHERE sid = ${neaktivni.sid}`).length, 0, 'session je pryč');
    assert.equal((await neaktivni.http.get('/health')).status, 200, 'veřejná cesta se starou cookie dál odpoví');
  });

  test('neočekávaná chyba: prohlížeč dostane stránku, API a fetch JSON', async () => {
    const telo = new URLSearchParams({ number: `PS-${r}`, supplier: 'X', issue_date: '2026-02-02', amount: '99999999999' }); // přetečení DECIMAL(12,2)
    const cesta = `${BASE}/ucetnictvi/prijate-faktury/${faktura}/upravit`;
    const hlavicky = { cookie: spravce.cookie, 'content-type': 'application/x-www-form-urlencoded' };

    const html = await fetch(cesta, { method: 'POST', redirect: 'manual', headers: { ...hlavicky, accept: 'text/html,application/xhtml+xml' }, body: telo });
    assert.equal(html.status, 500);
    assert.match(html.headers.get('content-type'), /text\/html/);
    const stranka = await html.text();
    assert.ok(stranka.includes('Chyba serveru') && stranka.includes('history.back()'), 'stránka s cestou zpět');

    const json = await fetch(cesta, { method: 'POST', redirect: 'manual', headers: hlavicky, body: telo });
    assert.equal(json.status, 500);
    assert.match(json.headers.get('content-type'), /application\/json/);
    assert.equal((await json.json()).statusCode, 500);

    const klient = await fetch(cesta, { method: 'POST', redirect: 'manual', headers: { cookie: spravce.cookie, accept: 'text/html', 'content-type': 'application/nesmysl' }, body: 'x' });
    assert.equal(klient.status, 415, 'chyba klienta si nechá svůj kód');
  });
});
