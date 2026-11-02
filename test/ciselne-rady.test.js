// Číselné řady po okruzích (SEIL v Nastavení firmy, e-shop ve svém detailu),
// číslování po letech a duplikace vydané faktury. Serverová část jede proti
// běžícímu serveru a lokální databázi, zakládá vlastní řady a po sobě je uklidí.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/ciselne-rady.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { nahledRady, radaPodleCisla, rokVPraze } from '../src/series-format.js';
import { predlohaDuplikatu } from '../src/routes/invoices.js';
import { vykresliStranku, zkontrolujDetail } from './pomocnici/render.js';
import { PRESKOCIT, lokalniDatabaze, serverBezi, prihlas, pozadavky } from './pomocnici/server.js';

const LEDEN_2027 = new Date('2027-01-05T12:00:00Z');
const RIJEN_2026 = new Date('2026-10-05T12:00:00Z');
const rada = (over = {}) => ({ format: '21YYNNNN', current_number: 23, start_number: 1, rok_citace: 2026, ...over });

describe('náhled řady', () => {
  test('v roce čítače pokračuje, v novém roce začíná znovu', () => {
    assert.deepEqual(nahledRady(rada(), RIJEN_2026), { poradi: 24, cislo: '21260024' });
    assert.deepEqual(nahledRady(rada(), LEDEN_2027), { poradi: 1, cislo: '21270001' });
  });
  test('bez roku v čísle, bez pořadí nebo s neznámým rokem čítače se nerestartuje', () => {
    assert.equal(nahledRady(rada({ format: 'FV-NNNN' }), LEDEN_2027).poradi, 24);
    assert.equal(nahledRady(rada({ format: 'YYMMXXXX' }), LEDEN_2027).poradi, 24);
    assert.equal(nahledRady(rada({ rok_citace: null }), LEDEN_2027).poradi, 24);
    assert.equal(nahledRady({ prefix: 'FV', year: 2026, padding: 4, current_number: 41 }, LEDEN_2027).cislo, 'FV-2026-0042');
  });
  test('rok je pražský, ne podle pásma procesu', () => {
    assert.equal(nahledRady(rada(), new Date('2026-12-31T23:30:00Z')).cislo, '21270001');
    assert.equal(nahledRady(rada(), new Date('2026-12-31T22:30:00Z')).cislo, '21260024');
  });
});

describe('řada podle čísla', () => {
  const rady = [{ id: 1, format: '21YYNNNN' }, { id: 2, format: '25YYNNNN' }, { id: 3, format: 'ZF-YYYYNNNN' }, { id: 4, format: 'YYYYNNNN' }, { id: 5, format: null }];
  test('najde řadu podle předčíslí, řady SEIL mají přednost před obecným formátem e-shopu', () => {
    assert.equal(radaPodleCisla('25260011', rady).id, 2);
    assert.equal(radaPodleCisla('21250029', rady).id, 1);
    assert.equal(radaPodleCisla('20260003', rady).id, 4);
    assert.equal(radaPodleCisla('ZF-20260042', rady).id, 3);
  });
  test('cizí tvar řadu nemá a pomlčka ve formátu není zástupný znak', () => {
    assert.equal(radaPodleCisla('260400001', rady), null);
    assert.equal(radaPodleCisla('ZFX20260042', rady), null);
    assert.equal(radaPodleCisla(null, rady), null);
  });
});

describe('předloha duplikátu', () => {
  const zdroj = {
    id: 'A', number: '21260023', series_id: 9, client_name: 'Klient', client_ico: '1', client_dic: '2', client_address: 'A', client_email: 'k@example.invalid',
    currency: 'EUR', account_debit: '311', account_credit: '604', issue_date: new Date('2026-09-01T00:00:00Z'), due_date: '2026-09-22',
    notes: 'Poznámka\n  druhý řádek', amount: '1000.00', vat_amount: '210.00', total_amount: '1210.00', status: 'Zaplacena', paid_date: '2026-09-10', order_id: 'O', pohoda_v_evidenci: true,
  };
  const polozka = { name: 'P', quantity: 2, unit: 'h', price_per_unit: 500, vat_rate: 21 };

  test('dnešní datum, stejně dlouhá splatnost, úhrada a vazby se nepřebírají', () => {
    const p = predlohaDuplikatu(zdroj, [polozka], '2026-11-02');
    assert.equal(p.issue_date, '2026-11-02');
    assert.equal(p.due_date, '2026-11-23');
    assert.deepEqual(p.polozky, [polozka]);
    assert.equal(p.notes, zdroj.notes);
    assert.equal(p.currency, 'EUR');
    for (const k of ['status', 'paid_date', 'order_id', 'pohoda_v_evidenci', 'taxable_date']) assert.ok(!(k in p), k);
  });
  test('bez splatnosti 14 dní', () => {
    assert.equal(predlohaDuplikatu({ ...zdroj, due_date: null }, [polozka], '2026-11-02').due_date, '2026-11-16');
  });
  test('faktura z POHODY bez položek: jeden řádek z textu a součtů, text se v poznámce neopakuje', () => {
    const p = predlohaDuplikatu(zdroj, [], '2026-11-02');
    assert.deepEqual(p.polozky, [{ name: 'Poznámka druhý řádek', quantity: 1, unit: 'ks', price_per_unit: 1000, vat_rate: 21 }]);
    assert.equal(p.notes, '');
    assert.equal(predlohaDuplikatu({ ...zdroj, notes: '' }, [], '2026-11-02').polozky[0].name, 'Plnění dle faktury');
    assert.equal(predlohaDuplikatu({ ...zdroj, vat_amount: '0' }, [], '2026-11-02').polozky[0].vat_rate, 0);
  });
});

describe('šablony', () => {
  const radek = { id: 3, name: 'Řada <b>', entity_type: 'faktura', format: '21YYNNNN', current_number: 23, start_number: 1, active: true, poradi: 24, cislo: '21260024' };
  const firma = (prepis) => vykresliStranku('settings/company', {
    pageTitle: 'Nastavení firmy', currentPath: '/nastaveni/firma', company: {}, saved: false, error: null, rezimUprav: false,
    tab: 'rady', zalozky: [['rady', 'Číselné řady', 'formRady']], serviceAccount: '', chybaKontroly: '', rady: [radek], ...prepis,
  });

  test('záložka řad v Nastavení firmy: tužka, pole řádku a POST na okruh SEIL', async () => {
    for (const rezimUprav of [false, true]) {
      const html = await firma({ rezimUprav });
      zkontrolujDetail(html, { formular: 'formRady', sloupce: ['name_3', 'format_3', 'dalsi_3'], rezim: rezimUprav ? 'upravy' : 'zobrazeni' });
      assert.ok(html.includes('action="/nastaveni/firma/rady/ulozit"'));
      assert.ok(html.includes('21260024'));
      assert.ok(html.includes('Řada &lt;b&gt;') && !html.includes('Řada <b>'));
      assert.ok(!html.includes('name="entity_type"'), 'SEIL zakládá jen řady faktur');
    }
  });
  test('prázdná záložka nemá tužku, jen tlačítko nové řady', async () => {
    const html = await firma({ rady: [] });
    assert.ok(!html.includes('upravit-otevrit'));
    assert.ok(html.includes('data-modal-open="modalNovaRada"'));
  });
  test('řada bez pořadí v čísle pole pro pořadí nemá', async () => {
    const html = await firma({ rady: [{ ...radek, format: 'YYMMXXXX', entity_type: 'objednavka' }], rezimUprav: true });
    assert.ok(!html.includes('name="dalsi_3"'));
  });
  test('menu Nastavení ani přístupy řady neznají', () => {
    const koren = new URL('../', import.meta.url);
    assert.ok(!readFileSync(new URL('views/includes/sidebar.ejs', koren), 'utf8').includes('ciselne-rady'));
    assert.ok(!readFileSync(new URL('src/access.js', koren), 'utf8').includes('ciselne-rady'));
  });
  test('stránky se neomezují na šířku: karta ani obal záložky nemá max-width', () => {
    const koren = fileURLToPath(new URL('../views/', import.meta.url));
    // Hledací pole a přihlášení úzké být mají, modaly mají šířku ve vlastní třídě.
    const vyjimky = new Set(['hledani.ejs', 'team.ejs', 'login.ejs']);
    const projdi = (d) => readdirSync(d).flatMap(n => statSync(d + n).isDirectory() ? projdi(d + n + '/') : [d + n]);
    for (const soubor of projdi(koren).filter(f => f.endsWith('.ejs') && !vyjimky.has(f.split('/').pop()) && !f.includes('/errors/'))) {
      const nalez = readFileSync(soubor, 'utf8').match(/<div\b(?:(?!>)[\s\S])*style="(?:(?!")[\s\S])*max-width:\s*[0-9]{3,}px/g) || [];
      const stranka = nalez.filter(n => !/\bmodal\b/.test(n));
      assert.deepEqual(stranka, [], soubor);
    }
  });
});

describe('migrace 048', { skip: PRESKOCIT }, () => {
  test('čítač je vyšší z exportu a databáze, opakovaný běh nic nezaloží', async () => {
    const sql = postgres(lokalniDatabaze(), { max: 1, onnotice: () => {} });
    const obsah = readFileSync(new URL('../migrations/048_rady_seil_a_rocni_cislovani.sql', import.meta.url), 'utf8');
    const rr = String(rokVPraze() % 100);
    await assert.rejects(sql.begin(async tx => {
      await tx`DELETE FROM invoice_number_series WHERE shop_id IS NULL AND format IN ('21YYNNNN', '23YYNNNN', '25YYNNNN')`;
      await tx`INSERT INTO accounting_invoices (id, type, number, issue_date) VALUES (${'TEST-M-' + rr}, 'issued', ${`21${rr}0040`}, CURRENT_DATE)`;
      await tx.unsafe(obsah);
      await tx.unsafe(obsah);
      const rady = await tx`SELECT format, current_number, rok_citace, entity_type, shop_id FROM invoice_number_series WHERE shop_id IS NULL AND format ~ '^2[135]YYNNNN$' ORDER BY format`;
      assert.equal(rady.length, 3);
      assert.equal(rady[0].current_number, 40);
      if (rokVPraze() === 2026) assert.deepEqual(rady.map(r => r.current_number), [40, 2, 11]);
      assert.ok(rady.every(r => r.rok_citace === rokVPraze() && r.entity_type === 'faktura'));
      throw new Error('vrátit');
    }), /vrátit/);
    await sql.end();
  });
});

describe('proti serveru', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(3).toString('hex');
  // Malá písmena formát nečte jako tokeny, velké D by s dalším D dalo den v čísle.
  const predcisli = `te${r}`;
  const FORMAT = `${predcisli}-YYNNNN`;
  const rok = rokVPraze();
  const rr = String(rok % 100);
  let sql, req;
  const uklid = { sids: [], users: [], rady: [], shops: [], faktury: [] };
  let eshop;

  const polozka = { item_name: 'Služba', item_qty: '2', item_unit: 'h', item_price: '500', item_vat: '21' };
  const zaloz = async (telo) => {
    const res = await req.post('/ucetnictvi/vydane-faktury/vytvorit', { client_name: `Klient ${r}`, ...polozka, ...telo });
    const adresa = res.headers.get('location') || '';
    const id = !adresa.includes('formError') ? adresa.split('/').pop() : null;
    if (id) uklid.faktury.push(id);
    return { adresa, id };
  };
  const rada = async (format, shopId = null, over = {}) => {
    const [radek] = await sql`
      INSERT INTO invoice_number_series (name, prefix, format, current_number, start_number, padding, shop_id, entity_type, active, rok_citace)
      VALUES (${`Řada ${format}`}, '', ${format}, 0, 1, 4, ${shopId}, ${over.entity_type || 'faktura'}, ${over.active ?? true}, ${rok}) RETURNING *`;
    uklid.rady.push(radek.id);
    return radek;
  };
  const cti = async (id) => (await sql`SELECT * FROM invoice_number_series WHERE id = ${id}`)[0];

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 3, onnotice: () => {} });
    await serverBezi();
    const [admin] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_active, is_admin)
      VALUES (${`rady-${r}@example.invalid`}, 'x', 'Test', 'Řady', TRUE, TRUE) RETURNING id`;
    uklid.users.push(admin.id);
    const s = await prihlas(sql, admin.id);
    uklid.sids.push(s.sid);
    req = pozadavky(s.cookie);
    [eshop] = await sql`INSERT INTO shops (slug, name, url, active) VALUES (${`rady-${r}`}, ${`E-shop ${r}`}, '', TRUE) RETURNING *`;
    uklid.shops.push(eshop.id);
  });

  after(async () => {
    if (!sql) return;
    if (uklid.faktury.length) {
      await sql`DELETE FROM accounting_invoice_items WHERE invoice_id = ANY(${uklid.faktury})`;
      await sql`DELETE FROM accounting_invoices WHERE id = ANY(${uklid.faktury})`;
    }
    if (uklid.rady.length) await sql`DELETE FROM invoice_number_series WHERE id = ANY(${uklid.rady})`;
    await sql`DELETE FROM invoice_number_series WHERE name LIKE ${`%${r}%`}`;
    if (uklid.shops.length) await sql`DELETE FROM shops WHERE id = ANY(${uklid.shops})`;
    if (uklid.sids.length) await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
    if (uklid.users.length) await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
    await sql.end();
  });

  test('stará adresa vede do Nastavení firmy, obě záložky se vykreslí', async () => {
    const res = await req.get('/nastaveni/ciselne-rady');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/nastaveni/firma?tab=rady');
    assert.ok((await (await req.get('/nastaveni/firma?tab=rady')).text()).includes('/nastaveni/firma/rady/vytvorit'));
    assert.ok((await (await req.get(`/nastaveni/eshopy/${eshop.id}?tab=rady`)).text()).includes(`/nastaveni/eshopy/${eshop.id}/rady/vytvorit`));
  });

  test('založení: SEIL jen faktura bez e-shopu, e-shop svůj druh a pokračování od zadaného pořadí', async () => {
    let res = await req.post('/nastaveni/firma/rady/vytvorit', { name: `SEIL ${r}`, format: `${FORMAT}a`, dalsi: '24', entity_type: 'objednavka', shop_id: String(eshop.id) });
    assert.equal(res.headers.get('location'), '/nastaveni/firma?tab=rady&saved=1');
    const [seil] = await sql`SELECT * FROM invoice_number_series WHERE name = ${`SEIL ${r}`}`;
    assert.equal(seil.shop_id, null);
    assert.equal(seil.entity_type, 'faktura');
    assert.equal(seil.current_number, 23);
    assert.equal(seil.start_number, 1, 'příští rok začne od jedničky, ne od pokračování');

    res = await req.post(`/nastaveni/eshopy/${eshop.id}/rady/vytvorit`, { name: `Obj ${r}`, format: 'YYMMXXXX', dalsi: '1', entity_type: 'objednavka' });
    assert.equal(res.headers.get('location'), `/nastaveni/eshopy/${eshop.id}?tab=rady&saved=1`);
    const [obj] = await sql`SELECT * FROM invoice_number_series WHERE name = ${`Obj ${r}`}`;
    assert.equal(obj.shop_id, eshop.id);
    assert.equal(obj.entity_type, 'objednavka');
  });

  test('založení odmítne prázdný název, formát bez pořadí, cizí znaky a pořadí pod 1', async () => {
    const pokus = async (telo) => (await req.post('/nastaveni/firma/rady/vytvorit', { name: `X ${r}`, format: FORMAT, dalsi: '1', ...telo })).headers.get('location');
    assert.match(await pokus({ name: ' ' }), /error=rada-nazev/);
    assert.match(await pokus({ format: 'YYYY' }), /error=rada-format/);
    assert.match(await pokus({ format: 'YYMMXXXX' }), /error=rada-format/);
    assert.match(await pokus({ format: 'A<b>NNN' }), /error=rada-format/);
    assert.match(await pokus({ dalsi: '0' }), /error=rada-poradi/);
    assert.match(await pokus({ dalsi: '1.5' }), /error=rada-poradi/);
    assert.equal((await sql`SELECT 1 FROM invoice_number_series WHERE name = ${`X ${r}`}`).length, 0);
  });

  test('uložení: změní název, formát a pořadí, obsazené číslo odmítne a neuloží nic', async () => {
    const a = await rada(`${predcisli}b-YYNNNN`);
    await sql`UPDATE invoice_number_series SET current_number = 9 WHERE id = ${a.id}`;
    let res = await req.post('/nastaveni/firma/rady/ulozit', { [`name_${a.id}`]: `Nová ${r}`, [`format_${a.id}`]: a.format, [`dalsi_${a.id}`]: '30' });
    assert.equal(res.headers.get('location'), '/nastaveni/firma?tab=rady&saved=1');
    let radek = await cti(a.id);
    assert.equal(radek.name, `Nová ${r}`);
    assert.equal(radek.current_number, 29);

    const obsazene = `${predcisli}b-${rr}0030`;
    const [{ id }] = await sql`INSERT INTO accounting_invoices (id, type, number, issue_date) VALUES (${`TEST-${r}-O`}, 'issued', ${obsazene}, CURRENT_DATE) RETURNING id`;
    uklid.faktury.push(id);
    res = await req.post('/nastaveni/firma/rady/ulozit', { [`name_${a.id}`]: 'Jiná', [`format_${a.id}`]: a.format, [`dalsi_${a.id}`]: '30' });
    assert.ok(res.headers.get('location').includes('saved=1'), 'beze změny pořadí se obsazenost nekontroluje');

    await sql`UPDATE invoice_number_series SET current_number = 40 WHERE id = ${a.id}`;
    res = await req.post('/nastaveni/firma/rady/ulozit', { [`name_${a.id}`]: 'Třetí', [`format_${a.id}`]: a.format, [`dalsi_${a.id}`]: '30' });
    assert.match(res.headers.get('location'), /error=rada-obsazena&upravit=1/, 'starý formulář nevrátí čítač přes vydanou fakturu');
    radek = await cti(a.id);
    assert.equal(radek.current_number, 40);
    assert.notEqual(radek.name, 'Třetí');
  });

  test('okruh: přes e-shop nejde měnit řadu SEIL ani řadu jiného e-shopu', async () => {
    const seil = await rada(`${predcisli}c-YYNNNN`);
    await req.post(`/nastaveni/eshopy/${eshop.id}/rady/ulozit`, { [`name_${seil.id}`]: 'Cizí', [`format_${seil.id}`]: seil.format, [`dalsi_${seil.id}`]: '99' });
    await req.post(`/nastaveni/eshopy/${eshop.id}/rady/${seil.id}/aktivni`, { aktivni: '0' });
    // Nesmyslné id e-shopu nesmí spadnout do okruhu SEIL.
    await req.post(`/nastaveni/eshopy/abc/rady/ulozit`, { [`name_${seil.id}`]: 'Cizí', [`format_${seil.id}`]: seil.format, [`dalsi_${seil.id}`]: '99' });
    await req.post(`/nastaveni/eshopy/abc/rady/${seil.id}/aktivni`, { aktivni: '0' });
    const radek = await cti(seil.id);
    assert.equal(radek.name, seil.name);
    assert.equal(radek.current_number, 0);
    assert.equal(radek.active, true);

    await req.post(`/nastaveni/firma/rady/${seil.id}/aktivni`, { aktivni: '0' });
    assert.equal((await cti(seil.id)).active, false);
    await req.post(`/nastaveni/firma/rady/${seil.id}/aktivni`, { aktivni: '1' });
    assert.equal((await cti(seil.id)).active, true);
  });

  test('faktura z řady: číslo, řada a e-shop řady; ručně psané číslo řada přebije', async () => {
    const seil = await rada(`${predcisli}d-YYNNNN`);
    const { id } = await zaloz({ series_id: String(seil.id), number: 'RUCNE-1' });
    const [f] = await sql`SELECT * FROM accounting_invoices WHERE id = ${id}`;
    assert.equal(f.number, `${predcisli}d-${rr}0001`);
    assert.equal(f.series_id, seil.id);
    assert.equal(f.shop_id, null);

    const vlastni = await rada(`${predcisli}e-YYNNNN`, eshop.id);
    const z = await zaloz({ series_id: String(vlastni.id) });
    assert.equal((await sql`SELECT shop_id FROM accounting_invoices WHERE id = ${z.id}`)[0].shop_id, eshop.id);

    const rucne = await zaloz({ number: `RUCNE-${r}` });
    const [fr] = await sql`SELECT series_id, number FROM accounting_invoices WHERE id = ${rucne.id}`;
    assert.equal(fr.series_id, null);
    assert.equal(fr.number, `RUCNE-${r}`);
  });

  test('nepovedené založení číslo nespotřebuje a obsazené číslo řekne, kde to opravit', async () => {
    const a = await rada(`${predcisli}f-YYNNNN`);
    const [{ id }] = await sql`INSERT INTO accounting_invoices (id, type, number, issue_date) VALUES (${`TEST-${r}-F`}, 'issued', ${`${predcisli}f-${rr}0001`}, CURRENT_DATE) RETURNING id`;
    uklid.faktury.push(id);
    const { adresa } = await zaloz({ series_id: String(a.id) });
    assert.match(adresa, /formError=rada-obsazena/);
    assert.equal((await cti(a.id)).current_number, 0);
    const html = await (await req.get(adresa)).text();
    assert.ok(html.includes('Příští číslo z řady už má jiná faktura'));
  });

  test('objednávková, zálohová ani neaktivní řada fakturu nečísluje', async () => {
    for (const r2 of [await rada(`${predcisli}g-YYNNNN`, null, { entity_type: 'objednavka' }), await rada(`${predcisli}h-YYNNNN`, null, { active: false })]) {
      assert.match((await zaloz({ series_id: String(r2.id) })).adresa, /formError=rada/);
      assert.equal((await cti(r2.id)).current_number, 0);
    }
  });

  test('nový rok: pořadí začne od začátku, řada bez roku v čísle pokračuje', async () => {
    const a = await rada(`${predcisli}i-YYNNNN`);
    await sql`UPDATE invoice_number_series SET current_number = 57, rok_citace = ${rok - 1} WHERE id = ${a.id}`;
    const { id } = await zaloz({ series_id: String(a.id) });
    assert.equal((await sql`SELECT number FROM accounting_invoices WHERE id = ${id}`)[0].number, `${predcisli}i-${rr}0001`);
    const po = await cti(a.id);
    assert.equal(po.current_number, 1);
    assert.equal(po.rok_citace, rok);

    const b = await rada(`${predcisli}j-NNNN`);
    await sql`UPDATE invoice_number_series SET current_number = 57, rok_citace = ${rok - 1} WHERE id = ${b.id}`;
    const z = await zaloz({ series_id: String(b.id) });
    assert.equal((await sql`SELECT number FROM accounting_invoices WHERE id = ${z.id}`)[0].number, `${predcisli}j-0058`);
  });

  test('duplikace: formulář předvyplní, nic nezaloží, řadu převezme a vznikne nový doklad', async () => {
    const a = await rada(`${predcisli}k-YYNNNN`);
    const { id } = await zaloz({ series_id: String(a.id), client_ico: '123', client_email: 'k@example.invalid', notes: 'Pozn', due_date: '2099-01-15', issue_date: '2099-01-01', account_debit: '311' });
    await sql`UPDATE accounting_invoices SET status = 'Zaplacena', paid_date = '2099-01-02', pohoda_v_evidenci = TRUE WHERE id = ${id}`;
    const pred = (await cti(a.id)).current_number;
    // Jen vlastní klient: ostatní testové soubory jedou souběžně nad toutéž databází.
    const pocetFaktur = async () => (await sql`SELECT COUNT(*)::int AS n FROM accounting_invoices WHERE client_name = ${`Klient ${r}`}`)[0].n;
    const pocet = await pocetFaktur();

    const detail = await (await req.get(`/ucetnictvi/vydane-faktury/${id}`)).text();
    assert.ok(detail.includes(`/ucetnictvi/vydane-faktury?duplikovat=${id}`));

    const html = await (await req.get(`/ucetnictvi/vydane-faktury?duplikovat=${id}`)).text();
    assert.ok(html.includes(`Duplikovat fakturu ${predcisli}k-${rr}0001`));
    assert.ok(html.includes(`value="Klient ${r}"`));
    assert.ok(html.includes('value="311"'));
    assert.ok(html.includes(`name="duplikat_z" value="${id}"`));
    assert.match(html, new RegExp(`<option value="${a.id}" selected>`));
    assert.ok(html.includes('"name":"Služba"'));
    assert.ok(html.includes(`classList.add('open')`));
    assert.equal((await cti(a.id)).current_number, pred, 'otevření formuláře číslo nespotřebuje');
    assert.equal(await pocetFaktur(), pocet);

    const nova = await zaloz({ duplikat_z: id, series_id: String(a.id), client_ico: '123' });
    const [f] = await sql`SELECT * FROM accounting_invoices WHERE id = ${nova.id}`;
    assert.equal(f.number, `${predcisli}k-${rr}0002`);
    assert.equal(f.status, 'Nezaplacena');
    assert.equal(f.paid_date, null);
    assert.equal(f.pohoda_v_evidenci, false);
    assert.equal(f.source, 'rucne');
    const [zdroj] = await sql`SELECT status, number FROM accounting_invoices WHERE id = ${id}`;
    assert.equal(zdroj.status, 'Zaplacena');
    assert.equal(zdroj.number, `${predcisli}k-${rr}0001`);
  });

  test('duplikace: chyba vrátí předvyplněný formulář; zálohovka a neznámé id se nepředvyplní', async () => {
    const { id } = await zaloz({ number: `DUP-${r}` });
    const res = await req.post('/ucetnictvi/vydane-faktury/vytvorit', { duplikat_z: id, client_name: ' ', ...polozka });
    assert.equal(res.headers.get('location'), `/ucetnictvi/vydane-faktury?duplikovat=${id}&formError=klient`);

    const [z] = await sql`INSERT INTO accounting_invoices (id, type, number, issue_date, total_amount) VALUES (${`TEST-${r}-Z`}, 'proforma', ${`ZF-${r}`}, CURRENT_DATE, 100) RETURNING id`;
    uklid.faktury.push(z.id);
    const zalohova = await (await req.get(`/ucetnictvi/vydane-faktury?duplikovat=${z.id}`)).text();
    assert.ok(!zalohova.includes('Duplikovat fakturu'));
    assert.ok(!(await (await req.get(`/ucetnictvi/vydane-faktury/${z.id}`)).text()).includes('duplikovat='));
    assert.ok(!(await (await req.get('/ucetnictvi/vydane-faktury?duplikovat=neexistuje')).text()).includes('Duplikovat fakturu'));
  });
});
