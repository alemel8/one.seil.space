// Režim úprav v opravdovém prohlížeči (Puppeteer): chování public/js/upravy.js,
// které render testy nevidí – hlídání rozepsaných změn, Esc vedle modalu
// a hledání, návrat po chybě, pole přes form=, zámek odpočtu DPH po Zrušit,
// pojistka proti dvojkliku, návrat tlačítkem Zpět, rozepsané hodnoty po chybě
// a kontrola při Uložit, která nepřepíše cizí změnu.
// Běží proti serveru a lokální databázi, fixtury si založí a uklidí.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/rezim-uprav-prohlizec.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import puppeteer from 'puppeteer';
import { BASE, PRESKOCIT, lokalniDatabaze, serverBezi, prihlas } from './pomocnici/server.js';

describe('režim úprav v prohlížeči', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(3).toString('hex');
  let sql, browser, page, session, userId, shopId, fakturaId, faktura2Id, firmaId, uctenkaId, eshop, cookie, clen;
  let dialogy = [];
  let odpoved = 'accept';
  const jsChyby = [];

  const pauza = (ms = 150) => new Promise(res => setTimeout(res, ms));
  // Dialogy se nulují až po načtení: odchod z rozepsané stránky předchozího testu se taky zeptá.
  const jdi = async (cesta) => { odpoved = 'accept'; await page.goto(BASE + cesta, { waitUntil: 'networkidle0' }); dialogy = []; };
  const rezim = () => page.$eval('[data-rezim]', el => el.dataset.rezim);
  const url = () => page.evaluate(() => location.pathname + location.search);
  const text = () => page.evaluate(() => document.querySelector('main').innerText);
  // Po otevření čeká déle než pojistka (upravy.js), která první půlsekundu nepustí Uložit.
  const otevrit = async () => { await page.click('.page-header-akce .upravit-otevrit'); await pauza(600); };
  const stred = async (sel) => {
    const box = await (await page.$(sel)).boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  const pocetPost = () => pozadavkyPost.length;
  const pozadavkyPost = [];
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
    faktura2Id = `rezimfag${r}`;
    await sql`INSERT INTO accounting_invoices (id, type, number, supplier, amount, vat_amount, total_amount, currency, issue_date, status)
      VALUES (${faktura2Id}, 'received', ${`PG-${r}`}, ${`Dodavatel ${r}`}, 1, 0, 1, 'CZK', '2026-02-02', 'Nezaplacena')`;
    [clen] = await sql`INSERT INTO users (email, password_hash, first_name, last_name, phone, position, is_admin, is_active)
      VALUES (${`rezim-clen-${r}@example.invalid`}, 'x', 'Člen', 'Týmu', '+420 777 000 111', 'Pozice', TRUE, TRUE) RETURNING id, public_id`;
    firmaId = `rezimfir${r}`;
    await sql`INSERT INTO crm_companies (id, name, company_type, ico, website) VALUES (${firmaId}, ${`Firma ${r}`}, 'Zákazník', '12345678', 'https://firma.example.invalid')`;

    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    cookie = { name: 'sessionId', value: session.cookie.slice('sessionId='.length), domain: new URL(BASE).hostname, path: '/' };
    await page.setCookie(cookie);
    page.on('pageerror', e => jsChyby.push(e.message));
    page.on('request', q => { if (q.method() === 'POST') pozadavkyPost.push(q.url()); });
    page.on('dialog', async d => { dialogy.push(d.type()); await (odpoved === 'accept' ? d.accept() : d.dismiss()); });
  });

  after(async () => {
    await browser?.close();
    if (!sql) return;
    await sql`DELETE FROM session WHERE sid = ${session?.sid ?? ''}`;
    await sql`DELETE FROM accounting_invoices WHERE id = ANY(${[fakturaId ?? '', faktura2Id ?? '']})`;
    await sql`DELETE FROM crm_companies WHERE id = ${firmaId ?? ''}`;
    if (uctenkaId) await sql`DELETE FROM receipts WHERE id = ${uctenkaId}`;
    if (shopId) await sql`DELETE FROM shops WHERE id = ${shopId}`;
    if (clen) await sql`DELETE FROM users WHERE id = ${clen.id}`;
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

  test('po chybě formuláře jsou úpravy otevřené a Zrušit nechá stránku bez hlášky', async () => {
    await jdi(`${eshop}?tab=zakladni&error=zakladni-nazev&upravit=1`);
    assert.equal(await rezim(), 'upravy');
    assert.ok((await text()).includes('nesmí být prázdný'));
    await page.click('.page-header-akce .upravit-zrusit');
    await pauza();
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
    await page.click('.page-header-akce .upravit-zrusit');
    await pauza();
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
    await page.evaluate(() => document.querySelector('.tabs a[href$="?tab=identita"]').click());
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

  test('účtenka: Reprezentace a zpět vrátí volbu odpočtu, Zrušit vrátí uloženou', async () => {
    await jdi(`/ucetnictvi/uctenky/${uctenkaId}`);
    await otevrit();
    await page.select('#rdCategory', 'Reprezentace');
    await page.select('#rdCategory', 'Kancelář');
    assert.ok(await page.$eval('#rdVatDeductible', el => !el.disabled && el.checked), 'odpočet se vrátil, jinak by potichu zmizel z POHODY');

    await page.click('#rdVatDeductible'); // vypnout ručně
    await page.select('#rdCategory', 'Reprezentace');
    await page.select('#rdCategory', 'Kancelář');
    assert.ok(await page.$eval('#rdVatDeductible', el => !el.disabled && !el.checked), 'ruční volba zůstala');

    await page.select('#rdCategory', 'Reprezentace');
    await page.keyboard.press('Escape'); // na selectu Esc nepatří úpravám
    await page.focus('#pole-vendor');
    await page.keyboard.press('Escape');
    await pauza();
    assert.deepEqual(dialogy, ['confirm']);
    assert.ok(await page.$eval('#rdVatDeductible', el => !el.disabled && el.checked), 'po Zrušit platí uložená hodnota');
  });

  test('dvojklik na Zrušit nespustí tlačítko, které se pod kurzorem objeví', async () => {
    await jdi(`/crm/firmy/${firmaId}?tab=zakladni`);
    await otevrit();
    assert.equal(await page.$eval('.page-header-akce button[onclick="syncAres()"]', el => el.offsetParent), null, 'v úpravách je Sync ARES skrytý');
    odpoved = 'dismiss';
    const [x, y] = await stred('.page-header-akce .upravit-zrusit');
    await page.mouse.click(x, y, { count: 2 });
    await pauza(400);
    assert.equal(await rezim(), 'zobrazeni');
    assert.deepEqual(dialogy, [], 'Sync ARES se ani nezeptal');
    const [f] = await sql`SELECT ares_synced_at FROM crm_companies WHERE id = ${firmaId}`;
    assert.equal(f.ares_synced_at, null);
  });

  test('Sync ARES se při kliknutí zeptá a odmítnutí nic nespustí', async () => {
    await jdi(`/crm/firmy/${firmaId}?tab=zakladni`);
    odpoved = 'dismiss';
    const ares = [];
    const hlidac = q => { if (q.url().includes('/ares')) ares.push(q.url()); };
    page.on('request', hlidac);
    await page.click('.page-header-akce button[onclick="syncAres()"]');
    await pauza(300);
    page.off('request', hlidac);
    assert.deepEqual(dialogy, ['confirm']);
    assert.deepEqual(ares, [], 'bez souhlasu nejde ani dotaz na ARES');
  });

  test('dvojklik na tužku otevře úpravy a nic neuloží, fokus zůstane v prvním poli', async () => {
    await jdi(`/crm/firmy/${firmaId}?tab=zakladni`);
    pozadavkyPost.length = 0;
    const [x, y] = await stred('.page-header-akce .upravit-otevrit');
    await page.mouse.click(x, y, { count: 2 });
    await pauza(400);
    assert.equal(await rezim(), 'upravy');
    assert.equal(pocetPost(), 0, 'Uložit leží na místě tužky');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'name');
  });

  test('dvě samostatná klepnutí na tužku (telefon) nic neuloží', async () => {
    await jdi(`/crm/firmy/${firmaId}?tab=zakladni`);
    pozadavkyPost.length = 0;
    const [x, y] = await stred('.page-header-akce .upravit-otevrit');
    await page.mouse.click(x, y);
    await pauza(120);
    await page.mouse.click(x, y);
    await pauza(400);
    assert.equal(await rezim(), 'upravy');
    assert.equal(pocetPost(), 0);
  });

  test('podržený Enter po otevření tužkou klávesnicí nic neuloží', async () => {
    await jdi(`/crm/firmy/${firmaId}?tab=zakladni`);
    pozadavkyPost.length = 0;
    await page.focus('.page-header-akce .upravit-otevrit');
    await page.keyboard.down('Enter');
    await pauza(600);
    assert.equal(await rezim(), 'upravy');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'name');
    await page.keyboard.down('Enter'); // opakování z držené klávesy
    await pauza(300);
    await page.keyboard.up('Enter');
    assert.equal(pocetPost(), 0, 'opakování nesmí odeslat formulář');
    assert.equal(await rezim(), 'upravy');
    await page.keyboard.press('Enter'); // nový stisk je vědomé odeslání
    await pauza(600);
    assert.equal(pocetPost(), 1);
  });

  test('Ctrl+klik na tužku přepnutí nechá na novém panelu', async () => {
    await jdi(`${eshop}?tab=zakladni`);
    const vychozi = await page.evaluate(() => {
      window.addEventListener('click', e => e.preventDefault(), { once: true }); // panel se v testu neotevře
      const odkaz = document.querySelector('.page-header-akce .upravit-otevrit');
      odkaz.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      return document.querySelector('[data-rezim]').dataset.rezim;
    });
    assert.equal(vychozi, 'zobrazeni');
  });

  test('Zpět po uložení ukáže uložený stav, další Uložit změnu nevrátí', async () => {
    const [{ name: puvodni }] = await sql`SELECT name FROM shops WHERE id = ${shopId}`;
    await jdi(`${eshop}?tab=zakladni`);
    await otevrit();
    await page.$eval('#pole-name', (el, v) => { el.value = v; }, `${puvodni} A`);
    await klikANavigace('.page-header-akce .upravit-ulozit');
    await page.goBack({ waitUntil: 'networkidle0' });
    await pauza(600);
    assert.deepEqual(dialogy, [], 'bez dotazu na neuložené změny');
    const stav = await page.evaluate(() => ({
      h1: document.querySelector('h1').textContent, vychozi: document.getElementById('pole-name').defaultValue,
    }));
    assert.equal(stav.h1, `${puvodni} A`, 'hlavička ukazuje uloženou hodnotu');
    assert.equal(stav.vychozi, `${puvodni} A`, 'formulář nedrží starou hodnotu');

    // Další uložení jiného pole první změnu nevrátí, ať je formulář otevřený, nebo ne.
    if (await rezim() === 'zobrazeni') await otevrit();
    await page.$eval('#pole-url', el => { el.value = 'https://druha.example.invalid'; });
    await klikANavigace('.page-header-akce .upravit-ulozit');
    const [shop] = await sql`SELECT name, url FROM shops WHERE id = ${shopId}`;
    assert.deepEqual([shop.name, shop.url], [`${puvodni} A`, 'https://druha.example.invalid']);
  });

  test('chyba ze serveru: rozepsané hodnoty zůstanou, Esc se zeptá a vrátí uložený stav', async () => {
    const [pred] = await sql`SELECT name, url FROM shops WHERE id = ${shopId}`;
    await jdi(`${eshop}?tab=zakladni`);
    await otevrit();
    await page.$eval('#pole-name', el => { el.value = 'Rozepsaný název'; });
    await page.$eval('#pole-url', el => { el.value = 'ftp://example.invalid'; });
    await klikANavigace('.page-header-akce .upravit-ulozit');
    assert.equal(await url(), `${eshop}?tab=zakladni&error=zakladni-url&upravit=1`);
    assert.equal(await rezim(), 'upravy');
    assert.equal(await page.$eval('#pole-name', el => el.value), 'Rozepsaný název', 'ostatní pole se neztratila');
    assert.equal(await page.$eval('#pole-url', el => el.value), 'ftp://example.invalid');
    assert.deepEqual(dialogy, []);

    odpoved = 'dismiss';
    await page.focus('#pole-name');
    await page.keyboard.press('Escape');
    await pauza();
    assert.deepEqual(dialogy, ['confirm'], 'hodnoty se liší od uložených, Esc se ptá');
    odpoved = 'accept';
    await page.keyboard.press('Escape');
    await pauza();
    assert.equal(await rezim(), 'zobrazeni');
    assert.equal(await page.$('[data-hlaska]'), null, 'hláška po zrušení nezůstane');
    assert.equal(await url(), `${eshop}?tab=zakladni`);
    assert.equal(await page.$eval('#pole-name', (el) => el.value), pred.name, 'Zrušit vrátí uložený stav');
    const [po] = await sql`SELECT name, url FROM shops WHERE id = ${shopId}`;
    assert.deepEqual(po, pred);
    await page.reload({ waitUntil: 'networkidle0' });
    assert.equal(await page.$eval('#pole-name', el => el.value), pred.name, 'záznam rozepsaných hodnot se nepoužije znovu');
  });

  test('duplicitní číslo faktury: hláška a všechna pole přes form= zůstanou rozepsaná', async () => {
    await jdi(`/ucetnictvi/prijate-faktury/${fakturaId}`);
    await otevrit();
    await page.$eval('input[name="number"]', (el, v) => { el.value = v; }, `PG-${r}`);
    await page.$eval('textarea[name="notes"]', el => { el.value = 'rozepsaná poznámka\ndruhý řádek'; });
    await page.$eval('input[name="amount"]', el => { el.value = '555.5'; });
    await klikANavigace('.page-header-akce .upravit-ulozit');
    assert.equal(await url(), `/ucetnictvi/prijate-faktury/${fakturaId}?error=duplicita&upravit=1`);
    assert.ok((await text()).includes('s tímto číslem už v systému je'));
    assert.equal(await page.$eval('input[name="number"]', el => el.value), `PG-${r}`);
    assert.equal(await page.$eval('textarea[name="notes"]', el => el.value), 'rozepsaná poznámka\ndruhý řádek');
    assert.equal(await page.$eval('input[name="amount"]', el => el.value), '555.5');
    await page.$eval('input[name="number"]', (el, v) => { el.value = v; }, `PF-${r}`);
    await klikANavigace('.page-header-akce .upravit-ulozit');
    assert.equal(await url(), `/ucetnictvi/prijate-faktury/${fakturaId}?saved=1`);
    const [f] = await sql`SELECT notes, amount FROM accounting_invoices WHERE id = ${fakturaId}`;
    assert.ok(f.notes.startsWith('rozepsaná poznámka'), f.notes);
    assert.equal(Number(f.amount), 555.5);
  });

  test('stejné číslo od jiného dodavatele se uloží bez hlášky', async () => {
    const treti = `tg3${r}`;
    await sql`INSERT INTO accounting_invoices (id, type, number, supplier, supplier_ico, amount, vat_amount, total_amount, currency, issue_date, status)
      VALUES (${treti}, 'received', ${`PG3-${r}`}, 'Cizi dodavatel', '99999999', 1, 0, 1, 'CZK', '2026-02-02', 'Nezaplacena')`;
    try {
      await jdi(`/ucetnictvi/prijate-faktury/${fakturaId}`);
      await otevrit();
      await page.$eval('input[name="number"]', (el, v) => { el.value = v; }, `PG3-${r}`);
      await klikANavigace('.page-header-akce .upravit-ulozit');
      assert.equal(await url(), `/ucetnictvi/prijate-faktury/${fakturaId}?saved=1`);
      const [f] = await sql`SELECT number FROM accounting_invoices WHERE id = ${fakturaId}`;
      assert.equal(f.number, `PG3-${r}`);
    } finally {
      await sql`UPDATE accounting_invoices SET number = ${`PF-${r}`} WHERE id = ${fakturaId}`;
      await sql`DELETE FROM accounting_invoices WHERE id = ${treti}`;
    }
  });

  test('povinné pole ze samých mezer a smazané datum účtenky prohlížeč neodešle', async () => {
    await jdi(`/ucetnictvi/uctenky/${uctenkaId}`);
    await otevrit();
    pozadavkyPost.length = 0;
    await page.$eval('#pole-vendor', el => { el.value = '   '; });
    await page.click('.page-header-akce .upravit-ulozit');
    await pauza(300);
    assert.equal(pocetPost(), 0, 'dodavatel ze samých mezer');
    await page.$eval('#pole-vendor', el => { el.value = el.defaultValue; });
    await page.$eval('#pole-receipt_date', el => { el.value = ''; });
    await page.click('.page-header-akce .upravit-ulozit');
    await pauza(300);
    assert.equal(pocetPost(), 0, 'prázdné datum dokladu');
    assert.equal(await rezim(), 'upravy');
  });

  test('nahrání dokladu během úprav: bez dialogu, rozepsané údaje a odpočet přežijí načtení', async () => {
    const soubor = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rezim-')), 'doklad.png');
    await fs.writeFile(soubor, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    await jdi(`/ucetnictvi/uctenky/${uctenkaId}`);
    await otevrit();
    await page.$eval('#pole-vendor', el => { el.value = 'Rozepsaný dodavatel'; });
    await page.select('#rdCategory', 'Reprezentace');

    // POST přílohy je podvržený, ať test nezakládá soubory.
    const podvrh = q => (q.method() === 'POST' && q.url().endsWith('/priloha')
      ? q.respond({ status: 200, contentType: 'application/json', body: '{}' }) : q.continue());
    await page.setRequestInterception(true);
    page.on('request', podvrh);
    try {
      const vstup = await page.$('input[type="file"][name="file"]:not([capture])');
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), vstup.uploadFile(soubor)]);
    } finally {
      page.off('request', podvrh);
      await page.setRequestInterception(false);
      await fs.rm(path.dirname(soubor), { recursive: true });
    }
    assert.deepEqual(dialogy, [], 'nahrání se na nic neptá');
    assert.equal(await url(), `/ucetnictvi/uctenky/${uctenkaId}?upravit=1`);
    assert.equal(await rezim(), 'upravy');
    assert.equal(await page.$eval('#pole-vendor', el => el.value), 'Rozepsaný dodavatel');
    assert.equal(await page.$eval('#rdCategory', el => el.value), 'Reprezentace');
    assert.ok(await page.$eval('#rdVatDeductible', el => el.disabled && !el.checked), 'zámek odpočtu se přepočítal');

    odpoved = 'dismiss';
    await page.focus('#pole-vendor');
    await page.keyboard.press('Escape');
    await pauza();
    assert.deepEqual(dialogy, ['confirm'], 'rozepsané se dál hlídá');
    odpoved = 'accept';
    await page.keyboard.press('Escape');
    await pauza();
    assert.ok((await page.$eval('#pole-vendor', el => el.value)).startsWith('Papírnictví'), 'Zrušit vrátí uložené údaje');
  });

  describe('kontrola při Uložit', () => {
    const ULOZIT = '.page-header-akce .upravit-ulozit';
    const hodnota = (sel) => page.$eval(sel, el => (el.type === 'checkbox' ? el.checked : el.value));
    const nastav = (sel, v) => page.$eval(sel, (el, v) => {
      if (el.type === 'checkbox') el.checked = v; else el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
    const hlaska = () => page.$eval('[data-hlaska]', el => el.textContent).catch(() => '');
    const cekejHlasku = () => page.waitForSelector('[data-hlaska]', { timeout: 8000 });
    const obnovUctenku = () => sql`UPDATE receipts SET status = 'Nezaúčtována', notes = '', vendor = ${`Papírnictví ${r}`} WHERE id = ${uctenkaId}`;
    const uctenka = async () => (await sql`SELECT status, notes FROM receipts WHERE id = ${uctenkaId}`)[0];
    const otevriUctenku = async () => {
      await obnovUctenku();
      await jdi(`/ucetnictvi/uctenky/${uctenkaId}`);
      await otevrit();
      await nastav('textarea[name="notes"]', 'moje poznámka');
    };
    // Odpověď kontroly bez sítě; platí do dalšího načtení stránky.
    const fetchVrati = (odpoved) => page.evaluate((o) => {
      window.fetch = async () => {
        if (o === 'sit') throw new TypeError('offline');
        return new Response('x', { status: o });
      };
    }, odpoved);

    test('cizí Storno: první Uložit nic neodešle, druhé ho nepřepíše a uloží moji poznámku', async () => {
      await otevriUctenku();
      await sql`UPDATE receipts SET status = 'Storno' WHERE id = ${uctenkaId}`;
      const pred = pocetPost();
      await klikANavigace(ULOZIT);
      assert.equal(pocetPost(), pred, 'bez odeslání');
      assert.deepEqual(await uctenka(), { status: 'Storno', notes: '' });
      assert.equal(await rezim(), 'upravy');
      assert.equal(await hodnota('select[name="status"]'), 'Storno', 'pole ukazuje aktuální hodnotu');
      assert.equal(await hodnota('textarea[name="notes"]'), 'moje poznámka', 'rozepsané zůstalo');
      assert.match(await hlaska(), /mezitím změnil.*Stav/);
      assert.ok(await page.evaluate(() => document.activeElement.hasAttribute('data-hlaska')), 'hláška je vidět i po Uložit z patičky');
      assert.deepEqual(dialogy, []);

      await pauza(600);
      await klikANavigace(ULOZIT);
      assert.deepEqual(await uctenka(), { status: 'Storno', notes: 'moje poznámka' });
      assert.ok((await url()).includes('saved=1'));
      assert.equal(pocetPost(), pred + 1);
    });

    test('cizí deaktivace člena: druhé Uložit účet nezapne a nezměněné přepínače nechá', async () => {
      await jdi(`/lide/tym/${clen.public_id}?tab=detail`);
      await otevrit();
      await nastav('input[name="phone"]', '+420 999');
      await sql`UPDATE users SET is_active = FALSE, position = 'Cizí pozice' WHERE id = ${clen.id}`;
      await klikANavigace(ULOZIT);
      assert.equal(await hodnota('input[name="is_active"]'), false);
      assert.equal(await hodnota('input[name="is_admin"]'), true, 'přepínač, na který nikdo nesáhl, se neodškrtne');
      assert.equal(await hodnota('input[name="position"]'), 'Cizí pozice');
      assert.equal(await hodnota('input[name="phone"]'), '+420 999');
      await pauza(600);
      await klikANavigace(ULOZIT);
      const [u] = await sql`SELECT is_active, is_admin, phone, position FROM users WHERE id = ${clen.id}`;
      assert.deepEqual(u, { is_active: false, is_admin: true, phone: '+420 999', position: 'Cizí pozice' });
      await sql`UPDATE users SET is_active = TRUE, phone = '+420 777 000 111', position = 'Pozice' WHERE id = ${clen.id}`;
    });

    test('totéž pole změnili oba: hláška ukáže uloženou hodnotu, druhé Uložit zapíše moji', async () => {
      await otevriUctenku();
      await sql`UPDATE receipts SET notes = 'cizí poznámka' WHERE id = ${uctenkaId}`;
      await klikANavigace(ULOZIT);
      assert.equal(await hodnota('textarea[name="notes"]'), 'moje poznámka');
      assert.match(await hlaska(), /jste měnili i vy: uloženo je „cizí poznámka“/);
      await pauza(600);
      await klikANavigace(ULOZIT);
      assert.equal((await uctenka()).notes, 'moje poznámka');
    });

    test('změna sloupce mimo formulář poplach nevyvolá a uložení ji nepřepíše', async () => {
      await jdi(`/ucetnictvi/prijate-faktury/${fakturaId}`);
      await otevrit();
      await nastav('textarea[name="notes"]', 'po exportu');
      await sql`UPDATE accounting_invoices SET status = 'Zaplacena', pohoda_exported_at = NOW() WHERE id = ${fakturaId}`;
      const pred = pocetPost();
      await klikANavigace(ULOZIT);
      assert.equal(pocetPost(), pred + 1, 'odeslalo se hned');
      assert.ok((await url()).includes('saved=1'));
      const [f] = await sql`SELECT status, notes, pohoda_exported_at FROM accounting_invoices WHERE id = ${fakturaId}`;
      assert.equal(f.status, 'Zaplacena');
      assert.equal(f.notes, 'po exportu');
      assert.ok(f.pohoda_exported_at);
      await sql`UPDATE accounting_invoices SET status = 'Nezaplacena', pohoda_exported_at = NULL WHERE id = ${fakturaId}`;
    });

    test('nahrání dokladu během úprav vrátí jen změněná pole, cizí Storno zůstane', async () => {
      await otevriUctenku();
      await sql`UPDATE receipts SET status = 'Storno' WHERE id = ${uctenkaId}`;
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.evaluate(() => window.upravyNactiZnovu())]);
      assert.equal(await hodnota('select[name="status"]'), 'Storno');
      assert.equal(await hodnota('textarea[name="notes"]'), 'moje poznámka');
      await klikANavigace(ULOZIT);
      assert.deepEqual(await uctenka(), { status: 'Storno', notes: 'moje poznámka' });
    });

    test('dvojklik na Uložit odešle formulář jednou', async () => {
      await otevriUctenku();
      await pauza(600); // za dobou pojistky po otevření
      const pred = pocetPost();
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click(ULOZIT, { clickCount: 2 })]);
      assert.equal(pocetPost(), pred + 1);
      assert.equal((await uctenka()).notes, 'moje poznámka');
    });

    test('chyba serveru při kontrole uložení nezablokuje', async () => {
      await otevriUctenku();
      await fetchVrati(500);
      await klikANavigace(ULOZIT);
      assert.equal((await uctenka()).notes, 'moje poznámka');
      assert.ok((await url()).includes('saved=1'));
    });

    test('Zrušit po poplachu vrátí uložený stav, F5 po poplachu stránku vyčistí', async () => {
      await otevriUctenku();
      await sql`UPDATE receipts SET status = 'Storno' WHERE id = ${uctenkaId}`;
      await klikANavigace(ULOZIT);
      await pauza(600);
      await page.reload({ waitUntil: 'networkidle0' });
      assert.equal(await hlaska(), '', 'záznam se podruhé nepoužije');
      assert.equal(await hodnota('textarea[name="notes"]'), '');
      assert.equal(await hodnota('select[name="status"]'), 'Storno');

      await otevriUctenku();
      await sql`UPDATE receipts SET status = 'Storno' WHERE id = ${uctenkaId}`;
      await klikANavigace(ULOZIT);
      await pauza(600);
      dialogy = [];
      await page.click('.page-header-akce .upravit-zrusit');
      await pauza();
      assert.deepEqual(dialogy, ['confirm'], 'rozepsaná poznámka se bez dotazu nezahodí');
      assert.equal(await rezim(), 'zobrazeni');
      assert.equal(await hlaska(), '');
      assert.equal(await hodnota('select[name="status"]'), 'Storno');
      assert.equal(await hodnota('textarea[name="notes"]'), '');
    });

    test('přijatá faktura: cizí změna měny se pozná i u pole přes form=, Uložit z patičky', async () => {
      await jdi(`/ucetnictvi/prijate-faktury/${fakturaId}`);
      await otevrit();
      await nastav('textarea[name="notes"]', 'přes patičku');
      await sql`UPDATE accounting_invoices SET currency = 'EUR' WHERE id = ${fakturaId}`;
      await klikANavigace('.upravit-paticka .upravit-ulozit');
      assert.equal(await hodnota('select[name="currency"]'), 'EUR');
      assert.equal(await hodnota('textarea[name="notes"]'), 'přes patičku');
      assert.match(await hlaska(), /mezitím změnil.*Měna/);
      await pauza(600);
      await klikANavigace('.upravit-paticka .upravit-ulozit');
      const [f] = await sql`SELECT currency, notes, status FROM accounting_invoices WHERE id = ${fakturaId}`;
      assert.deepEqual(f, { currency: 'EUR', notes: 'přes patičku', status: 'Nezaplacena' });
      await sql`UPDATE accounting_invoices SET currency = 'CZK' WHERE id = ${fakturaId}`;
    });

    test('chyba ze serveru vrátí jen změněná pole, cizí hodnota zůstane', async () => {
      const cizi = `Cizí název ${r}`;
      const puvodni = `Režim ${r}`;
      await jdi(`${eshop}?tab=zakladni`);
      await otevrit();
      await nastav('input[name="url"]', 'ftp://spatne.example.invalid');
      await sql`UPDATE shops SET name = ${cizi} WHERE id = ${shopId}`;
      await klikANavigace(ULOZIT);
      assert.equal(await hodnota('input[name="name"]'), cizi);
      await pauza(600);
      await klikANavigace(ULOZIT);
      assert.ok((await url()).includes('error=zakladni-url'), await url());
      assert.equal(await hodnota('input[name="url"]'), 'ftp://spatne.example.invalid');
      assert.equal(await hodnota('input[name="name"]'), cizi);
      await nastav('input[name="url"]', 'https://novy.example.invalid');
      await klikANavigace(ULOZIT);
      const [s] = await sql`SELECT name, url FROM shops WHERE id = ${shopId}`;
      assert.deepEqual(s, { name: cizi, url: 'https://novy.example.invalid' });
      await sql`UPDATE shops SET name = ${puvodni}, url = 'https://example.invalid' WHERE id = ${shopId}`;
    });

    test('hodnota, kterou prohlížeč sám ořeže, poplach ani změnu uživatele nevyvolá', async () => {
      await sql`UPDATE shops SET email_reply_to = '  odpovedi@example.invalid  ' WHERE id = ${shopId}`;
      await jdi(`${eshop}?tab=identita`);
      await otevrit();
      await nastav('input[name="tagline"]', 'Moje');
      await sql`UPDATE shops SET email_from_name = 'Cizí odesílatel' WHERE id = ${shopId}`;
      await klikANavigace(ULOZIT);
      const text = await hlaska();
      assert.match(text, /mezitím změnil/);
      assert.ok(!text.includes('jste měnili i vy'), text);
      assert.equal(await hodnota('input[name="email_reply_to"]'), 'odpovedi@example.invalid');
      await sql`UPDATE shops SET email_reply_to = '', email_from_name = 'Režim', tagline = '' WHERE id = ${shopId}`;
    });

    test('stránka vykreslená z POST (Ověřit připojení): kontrola jde na adresu tužky', async () => {
      await jdi(`${eshop}?tab=marketing`);
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.evaluate((cesta) => {
        const f = document.createElement('form');
        f.method = 'post';
        f.action = `${cesta}/marketing/zdroj/sklik/overit`;
        document.body.appendChild(f);
        f.submit();
      }, eshop)]);
      await otevrit();
      await nastav('input[name="marketing_margin_pct"]', '44');
      await sql`UPDATE shops SET marketing_pno_alert_pct = 77 WHERE id = ${shopId}`;
      await klikANavigace(ULOZIT);
      assert.equal(Number(await hodnota('input[name="marketing_margin_pct"]')), 44);
      assert.equal(Number(await hodnota('input[name="marketing_pno_alert_pct"]')), 77);
      await sql`UPDATE shops SET marketing_pno_alert_pct = 0 WHERE id = ${shopId}`;
    });

    test('třetí poplach v řadě se zeptá, aby se nedalo uložení zablokovat navždy', async () => {
      await otevriUctenku();
      for (const kolo of [1, 2]) {
        await sql`UPDATE receipts SET vendor = ${`Cizí ${kolo} ${r}`} WHERE id = ${uctenkaId}`;
        await klikANavigace(ULOZIT);
        assert.deepEqual(dialogy, [], `poplach ${kolo} bez dotazu`);
        await pauza(600);
      }
      await sql`UPDATE receipts SET vendor = ${`Cizí 3 ${r}`} WHERE id = ${uctenkaId}`;
      const pred = pocetPost();
      await klikANavigace(ULOZIT);
      assert.deepEqual(dialogy, ['confirm']);
      assert.equal(pocetPost(), pred + 1);
      assert.equal((await uctenka()).notes, 'moje poznámka');
      await obnovUctenku();
    });

    test('bez sessionStorage se poplach zeptá: Zrušit nic neuloží, OK přepíše vědomě', async () => {
      await otevriUctenku();
      await sql`UPDATE receipts SET status = 'Storno' WHERE id = ${uctenkaId}`;
      await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('plné úložiště'); }; });
      const pred = pocetPost();
      odpoved = 'dismiss';
      await page.click(ULOZIT);
      await pauza(500);
      assert.deepEqual(dialogy, ['confirm']);
      assert.equal(pocetPost(), pred);
      assert.deepEqual(await uctenka(), { status: 'Storno', notes: '' });
      assert.equal(await hodnota('textarea[name="notes"]'), 'moje poznámka');
      odpoved = 'accept';
      await klikANavigace(ULOZIT);
      assert.deepEqual(await uctenka(), { status: 'Nezaúčtována', notes: 'moje poznámka' });
    });

    test('kontrola, která visí, po 5 s uložení pustí', async () => {
      await otevriUctenku();
      await page.evaluate(() => {
        window.fetch = (_, volby) => new Promise((_, odmitni) => volby.signal.addEventListener('abort', () => odmitni(new DOMException('čas', 'AbortError'))));
      });
      await klikANavigace(ULOZIT);
      assert.equal((await uctenka()).notes, 'moje poznámka');
    });

    test('výpadek sítě: poprvé hláška a nic se neztratí, podruhé odešle', async () => {
      await otevriUctenku();
      await fetchVrati('sit');
      const pred = pocetPost();
      await page.click(ULOZIT);
      await pauza();
      assert.equal(pocetPost(), pred);
      assert.match(await hlaska(), /Server teď neodpovídá/);
      assert.equal(await hodnota('textarea[name="notes"]'), 'moje poznámka');
      assert.equal(await page.$eval(ULOZIT, el => el.textContent), 'Uložit', 'tlačítko se vrátilo');
      await klikANavigace(ULOZIT);
      assert.equal((await uctenka()).notes, 'moje poznámka');
    });

    test('vypršené přihlášení: nic se neodešle a po novém přihlášení druhé Uložit uloží', async () => {
      await otevriUctenku();
      const [radek] = await sql`SELECT * FROM session WHERE sid = ${session.sid}`;
      await sql`DELETE FROM session WHERE sid = ${session.sid}`;
      const pred = pocetPost();
      try {
        await page.click(ULOZIT);
        await cekejHlasku();
        assert.equal(pocetPost(), pred);
        assert.match(await hlaska(), /Přihlášení vypršelo/);
        assert.equal(await hodnota('textarea[name="notes"]'), 'moje poznámka');
      } finally {
        // Nové přihlášení v jiném panelu: server vydal během výpadku jinou cookie.
        await sql`INSERT INTO session ${sql(radek)}`;
        await page.setCookie(cookie);
      }
      await klikANavigace(ULOZIT);
      assert.equal((await uctenka()).notes, 'moje poznámka');
    });

    test('smazaný záznam: nic se neodešle, hláška a údaje zůstanou', async () => {
      const [smazana] = await sql`INSERT INTO receipts (vendor, amount, vat_amount, total_amount, currency, receipt_date, category, status)
        VALUES ('Ke smazání', 1, 0, 1, 'CZK', '2026-02-02', 'Ostatní', 'Nezaúčtována') RETURNING id`;
      await jdi(`/ucetnictvi/uctenky/${smazana.id}`);
      await otevrit();
      await nastav('textarea[name="notes"]', 'marná práce');
      await sql`DELETE FROM receipts WHERE id = ${smazana.id}`;
      const pred = pocetPost();
      await page.click(ULOZIT);
      await cekejHlasku();
      assert.equal(pocetPost(), pred);
      assert.match(await hlaska(), /někdo smazal/);
      assert.equal(await hodnota('textarea[name="notes"]'), 'marná práce');
      assert.equal((await sql`SELECT id FROM receipts WHERE id = ${smazana.id}`).length, 0);
    });
  });

  test('Esc v poli jiného formuláře úpravy nezavře', async () => {
    await jdi(`${eshop}?tab=marketing`);
    await otevrit();
    await page.focus('form[action*="/marketing/zdroj"] input:not([type="hidden"]):not([type="checkbox"])');
    await page.keyboard.press('Escape');
    await pauza();
    assert.equal(await rezim(), 'upravy');
    assert.deepEqual(dialogy, []);
  });

  test('otevřené menu na mobilu zůstane zamčené i po dalším kliku', async () => {
    await page.setViewport({ width: 390, height: 844 });
    try {
      await jdi(`${eshop}?tab=zakladni`);
      await page.click('#sidebarToggle');
      await pauza(300);
      assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden', 'stránka pod menu se neposouvá');
    } finally {
      await page.setViewport({ width: 1366, height: 900 });
    }
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
