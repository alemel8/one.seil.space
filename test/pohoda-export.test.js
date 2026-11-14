// Export přijatých faktur do POHODY přes routu, proti běžícímu serveru a lokální
// databázi: doklad v cizí měně jde s částkami v té měně a doklad bez předkontace
// převezme zkratky z předchozí faktury téhož dodavatele (migrace 050).
// Generátor XML sám testuje test/pohoda.test.js, tady jde o napojení na data.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/pohoda-export.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { PRESKOCIT, lokalniDatabaze, serverBezi, prihlas, pozadavky } from './pomocnici/server.js';

describe('export přijatých faktur do POHODY', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(4).toString('hex').toUpperCase();
  const dodavatel = `Vzorovy dodavatel ${r}, Inc.`;
  const historie = `tpx-h-${r}`;
  const nova = `tpx-n-${r}`;
  const den = '2026-11-05';
  let sql, req, sid, userId;

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const [u] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`px-${r}@example.invalid`}, 'x', 'Test', 'Export', TRUE) RETURNING id`;
    userId = u.id;
    const prihlaseni = await prihlas(sql, userId);
    sid = prihlaseni.sid;
    req = pozadavky(prihlaseni.cookie);

    // Faktura, kterou účetní zaúčtovala v POHODĚ (přišla importem exportu) …
    await sql`
      INSERT INTO accounting_invoices (id, type, number, supplier_number, supplier, amount, vat_amount, total_amount,
                                       currency, issue_date, status, source, pohoda_v_evidenci, pohoda_predkontace, pohoda_cleneni_dph)
      VALUES (${historie}, 'received', ${`2611${r}`}, ${`${r}-0025`}, ${`${dodavatel} @market street`}, 3913.38, 0, 3913.38,
              'CZK', '2026-10-25', 'Zaplacena', 'pohoda', TRUE, '11Fp', 'bez')`;
    // … a nová z Disku v eurech, bez předkontace.
    await sql`
      INSERT INTO accounting_invoices (id, type, number, supplier, amount, vat_amount, total_amount, currency, issue_date, status, source)
      VALUES (${nova}, 'received', ${`${r}-0034`}, ${dodavatel}, 12.41, 0, 12.41, 'EUR', ${den}, 'Zaplacena', 'gdrive')`;
  });

  after(async () => {
    if (!sql) return;
    await sql`DELETE FROM accounting_invoices WHERE id IN (${historie}, ${nova})`;
    if (sid) await sql`DELETE FROM session WHERE sid = ${sid}`;
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.end();
  });

  test('eura v cizí měně, předkontace a členění z předchozí faktury dodavatele', async () => {
    const res = await req.post('/ucetnictvi/prijate-faktury/pohoda-xml', [['ids', nova]]);
    assert.equal(res.status, 200);
    const xml = await res.text();

    assert.match(xml, new RegExp(`<inv:originalDocument>${r}-0034</inv:originalDocument>`));
    assert.match(xml, /<inv:foreignCurrency>\s*<typ:unitPrice>12\.41<\/typ:unitPrice>/, 'částka položky v eurech');
    assert.match(xml, /<typ:currency>\s*<typ:ids>EUR<\/typ:ids>\s*<\/typ:currency>/);
    assert.doesNotMatch(xml, /<inv:homeCurrency>|<typ:rate>/, 'kurz a koruny doplní POHODA ze svého lístku');
    assert.match(xml, /<inv:accounting>\s*<typ:ids>11Fp<\/typ:ids>/, 'předkontace z předchozí faktury');
    assert.match(xml, /<inv:classificationVAT>\s*<typ:ids>bez<\/typ:ids>/, 'členění z předchozí faktury');

    const [radek] = await sql`SELECT pohoda_exported_at, pohoda_predkontace FROM accounting_invoices WHERE id = ${nova}`;
    assert.ok(radek.pohoda_exported_at, 'datum exportu zapsané');
    assert.equal(radek.pohoda_predkontace, '', 'vzor se k dokladu neukládá, zkratky zapisuje jen import z POHODY');
  });

  test('detail nové faktury ukáže, co export převezme', async () => {
    // Interní číslo PF26-… přidělí přijaté faktuře trigger (migrace 047).
    const [{ cislo }] = await sql`SELECT COALESCE(internal_number, number) AS cislo FROM accounting_invoices WHERE id = ${historie}`;
    const html = await (await req.get(`/ucetnictvi/prijate-faktury/${nova}`)).text();
    assert.ok(html.includes(`11Fp (jako ${cislo})`), 'předkontace ze vzoru s číslem faktury, odkud je');
    assert.ok(html.includes(`bez (jako ${cislo})`), 'členění ze vzoru');
  });
});
