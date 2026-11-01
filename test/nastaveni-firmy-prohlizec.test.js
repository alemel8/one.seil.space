// Záložky Nastavení firmy v opravdovém prohlížeči: tužka musí nést ?tab=, jinak kontrola
// při Uložit formulář v načtené stránce nenajde a tiše se vypne. Cizí změna na téže
// záložce vyvolá poplach, změna na jiné záložce ne a nepřepíše se.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/nastaveni-firmy-prohlizec.test.js

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import puppeteer from 'puppeteer';
import { BASE, PRESKOCIT, lokalniDatabaze, serverBezi, prihlas } from './pomocnici/server.js';

const SLOUPCE = ['name', 'ico', 'bank_account', 'bank_name', 'pohoda_predkontace', 'gdrive_root_folder_id'];
const ULOZIT = '.page-header-akce .upravit-ulozit';

describe('Nastavení firmy v prohlížeči', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(3).toString('hex');
  let sql, browser, page, session, userId, puvodni, novyRadek, id, cookie;
  let dialogy = [];
  const jsChyby = [];
  const postZapisy = [];

  const pauza = (ms = 150) => new Promise(res => setTimeout(res, ms));
  const jdi = async (cesta) => { await page.goto(BASE + cesta, { waitUntil: 'networkidle0' }); dialogy = []; };
  const adresa = () => page.evaluate(() => location.pathname + location.search);
  const rezim = () => page.$eval('[data-rezim]', el => el.dataset.rezim);
  const otevrit = async () => { await page.click('.page-header-akce .upravit-otevrit'); await pauza(600); };
  const klikANavigace = (sel) => Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click(sel)]);
  const hodnota = (sel) => page.$eval(sel, el => el.value);
  const nastav = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const hlaska = () => page.$eval('[data-hlaska]', el => el.textContent).catch(() => '');
  const radek = async () => (await sql`SELECT * FROM company_settings WHERE id = ${id}`)[0];

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const [u] = await sql`INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`firma-br-${r}@example.invalid`}, 'x', 'Firma', 'Test', TRUE) RETURNING id`;
    userId = u.id;
    session = await prihlas(sql, userId);
    [puvodni] = await sql`SELECT * FROM company_settings ORDER BY id LIMIT 1`;
    if (!puvodni) [novyRadek] = await sql`INSERT INTO company_settings (name) VALUES ('test') RETURNING id`;
    id = puvodni?.id ?? novyRadek.id;

    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    cookie = { name: 'sessionId', value: session.cookie.slice('sessionId='.length), domain: new URL(BASE).hostname, path: '/' };
    await page.setCookie(cookie);
    page.on('pageerror', e => jsChyby.push(e.message));
    page.on('request', q => { if (q.method() === 'POST') postZapisy.push(q.url()); });
    page.on('dialog', async d => { dialogy.push(d.type()); await d.accept(); });
  });

  after(async () => {
    await browser?.close();
    if (!sql) return;
    if (puvodni) await sql`UPDATE company_settings SET ${sql(puvodni, ...SLOUPCE, 'updated_at')} WHERE id = ${puvodni.id}`;
    else if (novyRadek) await sql`DELETE FROM company_settings WHERE id = ${novyRadek.id}`;
    await sql`DELETE FROM session WHERE sid = ${session?.sid ?? ''}`;
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.end();
  });

  beforeEach(() => sql`UPDATE company_settings SET ${sql({
    name: `Firma ${r}`, ico: '12345678', bank_account: '111/0100', bank_name: 'Banka A', pohoda_predkontace: '3Vd', gdrive_root_folder_id: `sl${r}`,
  })} WHERE id = ${id}`);

  test('tužka na záložce: adresa nese tab, fokus v prvním poli, Zrušit se vrátí na záložku', async () => {
    await jdi('/nastaveni/firma?tab=fakturace');
    await otevrit();
    assert.equal(await rezim(), 'upravy');
    assert.equal(await adresa(), '/nastaveni/firma?tab=fakturace&upravit=1');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'bank_account');
    await page.click('.page-header-akce .upravit-zrusit');
    await pauza();
    assert.equal(await rezim(), 'zobrazeni');
    assert.equal(await adresa(), '/nastaveni/firma?tab=fakturace');
    assert.deepEqual(dialogy, []);
  });

  test('rozepsaná změna a klik na jinou záložku: beforeunload a text zůstane', async () => {
    await jdi('/nastaveni/firma?tab=fakturace');
    await otevrit();
    await page.type('input[name="bank_name"]', 'X');
    const odmitnout = (d) => { dialogy.push(d.type()); d.dismiss(); };
    page.removeAllListeners('dialog');
    page.on('dialog', odmitnout);
    await page.evaluate(() => document.querySelector('.tabs a[href$="?tab=pohoda"]').click());
    await pauza(400);
    page.removeAllListeners('dialog');
    page.on('dialog', async d => { dialogy.push(d.type()); await d.accept(); });
    assert.deepEqual(dialogy, ['beforeunload']);
    assert.ok((await hodnota('input[name="bank_name"]')).includes('X'), 'text zůstal');
  });

  test('cizí změna na téže záložce: první Uložit nic neodešle, ukáže pole; druhé uloží a cizí nepřepíše', async () => {
    await jdi('/nastaveni/firma?tab=fakturace');
    await otevrit();
    await nastav('input[name="bank_name"]', 'Moje banka');
    await sql`UPDATE company_settings SET bank_account = '999/0800' WHERE id = ${id}`;
    const pred = postZapisy.length;
    await klikANavigace(ULOZIT);
    assert.equal(postZapisy.length, pred, 'bez odeslání');
    assert.equal(await rezim(), 'upravy');
    assert.ok((await adresa()).includes('tab=fakturace'));
    assert.equal(await hodnota('input[name="bank_account"]'), '999/0800', 'pole ukazuje aktuální hodnotu');
    assert.equal(await hodnota('input[name="bank_name"]'), 'Moje banka', 'rozepsané zůstalo');
    assert.match(await hlaska(), /mezitím změnil.*Číslo účtu/);

    await pauza(600);
    await klikANavigace(ULOZIT);
    const po = await radek();
    assert.equal(po.bank_account, '999/0800');
    assert.equal(po.bank_name, 'Moje banka');
    assert.equal(await adresa(), '/nastaveni/firma?tab=fakturace&saved=1');
  });

  test('cizí změna na jiné záložce: bez poplachu, uloží se hned a nepřepíše se', async () => {
    await jdi('/nastaveni/firma?tab=pohoda');
    await otevrit();
    await nastav('input[name="pohoda_predkontace"]', '7Xy');
    await sql`UPDATE company_settings SET ico = '87654321', bank_name = 'Cizí banka' WHERE id = ${id}`;
    await klikANavigace(ULOZIT);
    assert.equal(await adresa(), '/nastaveni/firma?tab=pohoda&saved=1');
    const po = await radek();
    assert.equal(po.pohoda_predkontace, '7Xy');
    assert.equal(po.ico, '87654321');
    assert.equal(po.bank_name, 'Cizí banka');
  });

  test('hláška Uloženo po tužce zmizí a z adresy zmizí saved', async () => {
    await jdi('/nastaveni/firma?tab=disk&saved=1');
    assert.ok((await hlaska()).includes('uloženo'));
    await otevrit();
    assert.equal(await adresa(), '/nastaveni/firma?tab=disk&upravit=1');
    await page.click('.page-header-akce .upravit-zrusit');
    await pauza();
    assert.equal(await adresa(), '/nastaveni/firma?tab=disk');
    assert.equal(await hlaska(), '');
  });

  test('bez JavaScriptu: tužka je odkaz a Uložit uloží jen záložku', async () => {
    const kontext = await browser.createBrowserContext();
    const bez = await kontext.newPage();
    await bez.setJavaScriptEnabled(false);
    await bez.setCookie(cookie);
    await bez.goto(`${BASE}/nastaveni/firma?tab=fakturace`, { waitUntil: 'load' });
    await Promise.all([bez.waitForNavigation({ waitUntil: 'load' }), bez.click('.page-header-akce .upravit-otevrit')]);
    assert.ok(bez.url().endsWith('?tab=fakturace&upravit=1'), bez.url());
    await bez.$eval('input[name="bank_name"]', el => { el.value = 'Bez JS'; });
    await Promise.all([bez.waitForNavigation({ waitUntil: 'load' }), bez.click(ULOZIT)]);
    const po = await radek();
    assert.equal(po.bank_name, 'Bez JS');
    assert.equal(po.name, `Firma ${r}`);
    assert.equal(po.gdrive_root_folder_id, `sl${r}`);
    await kontext.close();
  });

  test('žádná chyba JavaScriptu během scénářů', () => {
    assert.deepEqual(jsChyby, []);
  });
});
