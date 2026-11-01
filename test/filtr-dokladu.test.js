// Filtr seznamů dokladů: období bez databáze, hledání, dodavatel, datum a POHODA
// proti běžícímu serveru a lokální databázi u všech tří seznamů.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/filtr-dokladu.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { filtrDokladu, rozsahObdobi } from '../src/filtr-dokladu.js';
import { PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';

describe('období', () => {
  const rozsah = (obdobi, dnes = '2026-11-01') => rozsahObdobi(obdobi, dnes);

  test('měsíce včetně přestupného února a přelomu roku', () => {
    assert.deepEqual(rozsah('tento-mesic'), { od: '2026-11-01', do: '2026-11-30' });
    assert.deepEqual(rozsah('minuly-mesic'), { od: '2026-10-01', do: '2026-10-31' });
    assert.deepEqual(rozsah('minuly-mesic', '2026-01-15'), { od: '2025-12-01', do: '2025-12-31' });
    assert.deepEqual(rozsah('2028-02'), { od: '2028-02-01', do: '2028-02-29' });
    assert.deepEqual(rozsah('2026-02'), { od: '2026-02-01', do: '2026-02-28' });
  });

  test('posledních 30 dní počítá dnešek, roky jsou celé', () => {
    assert.deepEqual(rozsah('30-dni'), { od: '2026-10-03', do: '2026-11-01' });
    assert.deepEqual(rozsah('90-dni', '2026-03-01'), { od: '2025-12-02', do: '2026-03-01' });
    assert.deepEqual(rozsah('tento-rok'), { od: '2026-01-01', do: '2026-12-31' });
    assert.deepEqual(rozsah('minuly-rok'), { od: '2025-01-01', do: '2025-12-31' });
  });

  test('neznámá hodnota ani neplatný měsíc rozsah nedají', () => {
    for (const nesmysl of ['', 'vlastni', '2026-13', '2026-00', '0000-01', '9999-01', 'x', "2026-01' OR 1=1"]) assert.equal(rozsah(nesmysl), null, nesmysl);
  });
});

describe('hodnoty filtru z adresy', () => {
  const now = new Date('2026-11-01T10:00:00Z');

  test('bez parametrů filtr není aktivní', () => {
    const f = filtrDokladu({}, now);
    assert.equal(f.aktivni, false);
    assert.equal(f.obdobi, '');
    assert.equal(f.mesice.length, 24);
    assert.deepEqual(f.mesice[0], { hodnota: '2026-11', popis: 'Listopad 2026' });
    assert.deepEqual(f.mesice[23], { hodnota: '2024-12', popis: 'Prosinec 2024' });
  });

  test('vybrané období má přednost před zapomenutým rozsahem', () => {
    const f = filtrDokladu({ obdobi: '2026-10', od: '2020-01-01', do: '2020-01-31' }, now);
    assert.deepEqual([f.obdobi, f.od, f.do, f.aktivni], ['2026-10', '2026-10-01', '2026-10-31', true]);
  });

  test('ruční rozsah: prohozené meze se srovnají, neplatné datum se zahodí', () => {
    const f = filtrDokladu({ obdobi: 'vlastni', od: '2026-10-31', do: '2026-10-01' }, now);
    assert.deepEqual([f.obdobi, f.od, f.do], ['vlastni', '2026-10-01', '2026-10-31']);
    const g = filtrDokladu({ od: '2026-02-30', do: '2026-10-01' }, now);
    assert.deepEqual([g.obdobi, g.od, g.do], ['vlastni', '', '2026-10-01']);
    const h = filtrDokladu({ od: '0000-01-01', do: '9999-12-31' }, now);
    assert.deepEqual([h.od, h.do, h.aktivni], ['', '', false]);
  });

  test('prázdný Vlastní rozsah nechá pole otevřená, ale nefiltruje', () => {
    const f = filtrDokladu({ obdobi: 'vlastni' }, now);
    assert.deepEqual([f.obdobi, f.aktivni], ['vlastni', false]);
  });

  test('starší měsíc z adresy zůstane v nabídce, pole z adresy nespadne', () => {
    assert.ok(filtrDokladu({ obdobi: '2019-03' }, now).mesice.some(m => m.hodnota === '2019-03'));
    assert.equal(filtrDokladu({ q: ['a', 'b'], pohoda: ['x'], obdobi: ['y'] }, now).q, 'a');
    assert.equal(filtrDokladu({ pohoda: 'nesmysl' }, now).pohoda, '');
  });
});

describe('seznamy dokladů s filtrem', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  let sql; let sid; let req; let uzivatel;
  const faktura = (id, prepis) => ({
    id: `fd-${r}-${id}`, type: 'received', number: `FD${r}${id}`, status: 'Nezaplacena', supplier: `Dodavatel ${r} A`,
    issue_date: '2026-10-15', amount: 100, vat_amount: 21, total_amount: 121, currency: 'CZK', notes: '', ...prepis,
  });
  const obsahuje = async (adresa, id) => (await (await req.get(adresa)).text()).includes(id);

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`fd-${r}@example.invalid`}, 'x', TRUE, TRUE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    req = pozadavky(prihlaseni.cookie);
    for (const radek of [
      faktura('a', { supplier_number: `CD${r}`, supplier_ico: '77889900', notes: `poznamka${r}`, total_amount: 98765.5, source: 'pohoda', pohoda_v_evidenci: true }),
      faktura('b', { supplier: `Dodavatel ${r} B`, issue_date: '2026-09-30', pohoda_exported_at: new Date('2026-10-01T10:00:00Z') }),
      faktura('c', { supplier: `Dodavatel ${r} C`, issue_date: '2025-12-31' }),
      faktura('v', { type: 'issued', supplier: '', client_name: `Klient ${r}`, client_ico: '55443322', issue_date: '2026-10-02' }),
      faktura('z', { type: 'proforma', supplier: '', client_name: `Klient ${r}`, issue_date: '2026-10-03' }),
    ]) await sql`INSERT INTO accounting_invoices ${sql(radek)}`;
    const uctenka = (prepis) => ({ amount: 10, vat_amount: 0, total_amount: 10, currency: 'CZK', category: 'Ostatní', status: 'Nezaúčtována', ...prepis });
    await sql`INSERT INTO receipts ${sql(uctenka({ number: `UA${r}`, vendor: `Prodejce ${r} X`, receipt_date: '2026-10-10', pohoda_exported_at: new Date('2026-10-11T10:00:00Z') }))}`;
    await sql`INSERT INTO receipts ${sql(uctenka({ number: `UB${r}`, vendor: `Prodejce ${r} Y`, receipt_date: '2026-08-10' }))}`;
  });

  after(async () => {
    await sql`DELETE FROM accounting_invoices WHERE id LIKE ${`fd-${r}-%`}`;
    await sql`DELETE FROM receipts WHERE vendor LIKE ${`%${r}%`}`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  const PRIJATE = '/ucetnictvi/prijate-faktury';
  const VYDANE = '/ucetnictvi/vydane-faktury';
  const UCTENKY = '/ucetnictvi/uctenky';
  const prijate = (dotaz) => `${PRIJATE}?dodavatel=${r}&${dotaz}`;

  test('hledání v čísle dodavatele, interním čísle, IČO, poznámce a částce', async () => {
    const [{ internal_number: interni }] = await sql`SELECT internal_number FROM accounting_invoices WHERE id = ${`fd-${r}-a`}`;
    for (const q of [`CD${r}`, interni, `poznamka${r}`]) {
      assert.ok(await obsahuje(`${PRIJATE}?q=${encodeURIComponent(q)}`, `fd-${r}-a`), q);
    }
    assert.ok(await obsahuje(prijate('q=77889900'), `fd-${r}-a`));
    assert.ok(!await obsahuje(prijate('q=77889900'), `fd-${r}-b`));
    assert.ok(await obsahuje(prijate('q=98765,5'), `fd-${r}-a`), 'částka s desetinnou čárkou');
    assert.ok(!await obsahuje(prijate('q=98765,5'), `fd-${r}-b`));
  });

  test('% a _ v hledání jsou obyčejné znaky', async () => {
    assert.ok(!await obsahuje(prijate('q=%25'), `fd-${r}-a`));
    assert.ok(!await obsahuje(prijate('q=___'), `fd-${r}-a`));
  });

  test('dodavatel, měsíc a ruční rozsah', async () => {
    assert.ok(await obsahuje(`${PRIJATE}?dodavatel=${encodeURIComponent(`Dodavatel ${r} B`)}`, `fd-${r}-b`));
    assert.ok(!await obsahuje(`${PRIJATE}?dodavatel=${encodeURIComponent(`Dodavatel ${r} B`)}`, `fd-${r}-a`));
    const rijen = prijate('obdobi=2026-10');
    assert.ok(await obsahuje(rijen, `fd-${r}-a`));
    assert.ok(!await obsahuje(rijen, `fd-${r}-b`), 'poslední zářijový den do října nepatří');
    const hranice = prijate('obdobi=vlastni&od=2026-09-30&do=2026-09-30');
    assert.ok(await obsahuje(hranice, `fd-${r}-b`), 'meze rozsahu platí včetně');
    assert.ok(!await obsahuje(hranice, `fd-${r}-a`));
  });

  test('POHODA: neodeslané a odeslané včetně dokladů v její evidenci', async () => {
    const ne = prijate('pohoda=neodeslano');
    assert.ok(await obsahuje(ne, `fd-${r}-c`));
    assert.ok(!await obsahuje(ne, `fd-${r}-a`));
    assert.ok(!await obsahuje(ne, `fd-${r}-b`));
    const ano = prijate('pohoda=odeslano');
    assert.ok(await obsahuje(ano, `fd-${r}-a`));
    assert.ok(await obsahuje(ano, `fd-${r}-b`));
    assert.ok(!await obsahuje(ano, `fd-${r}-c`));
  });

  test('rok 0000 v adrese stránku neshodí', async () => {
    for (const dotaz of ['od=0000-01-01', 'obdobi=0000-01', 'do=0000-12-31']) {
      assert.equal((await req.get(`${PRIJATE}?${dotaz}`)).status, 200, dotaz);
    }
  });

  test('sloupce Zdroj a POHODA v přijatých', async () => {
    const html = await (await req.get(`${PRIJATE}?dodavatel=${r}`)).text();
    assert.ok(html.includes('<th class="hide-mobile">Zdroj</th>'));
    assert.match(html, />V POHODĚ</);
    assert.match(html, />Odesláno</);
    assert.match(html, />Neodesláno</);
    assert.match(html, /<td class="sekundarni hide-mobile">POHODA<\/td>/);
    assert.match(html, /<td class="sekundarni hide-mobile">Ručně<\/td>/);
  });

  test('filtr přežije stránkování i Zrušit filtr je vidět', async () => {
    const html = await (await req.get(`${PRIJATE}?obdobi=2026-10&dodavatel=${r}&velikost=25`)).text();
    assert.match(html, /class="btn btn-ghost">Zrušit filtr</);
    assert.ok(html.includes(`<option value="${`Dodavatel ${r} A`}">`), 'našeptávač dodavatelů');
    assert.match(html, /<option value="2026-10" selected>/);
    assert.ok(html.includes('data-filtr-rozsah hidden'), 'rozsah je skrytý u hotového období');
  });

  test('vydané: filtr podle klienta drží záložka a počítá ji odznak', async () => {
    const adresa = `${VYDANE}?dodavatel=${r}&obdobi=2026-10`;
    const html = await (await req.get(adresa)).text();
    assert.ok(html.includes(`fd-${r}-v`));
    assert.ok(!html.includes(`fd-${r}-z`), 'zálohová je na druhé záložce');
    assert.ok(html.includes(`typ=zalohove&amp;dodavatel=${r}&amp;obdobi=2026-10`), html.match(/typ=zalohove[^"]*/)?.[0]);
    assert.ok(await obsahuje(`${VYDANE}?typ=zalohove&dodavatel=${r}`, `fd-${r}-z`));
    assert.ok(await obsahuje(`${VYDANE}?q=55443322&dodavatel=${r}`, `fd-${r}-v`), 'IČO klienta');
    assert.ok(!await obsahuje(`${VYDANE}?dodavatel=${r}&obdobi=2026-09`, `fd-${r}-v`));
  });

  test('účtenky: dodavatel, období a POHODA, interní číslo v řádku', async () => {
    const [a, b] = await sql`SELECT id, internal_number FROM receipts WHERE vendor LIKE ${`Prodejce ${r}%`} ORDER BY number`;
    const radek = (id) => `/ucetnictvi/uctenky/${id}"`;
    assert.ok(await obsahuje(`${UCTENKY}?dodavatel=${r}&obdobi=2026-10`, radek(a.id)));
    assert.ok(!await obsahuje(`${UCTENKY}?dodavatel=${r}&obdobi=2026-10`, radek(b.id)));
    assert.ok(await obsahuje(`${UCTENKY}?dodavatel=${r}&pohoda=neodeslano`, radek(b.id)));
    assert.ok(!await obsahuje(`${UCTENKY}?dodavatel=${r}&pohoda=neodeslano`, radek(a.id)));
    const html = await (await req.get(`${UCTENKY}?dodavatel=${r}`)).text();
    assert.ok(html.includes(a.internal_number));
    assert.match(html, />Odesláno</);
    assert.match(html, />Neodesláno</);
    assert.ok(await obsahuje(`${UCTENKY}?q=${a.internal_number}`, radek(a.id)), 'hledání interního čísla');
  });
});
