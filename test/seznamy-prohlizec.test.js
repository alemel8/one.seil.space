// Seznamy v prohlížeči: návrat „← Zpět“ tam, odkud člověk přišel, pozice po akci
// v řádku, lišta výběru bez posunu tabulky a dosažitelné tlačítko v delším modalu.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/seznamy-prohlizec.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import puppeteer from 'puppeteer';
import { BASE, PRESKOCIT, lokalniDatabaze, prihlas, serverBezi } from './pomocnici/server.js';

describe('seznamy v prohlížeči', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  let sql; let browser; let page; let sid; let uzivatel; const jsChyby = [];
  const faktury = Array.from({ length: 60 }, (_, i) => `sb-${r}-${String(i).padStart(2, '0')}`);
  const firma = `sb-${r}-firma`;
  const projekt = `sb-${r}-projekt`;

  const jdi = (adresa) => page.goto(BASE + adresa, { waitUntil: 'domcontentloaded' });
  const zpet = () => page.$eval('a[data-zpet]', a => a.getAttribute('href'));
  const klikNaOdkaz = async (selektor) => {
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click(selektor)]);
  };

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`sb-${r}@example.invalid`}, 'x', TRUE, TRUE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    await sql`INSERT INTO crm_companies (id, name) VALUES (${firma}, ${`Firma ${r}`})`;
    await sql`INSERT INTO projects (id, company_id, name) VALUES (${projekt}, ${firma}, ${`Projekt ${r}`})`;
    await sql`INSERT INTO accounting_invoices ${sql(faktury.map((id, i) => ({
      id, type: 'received', number: `SB${r}${i}`, status: 'Zaplacena', supplier: `Dodavatel ${r}`, issue_date: '2026-02-01',
      amount: 100, vat_amount: 21, total_amount: 121, currency: 'CZK', crm_company_id: firma,
    })))}`;
    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
    page.on('pageerror', e => jsChyby.push(e.message));
    await page.setViewport({ width: 1366, height: 800 });
    await page.setCookie({ name: 'sessionId', value: prihlaseni.cookie.split('=')[1], domain: new URL(BASE).hostname, path: '/' });
  });

  after(async () => {
    await browser?.close();
    await sql`DELETE FROM accounting_invoices WHERE id = ANY(${faktury})`;
    await sql`DELETE FROM projects WHERE id = ${projekt}`;
    await sql`DELETE FROM crm_companies WHERE id = ${firma}`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  test('Zpět ze seznamu vede na tutéž stránku a filtr i po uložení detailu', async () => {
    const seznam = `/ucetnictvi/prijate-faktury?q=${r}&page=2`;
    await jdi(seznam);
    await klikNaOdkaz('a.radek-odkaz');
    assert.equal(await zpet(), seznam);
    const detail = new URL(page.url()).pathname;
    await jdi(`${detail}?saved=1`); // referrer je teď detail nebo nic, původ zůstává
    assert.equal(await zpet(), seznam);
  });

  test('Zpět z jiné stránky než seznamu vede na ni, ne na poslední seznam', async () => {
    await jdi(`/ucetnictvi/prijate-faktury?q=${r}&page=2`); // poslední seznam v paměti
    await jdi(`/hledat?q=SB${r}1`);
    await klikNaOdkaz(`a[href^="/ucetnictvi/prijate-faktury/"]`);
    assert.equal(await zpet(), `/hledat?q=SB${r}1`);
  });

  test('návrat přes Zpět není nový původ: A a B se nezacyklí', async () => {
    await jdi(`/ucetnictvi/prijate-faktury?q=${r}`);
    await klikNaOdkaz('a.radek-odkaz');
    const a = new URL(page.url()).pathname;
    const puvod = await zpet();
    await page.evaluate((cil) => { location.href = cil; }, `/ucetnictvi/prijate-faktury/${faktury[5]}`);
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
    assert.equal(await zpet(), a, 'druhý doklad se vrací na první');
    await klikNaOdkaz('a[data-zpet]');
    assert.equal(new URL(page.url()).pathname, a);
    assert.equal(await zpet(), puvod, 'první doklad dál vede na seznam, ne na druhý doklad');
  });

  test('jednorázové hlášky se do návratu nedostanou', async () => {
    await jdi(`/ucetnictvi/prijate-faktury?q=${r}&saved=1`);
    await klikNaOdkaz('a.radek-odkaz');
    assert.equal(await zpet(), `/ucetnictvi/prijate-faktury?q=${r}`);
  });

  test('změna stavu v řádku nechá stránku u řádku', async () => {
    await jdi(`/ucetnictvi/prijate-faktury?q=${r}`);
    await page.evaluate(() => window.scrollTo(0, 500));
    const pred = await page.evaluate(() => window.scrollY);
    assert.ok(pred > 300, 'stránka je dost dlouhá');
    const vyber = (await page.$$('select.stav-vyber'))[12];
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), vyber.select('Nezaplacena')]);
    assert.equal(await page.evaluate(() => window.scrollY), pred);
  });

  test('lišta výběru neposune tabulku pod kurzorem', async () => {
    await jdi(`/ucetnictvi/prijate-faktury?q=${r}`);
    const poloha = () => page.$eval('tbody tr:nth-child(4)', el => el.getBoundingClientRect().top);
    const pred = await poloha();
    await page.click('tbody tr:nth-child(4) .bulk-cb');
    assert.equal(await page.$eval('#bulkBar', el => getComputedStyle(el).display), 'flex');
    assert.equal(await poloha(), pred);
  });

  test('delší modal: tělo se posouvá a tlačítko odeslání jde dosáhnout', async () => {
    await page.setViewport({ width: 1366, height: 600 });
    await jdi(`/projekty/${projekt}?tab=podprojekty`);
    await page.click('[data-modal-open="modalAddItem"]');
    await page.waitForFunction(() => document.querySelector('#modalAddItem.open'));
    await new Promise(res => setTimeout(res, 300));
    const pozice = await page.$eval('#modalAddItem button[type="submit"]', el => {
      const b = el.getBoundingClientRect();
      const m = el.closest('.modal').getBoundingClientRect();
      return { spodek: b.bottom, konecModalu: m.bottom, okno: innerHeight };
    });
    assert.ok(pozice.spodek <= pozice.konecModalu && pozice.spodek <= pozice.okno, JSON.stringify(pozice));
    await page.setViewport({ width: 1366, height: 800 });
  });

  test('žádná chyba skriptu na stránkách', () => assert.deepEqual(jsChyby, []));
});
