// Seznam účtenek proti běžícímu serveru a lokální databázi: stránkování, filtry,
// návrat po akci v řádku a skript stránky v opravdovém prohlížeči. Skript dřív
// padal hned při načtení (rcOpen) a s ním Zadat ručně, výběr i dofocení dokladu.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test --test-concurrency=1 test/seznam-uctenky.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import puppeteer from 'puppeteer';
import { BASE, PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';
import { overSeznam, odkazStrany } from './pomocnici/seznamy.js';

const SEZNAM = '/ucetnictvi/uctenky';

describe('seznam účtenek', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  const POCET = 61;
  let sql; let sid; let req; let cookie; let uzivatel; let ids = [];
  // Uvozovka na konci: /uctenky/12 by se jinak našlo i v /uctenky/123.
  const token = (id) => `${SEZNAM}/${id}"`;
  const naStrance = (html, vyber = ids) => vyber.filter(id => html.includes(token(id)));
  const nacti = async (adresa) => {
    const res = await req.get(adresa);
    assert.equal(res.status, 200, adresa);
    return res.text();
  };

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`su-${r}@example.invalid`}, 'x', TRUE, TRUE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    cookie = prihlaseni.cookie;
    req = pozadavky(cookie);
    // Shodné datum u všech: pořadí mezi stranami drží jen poslední klíč.
    const radky = Array.from({ length: POCET }, (_, i) => ({
      number: `UC${r}${i}`, vendor: `Dodavatel ${r}`, notes: i < 3 ? `${r}tri${i === 0 ? ` ${r}jedna` : ''}` : null,
      amount: 100, vat_amount: 21, total_amount: 121, currency: 'CZK', receipt_date: '2026-01-15', category: 'Ostatní',
      status: i % 2 ? 'Zaúčtována' : 'Nezaúčtována', payment_method: i % 3 ? 'Karta' : 'Hotovost',
    }));
    ids = (await sql`INSERT INTO receipts ${sql(radky)} RETURNING id`).map(x => x.id);
  });

  after(async () => {
    await sql`DELETE FROM receipts WHERE vendor LIKE ${`%${r}%`}`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  test('stránkování se shodným datem: každý řádek právě jednou, neplatné page nespadne', () => overSeznam({
    req, adresa: `${SEZNAM}?q=${r}`, tokeny: ids.map(token), filtr: { q: r },
  }));

  test('filtr podle stavu a úhrady platí i na další stránce a drží ho odkazy', async () => {
    const zauctovane = ids.filter((_, i) => i % 2);
    const html = await nacti(`${SEZNAM}?q=${r}&status=${encodeURIComponent('Zaúčtována')}&page=2`);
    const radky = naStrance(html);
    assert.equal(radky.length, zauctovane.length - 25);
    assert.ok(radky.every(id => zauctovane.includes(id)));
    const predchozi = new URL(odkazStrany(html, 'prev'), 'http://x').searchParams;
    assert.equal(predchozi.get('q'), r);
    assert.equal(predchozi.get('status'), 'Zaúčtována');

    const hotove = ids.filter((_, i) => i % 3 === 0);
    assert.ok(hotove.length < 25);
    const hotovost = await nacti(`${SEZNAM}?q=${r}&platba=Hotovost`);
    assert.deepEqual(naStrance(hotovost).sort(), [...hotove].sort());
    assert.ok(hotovost.includes(`${hotove.length} účtenek odpovídá filtru`));

    const karta = await nacti(`${SEZNAM}?q=${r}&platba=Karta`);
    assert.equal(new URL(odkazStrany(karta, 'next'), 'http://x').searchParams.get('platba'), 'Karta');
  });

  test('hlavička: počet podle filtru se správným tvarem', async () => {
    assert.ok((await nacti(`${SEZNAM}?q=${r}`)).includes(`${POCET} účtenek odpovídá filtru`));
    assert.ok((await nacti(`${SEZNAM}?q=${r}tri`)).includes('3 účtenky odpovídají filtru'));
    assert.ok((await nacti(`${SEZNAM}?q=${r}jedna`)).includes('1 účtenka odpovídá filtru'));
    assert.match(await nacti(SEZNAM), /<p>\d+ (účtenka|účtenky|účtenek) celkem<\/p>/);
  });

  test('velikost stránky: 50 řádků a odkazy ji drží', async () => {
    const html = await nacti(`${SEZNAM}?q=${r}&velikost=50`);
    assert.equal(naStrance(html).length, 50);
    assert.ok(html.includes('velikost=50&amp;page=2'));
  });

  test('změna stavu v řádku vrací na tutéž stránku a filtr', async () => {
    const html = await nacti(`${SEZNAM}?q=${r}&status=${encodeURIComponent('Zaúčtována')}&page=2`);
    const navrat = /name="redirect_to" value="([^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
    assert.equal(navrat, `${SEZNAM}?q=${r}&status=${encodeURIComponent('Zaúčtována')}&page=2`);
    const id = naStrance(html)[0];
    const res = await req.post(`${SEZNAM}/${id}/stav`, { status: 'Zaúčtována', redirect_to: navrat });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), navrat);
  });

  test('smazání v řádku vrací na tutéž stránku, poslední řádek poslední stránky neskončí prázdnou tabulkou', async () => {
    const [navic] = await sql`INSERT INTO receipts (vendor, receipt_date, status) VALUES (${`Smazat ${r}`}, '2000-01-01', 'Nezaúčtována') RETURNING id`;
    const adresa = `${SEZNAM}?q=${encodeURIComponent(`Smazat ${r}`)}`;
    const html = await nacti(adresa);
    assert.ok(html.includes(`action="${SEZNAM}/${navic.id}/smazat"`));
    const res = await req.post(`${SEZNAM}/${navic.id}/smazat`, { redirect_to: adresa });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), adresa);
    assert.equal((await sql`SELECT 1 FROM receipts WHERE id = ${navic.id}`).length, 0);

    // Stránka za koncem po smazání: 61 řádků, stránka 3 má jeden, po smazání zbude 60 na dvou stranách.
    const [posledni] = await sql`INSERT INTO receipts (vendor, receipt_date, status) VALUES (${`Dodavatel ${r}`}, '2000-01-01', 'Nezaúčtována') RETURNING id`;
    const treti = await nacti(`${SEZNAM}?q=${r}&page=3`);
    assert.ok(treti.includes(token(posledni.id)));
    await req.post(`${SEZNAM}/${posledni.id}/smazat`, { redirect_to: `${SEZNAM}?q=${r}&page=4` });
    const poSmazani = await nacti(`${SEZNAM}?q=${r}&page=4`);
    assert.equal(naStrance(poSmazani).length, POCET - 50, 'ukáže poslední stránku, ne prázdnou tabulku');
  });

  test('cizí návratová adresa se nepoužije, bez adresy zpět na seznam', async () => {
    const id = ids[0];
    for (const cil of ['https://evil.example/x', '//evil.example/x', '/\\evil.example']) {
      const res = await req.post(`${SEZNAM}/${id}/stav`, { status: 'Nezaúčtována', redirect_to: cil });
      assert.equal(res.headers.get('location'), SEZNAM, cil);
    }
    assert.equal((await req.post(`${SEZNAM}/${id}/stav`, { status: 'Nezaúčtována' })).headers.get('location'), SEZNAM);

    const [navic] = await sql`INSERT INTO receipts (vendor, receipt_date) VALUES (${`Cizi ${r}`}, '2000-01-01') RETURNING id`;
    const res = await req.post(`${SEZNAM}/${navic.id}/smazat`, { redirect_to: '//evil.example/x' });
    assert.equal(res.headers.get('location'), SEZNAM);
  });

  test('prázdný výsledek filtru: nabídne zrušení filtru a nemá patičku', async () => {
    const html = await nacti(`${SEZNAM}?q=${r}-nic&page=3`);
    assert.ok(html.includes('Filtru neodpovídá žádná účtenka'));
    assert.ok(!html.includes('class="strankovani"'));
    assert.match(html, /<td colspan="10">/, 'colspan na všech deset sloupců');
    assert.equal((html.match(/<th[ >]/g) || []).length, 10);
  });

  test('dvojitý parametr ?q=a&q=b ani NUL nespadnou', async () => {
    for (const dotaz of [`q=${r}&q=jine`, `status=a&status=b`, `platba=a&platba=b`, `q=%00`]) {
      assert.equal((await req.get(`${SEZNAM}?${dotaz}`)).status, 200, dotaz);
    }
  });

  test('řádek má skutečný odkaz, formulář filtru nemá page, stránka nemá vlastní pager', async () => {
    const html = await nacti(`${SEZNAM}?q=${r}&page=2`);
    assert.match(html, new RegExp(`<a href="${SEZNAM}/\\d+" class="radek-odkaz">`));
    assert.match(html, new RegExp(`<tr data-href="${SEZNAM}/\\d+">`));
    assert.ok(!/<tr[^>]*onclick/.test(html), 'žádné onclick na řádku');
    assert.ok(!html.includes('event.stopPropagation'));
    assert.ok(!html.includes('?page='), 'odkazy stran skládá jen patička');
    const filtr = /<form method="get" class="filtr-lista">[\s\S]*?<\/form>/.exec(html)[0];
    assert.ok(!filtr.includes('name="page"'));
    assert.ok(html.includes('title="Vybrat všechny na této stránce"'));
    assert.ok(html.includes('Výběr platí jen pro tuto stránku'));
  });

  test('detail účtenky má návrat na seznam', async () => {
    const html = await nacti(`${SEZNAM}/${ids[0]}`);
    assert.match(html, /<a href="\/ucetnictvi\/uctenky" class="btn btn-ghost btn-sm" data-zpet>/);
  });

  describe('v prohlížeči', () => {
    let browser; let page; let pdf;
    const jsChyby = [];
    const adresaStrany2 = () => `${SEZNAM}?q=${r}&page=2`;
    const jdi = (cesta) => page.goto(BASE + cesta, { waitUntil: 'networkidle0' });
    const url = () => page.evaluate(() => location.pathname + location.search);
    const pauza = (ms = 150) => new Promise(res => setTimeout(res, ms));
    const listaVidet = () => page.$eval('#bulkBar', el => getComputedStyle(el).display !== 'none');
    let odpovedDialogu = true;

    before(async () => {
      browser = await puppeteer.launch({ headless: true });
      page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      await page.setCookie({ name: 'sessionId', value: cookie.slice('sessionId='.length), domain: new URL(BASE).hostname, path: '/' });
      page.on('pageerror', e => jsChyby.push(e.message));
      page.on('dialog', d => (odpovedDialogu ? d.accept() : d.dismiss()));
      pdf = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'seznam-uctenky-')), 'doklad.pdf');
      await fs.writeFile(pdf, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    });

    after(async () => {
      await browser?.close();
      if (pdf) await fs.rm(path.dirname(pdf), { recursive: true, force: true });
    });

    test('načtení stránky bez chyby JS', async () => {
      jsChyby.length = 0;
      await jdi(`${SEZNAM}?q=${r}`);
      assert.deepEqual(jsChyby, []);
      assert.equal(await page.evaluate(() => typeof window.rcOpen), 'function');
    });

    test('Přidat účtenku a Zadat ručně otevře formulář a uloží účtenku', async () => {
      await jdi(`${SEZNAM}?q=${r}`);
      await page.click('[data-modal-open="modalCreate"]');
      await pauza();
      assert.ok(await page.$('#modalCreate.open'), 'modal je otevřený');
      const textModalu = await page.$eval('#rcPhaseUpload', el => el.innerText);
      assert.ok(textModalu.includes('Zadat ručně'));

      await page.evaluate(() => [...document.querySelectorAll('#rcPhaseUpload button')].find(b => b.innerText.includes('Zadat ručně')).click());
      await pauza();
      assert.ok(await page.$('#rcModalInner.rc-expanded'), 'modal se rozšířil na formulář');
      assert.equal(await page.$eval('#rcPhaseForm', el => getComputedStyle(el).display), 'flex');
      assert.equal(await page.$eval('#rcPhaseUpload', el => el.style.display), 'none');
      const { modal, obsah } = await page.evaluate(() => ({
        modal: document.getElementById('rcModalInner').clientWidth,
        obsah: document.querySelector('#rcPhaseForm > div').getBoundingClientRect().width,
      }));
      assert.ok(obsah >= modal - 1, `náhled s formulářem vyplní modal (${obsah} z ${modal} px)`);

      // Kód za místem starého pádu: nápověda k úhradě a zámek odpočtu u reprezentace.
      await page.select('#rcCategory', 'Reprezentace');
      assert.equal(await page.$eval('#rcVatDeductible', el => el.disabled), true);
      assert.ok((await page.$eval('#rcUhradaHint', el => el.textContent)).includes('odpočet DPH nelze uplatnit'));
      await page.select('#rcCategory', 'Ostatní');
      await page.select('#rcPayment', 'Karta');
      assert.ok((await page.$eval('#rcUhradaHint', el => el.textContent)).includes('Ostatních závazků'));

      await page.type('#rcVendor', `Ruční ${r}`);
      await page.type('#rcTotal', '242');
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#rcSubmitBtn')]);
      assert.equal(await url(), SEZNAM);
      const [ulozena] = await sql`SELECT payment_method, total_amount FROM receipts WHERE vendor = ${`Ruční ${r}`}`;
      assert.ok(ulozena, 'účtenka vznikla');
      assert.equal(ulozena.payment_method, 'Karta');
      await sql`DELETE FROM receipts WHERE vendor = ${`Ruční ${r}`}`;
    });

    // Vytěžení se v testu odchytí, ať nejde ven žádný požadavek na Anthropic.
    const sOdchytem = async (odpoved, telo) => {
      const odchyt = (q) => (q.url().endsWith(`${SEZNAM}/analyze-pdf`) ? q.respond(odpoved) : q.continue());
      await page.setRequestInterception(true);
      page.on('request', odchyt);
      try {
        await telo();
      } finally {
        page.off('request', odchyt);
        await page.setRequestInterception(false);
      }
    };

    test('nahrání dokladu předvyplní pole a soubor se uloží s účtenkou', async () => {
      const vytezeno = { number: `AI${r}`, vendor: `Vytěženo ${r}`, amount: 100, vat_amount: 21, total_amount: 121, currency: 'CZK', receipt_date: '2026-01-20', category: 'PHM', payment_method: 'Karta', notes: 'Benzin' };
      await jdi(`${SEZNAM}?q=${r}`);
      await sOdchytem({ status: 200, contentType: 'application/json', body: JSON.stringify(vytezeno) }, async () => {
        await page.click('[data-modal-open="modalCreate"]');
        await pauza();
        await (await page.$('#rcFileInput')).uploadFile(pdf);
        await page.waitForSelector('#rcModalInner.rc-expanded');
        assert.equal(await page.$eval('#rcVendor', el => el.value), vytezeno.vendor);
        assert.equal(await page.$eval('#rcCategory', el => el.value), 'PHM');
        assert.equal(await page.$eval('#rcPayment', el => el.value), 'Karta');
        assert.ok((await page.$eval('#rcAiBadge', el => el.textContent)).includes('předvyplněna'));
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#rcSubmitBtn')]);
      });
      const [ulozena] = await sql`SELECT id, attachment_path, attachment_mime, category FROM receipts WHERE vendor = ${vytezeno.vendor}`;
      assert.ok(ulozena?.attachment_path, 'doklad se uložil k účtence');
      assert.equal(ulozena.attachment_mime, 'application/pdf');
      assert.equal(ulozena.category, 'PHM');
      await req.post(`${SEZNAM}/${ulozena.id}/smazat`);
    });

    test('když vytěžení selže, formulář nabídne ruční vyplnění a řekne proč', async () => {
      await jdi(`${SEZNAM}?q=${r}`);
      await sOdchytem({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Vytěžení není k dispozici' }) }, async () => {
        await page.click('[data-modal-open="modalCreate"]');
        await pauza();
        await (await page.$('#rcFileInput')).uploadFile(pdf);
        await page.waitForSelector('#rcModalInner.rc-expanded');
        const hlaska = await page.$eval('#rcAiBadge', el => el.textContent);
        assert.ok(hlaska.includes('Vytěžení není k dispozici') && hlaska.includes('vyplňte pole ručně'), hlaska);
      });
    });

    test('křížek zavře modal a vrátí scroll stránky', async () => {
      await jdi(`${SEZNAM}?q=${r}`);
      await page.click('[data-modal-open="modalCreate"]');
      await pauza();
      await page.click('#modalCreate .modal-close');
      await pauza();
      assert.equal(await page.$('#modalCreate.open'), null);
      assert.equal(await page.evaluate(() => document.body.style.overflow), '');
    });

    test('výběr řádků ukáže lištu s rozpadem na pokladnu a závazky', async () => {
      await jdi(`${SEZNAM}?q=${r}`);
      assert.equal(await listaVidet(), false, 'bez výběru lišta není');
      const zaskrtavatka = await page.$$('.bulk-cb');
      assert.equal(zaskrtavatka.length, 25);
      const [prvni, druhy] = await page.$$eval('.bulk-cb', c => c.slice(0, 2).map(x => x.value));
      await zaskrtavatka[0].click();
      assert.equal(await listaVidet(), true, 'lišta se ukáže po prvním zaškrtnutí');
      assert.equal(await page.$eval('#bulkCount', el => el.textContent), '1 vybráno');
      await zaskrtavatka[1].click();
      assert.equal(await page.$eval('#bulkCount', el => el.textContent), '2 vybráno');

      // Řádky jdou od nejvyššího id: i=60 je hotově a i=59 kartou.
      assert.deepEqual([prvni, druhy].map(Number), [ids[60], ids[59]]);
      assert.equal(await page.$eval('#bulkSplit', el => el.textContent), '1 do pokladny · 1 do ostatních závazků');
      assert.equal(await page.$eval('#bulkSelectAll', el => el.indeterminate), true);
      assert.deepEqual(await page.$eval('#bulkPohodaForm', f => new FormData(f).getAll('ids')), [prvni, druhy], 'export pošle právě vybrané');

      await page.click('#bulkSelectAll');
      assert.equal(await page.$eval('#bulkCount', el => el.textContent), '25 vybráno', 'Vybrat vše jen na této stránce');
      await page.evaluate(() => [...document.querySelectorAll('#bulkBar button')].find(b => b.innerText.includes('Zrušit výběr')).click());
      assert.equal(await listaVidet(), false);
      assert.equal(await page.$$eval('.bulk-cb:checked', c => c.length), 0);
    });

    test('po návratu tlačítkem Zpět sedí lišta k zaškrtnutí', async () => {
      await jdi(`${SEZNAM}?q=${r}`);
      await (await page.$$('.bulk-cb'))[0].click();
      await page.goto(`${BASE}${SEZNAM}/${ids[60]}`, { waitUntil: 'networkidle0' });
      await page.goBack({ waitUntil: 'networkidle0' });
      await pauza();
      const zaskrtnuto = await page.$$eval('.bulk-cb:checked', c => c.length);
      assert.equal(await listaVidet(), zaskrtnuto > 0);
    });

    test('klik do řádku otevře detail, klik do buňky s výběrem ne; Zpět vede na stejnou stránku a filtr', async () => {
      await jdi(adresaStrany2());
      await page.click('tbody tr td:first-child');
      assert.equal(await url(), adresaStrany2(), 'buňka s výběrem řádek neotevře');
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('tbody tr td:nth-child(3)')]);
      assert.match(await url(), new RegExp(`^${SEZNAM}/\\d+$`));
      const zpet = await page.$eval('a[data-zpet]', a => a.getAttribute('href'));
      assert.equal(zpet, adresaStrany2());
    });

    test('změna stavu výběrem v řádku zůstane na stránce a filtru', async () => {
      await jdi(adresaStrany2());
      const id = await page.$eval('tbody tr .bulk-cb', c => Number(c.value));
      const novy = 'Storno';
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.select('tbody tr select.stav-vyber', novy)]);
      assert.equal(await url(), adresaStrany2());
      const [radek] = await sql`SELECT status FROM receipts WHERE id = ${id}`;
      assert.equal(radek.status, novy);
      await sql`UPDATE receipts SET status = 'Nezaúčtována' WHERE id = ${id}`;
    });

    test('smazání v řádku se zeptá a zůstane na stránce a filtru', async () => {
      await sql`INSERT INTO receipts (vendor, receipt_date, status) VALUES (${`Dodavatel ${r}`}, '2030-01-01', 'Nezaúčtována')`;
      await jdi(`${SEZNAM}?q=${r}&velikost=50`);
      const id = await page.$eval('tbody tr .bulk-cb', c => Number(c.value));

      odpovedDialogu = false;
      await page.click('tbody tr form[action$="/smazat"] button');
      await pauza();
      assert.equal((await sql`SELECT 1 FROM receipts WHERE id = ${id}`).length, 1, 'Zrušit v dialogu nemaže');

      odpovedDialogu = true;
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('tbody tr form[action$="/smazat"] button')]);
      assert.equal(await url(), `${SEZNAM}?q=${r}&velikost=50`);
      assert.equal((await sql`SELECT 1 FROM receipts WHERE id = ${id}`).length, 0);
    });

    test('dofocení dokladu v řádku uloží soubor a zůstane na stránce', async () => {
      await jdi(adresaStrany2());
      const id = await page.$eval('tbody tr .bulk-cb', c => Number(c.value));
      const vstup = await page.$('tbody tr input[type="file"]');
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), vstup.uploadFile(pdf)]);
      assert.equal(await url(), adresaStrany2());
      const [radek] = await sql`SELECT attachment_path, attachment_mime FROM receipts WHERE id = ${id}`;
      assert.ok(radek.attachment_path, 'příloha se uložila');
      assert.equal(radek.attachment_mime, 'application/pdf');
      assert.ok(await page.$(`tr[data-href="${SEZNAM}/${id}"] a.doklad-thumb`), 'řádek ukáže miniaturu');

      // Smazání odstraní i soubor z disku, po testu nic nezůstane.
      assert.equal((await req.post(`${SEZNAM}/${id}/smazat`)).status, 302);
    });

    test('telefon 390 px: stránka nepřetéká a sloupce Celkem, Doklad a Stav zůstávají', async () => {
      await page.setViewport({ width: 390, height: 844 });
      await jdi(`${SEZNAM}?q=${r}`);
      const { sirka, okno, viditelne } = await page.evaluate(() => ({
        sirka: document.documentElement.scrollWidth,
        okno: window.innerWidth,
        viditelne: [...document.querySelectorAll('.data-table thead th')]
          .filter(th => getComputedStyle(th).display !== 'none').map(th => th.innerText.trim().toLowerCase()),
      }));
      assert.ok(sirka <= okno, `dokument ${sirka} px v okně ${okno} px`);
      for (const sloupec of ['číslo', 'celkem', 'doklad', 'stav']) assert.ok(viditelne.includes(sloupec), sloupec);
      assert.ok(!viditelne.includes('kategorie'));

      // Formulář Zadat ručně je na telefonu delší než okno, tlačítko musí jít odrolovat.
      await page.click('[data-modal-open="modalCreate"]');
      await pauza(400);
      await page.evaluate(() => [...document.querySelectorAll('#rcPhaseUpload button')].find(b => b.innerText.includes('Zadat ručně')).click());
      await pauza(400);
      const tlacitko = await page.$eval('#rcSubmitBtn', el => { el.scrollIntoView(); const b = el.getBoundingClientRect(); return { dole: b.bottom, vpravo: b.right, okno: innerHeight, sirka: innerWidth }; });
      assert.ok(tlacitko.dole <= tlacitko.okno && tlacitko.vpravo <= tlacitko.sirka, `tlačítko Přidat je v okně: ${JSON.stringify(tlacitko)}`);
      await page.setViewport({ width: 1366, height: 900 });
    });

    test('užší okno s bočním menu: tabulka se posouvá ve svém rámu, stránka ne', async () => {
      for (const sirka of [1024, 820]) {
        await page.setViewport({ width: sirka, height: 800 });
        for (const adresa of [`${SEZNAM}?q=${r}`, `${SEZNAM}?q=${r}-nic`]) {
          await jdi(adresa);
          const { dokument, okno } = await page.evaluate(() => ({ dokument: document.documentElement.scrollWidth, okno: window.innerWidth }));
          assert.ok(dokument <= okno, `${adresa} při ${sirka} px: dokument ${dokument} px`);
        }
      }
      await page.setViewport({ width: 1366, height: 900 });
    });

    test('celý průchod bez chyby JS', () => {
      assert.deepEqual(jsChyby, []);
    });
  });
});
