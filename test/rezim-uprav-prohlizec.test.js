// Režim úprav v opravdovém prohlížeči (Puppeteer): chování public/js/upravy.js,
// které render testy nevidí — hlídání rozepsaných změn, Esc vedle modalu
// a hledání, návrat po chybě, pole přes form= a zámek odpočtu DPH po Zrušit.
// Běží proti serveru a lokální databázi, fixtury si založí a uklidí.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/rezim-uprav-prohlizec.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import puppeteer from 'puppeteer';
import { BASE, PRESKOCIT, lokalniDatabaze, serverBezi, prihlas } from './pomocnici/server.js';

describe('režim úprav v prohlížeči', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(3).toString('hex');
  let sql, browser, page, session, userId, shopId, fakturaId, uctenkaId, eshop, cookie;
  let dialogy = [];
  let odpoved = 'accept';
  const jsChyby = [];

  const pauza = (ms = 150) => new Promise(res => setTimeout(res, ms));
  const jdi = async (cesta) => { dialogy = []; odpoved = 'accept'; await page.goto(BASE + cesta, { waitUntil: 'networkidle0' }); };
  const rezim = () => page.$eval('[data-rezim]', el => el.dataset.rezim);
  const url = () => page.evaluate(() => location.pathname + location.search);
  const text = () => page.evaluate(() => document.querySelector('main').innerText);
  const otevrit = async () => { await page.click('.page-header-akce .upravit-otevrit'); await pauza(); };
  const klikANavigace = (sel) => Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click(sel)]);

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const [u] = await sql`INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`rezim-${r}@example.invalid`}, 'x', 'Režim', 'Úprav', TRUE) RETURNING id`;
    userId = u.id;
    session = await prihlas(sql, userId);
    const [shop] = await sql`INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address)
      VALUES (${`rezim-${r}`}, ${`Režim ${r}`}, 'https://example.invalid', TRUE, 'Režim', 'noreply@example.invalid') RETURNING id`;
    shopId = shop.id;
    eshop = `/nastaveni/eshopy/${shopId}`;
    fakturaId = `rezimfak${r}`;
    await sql`INSERT INTO accounting_invoices (id, type, number, supplier, amount, vat_amount, total_amount, currency, issue_date, status)
      VALUES (${fakturaId}, 'received', ${`PF-${r}`}, ${`Dodavatel ${r}`}, 100, 21, 121, 'CZK', '2026-02-02', 'Nezaplacena')`;
    const [uctenka] = await sql`INSERT INTO receipts (vendor, amount, vat_amount, total_amount, currency, receipt_date, category, status, vat_deductible)
      VALUES (${`Papírnictví ${r}`}, 100, 21, 121, 'CZK', '2026-02-02', 'Ostatní', 'Nezaúčtována', TRUE) RETURNING id`;
    uctenkaId = uctenka.id;

    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    cookie = { name: 'sessionId', value: session.cookie.slice('sessionId='.length), domain: new URL(BASE).hostname, path: '/' };
    await page.setCookie(cookie);
    page.on('pageerror', e => jsChyby.push(e.message));
    page.on('dialog', async d => { dialogy.push(d.type()); await (odpoved === 'accept' ? d.accept() : d.dismiss()); });
  });

  after(async () => {
    await browser?.close();
    if (!sql) return;
    await sql`DELETE FROM session WHERE sid = ${session?.sid ?? ''}`;
    await sql`DELETE FROM accounting_invoices WHERE id = ${fakturaId ?? ''}`;
    if (uctenkaId) await sql`DELETE FROM receipts WHERE id = ${uctenkaId}`;
    if (shopId) await sql`DELETE FROM shops WHERE id = ${shopId}`;
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.end();
  });

  test('Zrušit bez změn se neptá a vrátí fokus na tužku', async () => {
    await jdi(`${eshop}?tab=zakladni`);
    await otevrit();
    assert.equal(await rezim(), 'upravy');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'name', 'fokus na prvním poli');
    assert.equal(await url(), `${eshop}?tab=zakladni&upravit=1`, 'F5 vrátí úpravy');
    await page.click('.page-header-akce .upravit-zrusit');
    await pauza();
    assert.deepEqual(dialogy, []);
    assert.equal(await rezim(), 'zobrazeni');
    assert.equal(await url(), `${eshop}?tab=zakladni`);
    assert.ok(await page.evaluate(() => document.activeElement.classList.contains('upravit-otevrit')));
  });

  test('po chybě formuláře jsou úpravy otevřené a Zrušit načte stránku bez hlášky', async () => {
    await jdi(`${eshop}?tab=zakladni&error=zakladni-nazev&upravit=1`);
    assert.equal(await rezim(), 'upravy');
    assert.ok((await text()).includes('nesmí být prázdný'));
    await klikANavigace('.page-header-akce .upravit-zrusit');
    assert.equal(await url(), `${eshop}?tab=zakladni`);
    assert.equal(await rezim(), 'zobrazeni');
    assert.ok(!(await text()).includes('nesmí být prázdný'), 'chyba po zrušení nezůstane viset');
  });

  test('hláška Uloženo v úpravách zmizí a po Zrušit se nevrátí', async () => {
    await jdi(`${eshop}?tab=zakladni&saved=1`);
    assert.ok((await text()).includes('Uloženo'));
    await otevrit();
    assert.ok(!(await text()).includes('Uloženo'));
    assert.ok(!(await url()).includes('saved'), 'F5 nesmí nad rozepsaným formulářem hlásit Uloženo');
    await klikANavigace('.page-header-akce .upravit-zrusit');
    assert.ok(!(await text()).includes('Uloženo'));
  });

  test('Esc: v hledání a přes modal úpravy nezavře, v poli bez změn ano', async () => {
    await jdi(`${eshop}?tab=zakladni`);
    await otevrit();
    await page.focus('#hledaniPole');
    await page.keyboard.press('Escape');
    await pauza();
    assert.equal(await rezim(), 'upravy', 'Esc v hledání patří hledání');

    await page.focus('#pole-name');
    await page.keyboard.press('Escape');
    await pauza();
    assert.equal(await rezim(), 'zobrazeni');
    assert.deepEqual(dialogy, [], 'bez změn se neptá');

    await jdi(`/ucetnictvi/prijate-faktury/${fakturaId}`);
    await otevrit();
    await page.click('.page-header-akce [data-modal-open="modalStatus"]');
    await pauza(400);
    await page.keyboard.press('Escape');
    await pauza(400);
    assert.equal(await page.$('#modalStatus.open'), null, 'Esc zavře modal');
    assert.equal(await rezim(), 'upravy', 'ale ne úpravy pod ním');
  });

  test('rozepsaná změna: Esc se zeptá, záložka vyvolá beforeunload, Uložit ne', async () => {
    await jdi(`${eshop}?tab=zakladni`);
    await otevrit();
    await page.type('#pole-name', 'X');

    odpoved = 'dismiss';
    await page.keyboard.press('Escape');
    await pauza();
    assert.deepEqual(dialogy, ['confirm']);
    assert.equal(await rezim(), 'upravy', 'odmítnutí nechá úpravy');

    dialogy = [];
    await page.evaluate(() => document.querySelector('.tabs a[href="?tab=identita"]').click());
    await pauza(400);
    assert.deepEqual(dialogy, ['beforeunload']);
    assert.ok((await page.$eval('#pole-name', el => el.value)).includes('X'), 'text zůstal');

    dialogy = []; odpoved = 'accept';
    await klikANavigace('.page-header-akce .upravit-ulozit');
    assert.deepEqual(dialogy, [], 'uložení se neptá');
    assert.equal(await rezim(), 'zobrazeni');
    assert.equal(await url(), `${eshop}?tab=zakladni&saved=1`);
    const [shop] = await sql`SELECT name FROM shops WHERE id = ${shopId}`;
    assert.ok(shop.name.includes('X'), shop.name);
  });

  test('prázdné povinné pole formulář neodešle', async () => {
    await jdi(`${eshop}?tab=zakladni&upravit=1`);
    await page.$eval('#pole-name', el => { el.value = ''; });
    await page.click('.page-header-akce .upravit-ulozit');
    await pauza(300);
    assert.equal(await rezim(), 'upravy');
    assert.ok((await url()).includes('upravit=1'));
  });

  test('přijatá faktura: pole přes form= se odešlou z patičky a modal po zavření křížkem vrátí scroll', async () => {
    await jdi(`/ucetnictvi/prijate-faktury/${fakturaId}`);
    await page.click('.page-header-akce [data-modal-open="modalStatus"]');
    await pauza(400);
    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
    await page.click('#modalStatus .modal-close');
    await pauza(400);
    assert.equal(await page.evaluate(() => document.body.style.overflow), '', 'stránka jde zase scrollovat');

    await otevrit();
    await page.type('textarea[name="notes"]', `pozn ${r}`);
    await klikANavigace('.upravit-paticka .upravit-ulozit');
    const [f] = await sql`SELECT notes, amount, supplier, status FROM accounting_invoices WHERE id = ${fakturaId}`;
    assert.equal(f.notes, `pozn ${r}`);
    assert.equal(Number(f.amount), 100, 'částka z Rekapitulace se odeslala taky');
    assert.equal(f.supplier, `Dodavatel ${r}`);
    assert.equal(f.status, 'Nezaplacena');
    assert.equal(await url(), `/ucetnictvi/prijate-faktury/${fakturaId}?saved=1`);
    assert.equal(await rezim(), 'zobrazeni');
  });

  test('účtenka: Zrušit po Reprezentaci odemkne odpočet a další uložení ho nevypne', async () => {
    await jdi(`/ucetnictvi/uctenky/${uctenkaId}`);
    await otevrit();
    await page.select('#rdCategory', 'Reprezentace');
    await pauza();
    assert.ok(await page.$eval('#rdVatDeductible', el => el.disabled && !el.checked), 'Reprezentace odpočet zamkne');
    await page.click('.page-header-akce .upravit-zrusit');
    await pauza(200);
    assert.ok(await page.$eval('#rdVatDeductible', el => !el.disabled && el.checked), 'Zrušit ho odemkne');
    assert.equal(await page.$eval('#rdCategory', el => el.value), 'Ostatní');

    await otevrit();
    await klikANavigace('.page-header-akce .upravit-ulozit');
    const [u] = await sql`SELECT vat_deductible, category FROM receipts WHERE id = ${uctenkaId}`;
    assert.equal(u.vat_deductible, true, 'tiché vypnutí odpočtu by šlo do POHODY');
    assert.equal(u.category, 'Ostatní');
  });

  test('bez JavaScriptu: tužka je odkaz a Uložit uloží', async () => {
    const kontext = await browser.createBrowserContext();
    const bez = await kontext.newPage();
    await bez.setJavaScriptEnabled(false);
    await bez.setCookie(cookie);
    await bez.goto(`${BASE}${eshop}?tab=expedice`, { waitUntil: 'load' });
    await Promise.all([bez.waitForNavigation({ waitUntil: 'load' }), bez.click('.page-header-akce .upravit-otevrit')]);
    assert.ok(bez.url().endsWith('?tab=expedice&upravit=1'), bez.url());
    assert.equal(await bez.$eval('[data-rezim]', el => el.dataset.rezim), 'upravy');
    await bez.type('input[name="warehouse_email"]', `sklad-${r}@example.invalid`);
    await Promise.all([bez.waitForNavigation({ waitUntil: 'load' }), bez.click('.page-header-akce .upravit-ulozit')]);
    const [shop] = await sql`SELECT warehouse_email FROM shops WHERE id = ${shopId}`;
    assert.equal(shop.warehouse_email, `sklad-${r}@example.invalid`);
    assert.equal(await bez.$eval('[data-rezim]', el => el.dataset.rezim), 'zobrazeni');
    await kontext.close();
  });

  test('žádná chyba JavaScriptu během scénářů', () => {
    assert.deepEqual(jsChyby, []);
  });
});
