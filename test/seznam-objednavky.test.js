// Seznam objednávek proti běžícímu serveru a lokální databázi: společná patička,
// filtry přes e-shop, stav a sklad, jednoznačné řazení a detail na telefonu.
// Objednávky leží ve vlastním e-shopu, aby nevytlačily test/eshop-admin.test.js
// z první stránky Toneráčku; ty v Toneráčku mají created_at hluboko v minulosti.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test --test-concurrency=1 test/seznam-objednavky.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import puppeteer from 'puppeteer';
import { BASE, PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';
import { overSeznam, odkazStrany } from './pomocnici/seznamy.js';

const SEZNAM = '/ucetnictvi/objednavky';

describe('seznam objednávek', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  const POCET = 61;
  const slug = `so-${r}`;
  const cislo = (i) => `8${String(parseInt(r.slice(0, 5), 36) % 100000).padStart(5, '0')}${String(i).padStart(3, '0')}`;
  let sql; let sid; let cookie; let req; let uzivatel; let shop; let toneracek; let dispatchId;
  const uklidObjednavky = [];
  // Shodný čas založení: pořadí mezi stranami drží jen id.
  const cas = new Date('2026-01-15T10:00:00Z');
  const ids = Array.from({ length: POCET }, (_, i) => `SO-${r}-${String(i).padStart(3, '0')}`);
  const token = (id) => `${SEZNAM}/${id}"`;
  const naStrance = (html, vyber = ids) => vyber.filter(id => html.includes(token(id)));
  const parametry = (odkaz) => Object.fromEntries(new URL(odkaz, 'http://x').searchParams);
  const nacti = async (adresa) => {
    const res = await req.get(adresa);
    assert.equal(res.status, 200, adresa);
    return res.text();
  };

  // Sklad: sudé odeslané, 1 zadržená, 3 a 5 čekají, zbytek do skladu nejde.
  const radek = (i, id, shopId) => ({
    id, shop_id: shopId, order_number: cislo(i), status: i % 2 ? 'Přijata' : 'Vyřízena',
    email: `so-${i}-${r}@example.invalid`, first_name: 'Test', last_name: `Zákazník ${r}`,
    payment_method: [1, 3, 5].includes(i) ? 'Dobírka' : 'Platba kartou',
    warehouse_hold_reason: i === 1 ? 'balik-nepodan' : '',
    warehouse_sent_at: i % 2 === 0 ? cas : null,
    total_price: 1234.5, created_at: cas, modified_at: cas,
  });

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`so-${r}@example.invalid`}, 'x', TRUE, TRUE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    cookie = prihlaseni.cookie;
    req = pozadavky(cookie);

    [shop] = await sql`
      INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address, warehouse_dispatch_since)
      VALUES (${slug}, ${`Seznam ${r}`}, 'https://example.invalid', TRUE, 'Seznam', 'noreply@example.invalid', '2000-01-01')
      RETURNING *`;
    await sql`INSERT INTO shop_orders ${sql(ids.map((id, i) => radek(i, id, shop.id)))}`;
    uklidObjednavky.push(...ids);
    await sql`INSERT INTO shop_order_items (order_id, sku, name, quantity, price) VALUES
      (${ids[0]}, 'A', 'První položka', 2, 100), (${ids[0]}, 'B', 'Druhá položka', 1, 200), (${ids[0]}, 'C', 'Třetí položka', 1, 300)`;
    [{ id: dispatchId }] = await sql`
      INSERT INTO warehouse_dispatches (shop_id, kind, run_date, status, recipient, order_count, held_count)
      VALUES (${shop.id}, 'rucni', '2026-01-15', 'odeslano', 'sklad@example.invalid', 4, 1) RETURNING id`;

    [toneracek] = await sql`SELECT * FROM shops WHERE slug = 'toneracek'`;
    assert.ok(toneracek, 'migrace 030 zakládá e-shop toneracek');
  });

  after(async () => {
    await sql`DELETE FROM shop_orders WHERE id = ANY(${uklidObjednavky})`;
    await sql`DELETE FROM shops WHERE id = ${shop.id}`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  const adresaEshopu = () => `${SEZNAM}?eshop=${slug}`;

  test('stránkování se shodným created_at: každá objednávka právě jednou, neplatné page nespadne', () => overSeznam({
    req, adresa: `${adresaEshopu()}&q=${r}`, tokeny: ids.map(token), filtr: { eshop: slug, q: r },
  }));

  test('řazení končí jednoznačným klíčem', () => {
    const routa = readFileSync(new URL('../src/routes/toneracek.js', import.meta.url), 'utf8');
    assert.match(routa, /ORDER BY x\.created_at DESC, x\.id DESC\s+LIMIT \$\{strany\.naStranku\} OFFSET \$\{strany\.offset\}/);
  });

  test('filtr podle stavu i skladu platí na další stránce a odkazy ho drží', async () => {
    const vyrizene = ids.filter((_, i) => i % 2 === 0);
    const html = await nacti(`${adresaEshopu()}&status=${encodeURIComponent('Vyřízena')}&page=2`);
    const radky = naStrance(html);
    assert.equal(radky.length, vyrizene.length - 25);
    assert.ok(radky.every(id => vyrizene.includes(id)));
    assert.deepEqual(parametry(odkazStrany(html, 'prev')), { eshop: slug, status: 'Vyřízena' });

    const odeslane = await nacti(`${adresaEshopu()}&sklad=odeslano&page=2`);
    assert.equal(naStrance(odeslane).length, vyrizene.length - 25);
    assert.deepEqual(parametry(odkazStrany(odeslane, 'prev')), { eshop: slug, sklad: 'odeslano' });
    assert.match(odeslane, /<option value="odeslano" selected>/);

    const vsechny = await nacti(`${adresaEshopu()}&q=${r}&status=${encodeURIComponent('Vyřízena')}&sklad=odeslano`);
    assert.deepEqual(parametry(odkazStrany(vsechny, 'next')), { eshop: slug, q: r, status: 'Vyřízena', sklad: 'odeslano', page: '2' });
  });

  test('filtr skladu: čeká a nešlo do skladu podle stavu expedice', async () => {
    const cekaji = await nacti(`${adresaEshopu()}&sklad=ceka`);
    assert.deepEqual(naStrance(cekaji).sort(), [ids[3], ids[5]].sort());
    assert.ok(cekaji.includes('2 objednávky odpovídají filtru'));
    const zadrzene = await nacti(`${adresaEshopu()}&sklad=blokovano`);
    assert.deepEqual(naStrance(zadrzene), [ids[1]]);
    assert.ok(zadrzene.includes('1 objednávka odpovídá filtru'));
  });

  test('neplatná hodnota skladu není filtr a do odkazů nejde', async () => {
    const html = await nacti(`${adresaEshopu()}&sklad=nesmysl`);
    assert.equal(naStrance(html).length, 25);
    assert.deepEqual(parametry(odkazStrany(html, 'next')), { eshop: slug, page: '2' });
    assert.ok(!html.includes('Zrušit filtr'));
    assert.ok(html.includes(`${POCET} objednávek celkem`));
  });

  test('error a expedice se nepřenášejí, hláška se ukáže jen tentokrát', async () => {
    const chyba = await nacti(`${adresaEshopu()}&q=${r}&error=expedice-bezi`);
    assert.ok(chyba.includes('Expedice právě běží'));
    assert.match(chyba, /class="hlaska hlaska-chyba"/);
    assert.deepEqual(parametry(odkazStrany(chyba, 'next')), { eshop: slug, q: r, page: '2' });

    const expedice = await nacti(`${adresaEshopu()}&q=${r}&expedice=${dispatchId}`);
    assert.ok(expedice.includes('Expedice odeslána'));
    assert.match(expedice, /class="hlaska hlaska-ok"/);
    assert.ok(expedice.includes(`href="${SEZNAM}?eshop=${slug}&amp;sklad=blokovano"`), 'odkaz na zadržené drží e-shop');
    assert.deepEqual(parametry(odkazStrany(expedice, 'next')), { eshop: slug, q: r, page: '2' });
    assert.ok(!/data-seznam="[^"]*(error|expedice)=/.test(chyba + expedice));
  });

  test('chipy zůstávají a zvolený je označený', async () => {
    const html = await nacti(`${adresaEshopu()}&status=${encodeURIComponent('Přijata')}`);
    assert.ok(html.includes(`href="${SEZNAM}?eshop=${slug}&amp;status=${encodeURIComponent('Přijata')}"`));
    assert.ok(html.includes(`href="${SEZNAM}?eshop=${slug}&amp;status=${encodeURIComponent('Vyřízena')}"`));
    assert.ok(html.includes(`href="${SEZNAM}?eshop=${slug}&amp;sklad=ceka"`));
    assert.ok(html.includes(`href="${SEZNAM}?eshop=${slug}&amp;sklad=blokovano"`));
    assert.match(html, new RegExp(`status=${encodeURIComponent('Přijata')}" class="badge-info"\\s+aria-current="true"`));
    assert.ok(html.indexOf(`status=${encodeURIComponent('Přijata')}"`) < html.indexOf(`status=${encodeURIComponent('Vyřízena')}"`), 'chipy jdou v pořadí stavů');
  });

  test('vzhled: Celkem vpravo a česky, stav přes tón, řádek jako skutečný odkaz', async () => {
    const html = await nacti(adresaEshopu());
    assert.match(html, /<th class="num">Celkem<\/th>/);
    assert.match(html, /<td class="num">1\s234,50 Kč<\/td>/u);
    assert.match(html, /<span class="badge badge-info">Přijata<\/span>/);
    assert.match(html, /<span class="badge badge-ok">Vyřízena<\/span>/);
    assert.match(html, new RegExp(`<a href="${SEZNAM}/SO-[^"]+" class="radek-odkaz">#\\d+</a>`));
    assert.match(html, new RegExp(`<tr data-href="${SEZNAM}/SO-`));
    assert.ok(!/<tr[^>]*onclick/.test(html));
    assert.ok(!html.includes('?page='), 'odkazy stran skládá jen patička');
    assert.ok(html.includes(`<input type="hidden" name="eshop" value="${slug}">`), 'filtr drží e-shop');
    const filtr = /<form method="get" class="filtr-lista">[\s\S]*?<\/form>/.exec(html)[0];
    assert.ok(!filtr.includes('name="page"'));
  });

  test('prázdný výsledek filtru: nabídne zrušení filtru, nemá patičku a drží e-shop', async () => {
    const html = await nacti(`${adresaEshopu()}&q=${r}-nic&page=3`);
    assert.ok(html.includes('Filtru neodpovídá žádná objednávka'));
    assert.ok(!html.includes('class="strankovani"'));
    assert.match(html, /<td colspan="8">/);
    assert.ok(html.includes(`<a href="${SEZNAM}?eshop=${slug}" class="btn btn-outline btn-sm">Zrušit filtr</a>`));
  });

  test('dvojité parametry ani NUL nespadnou, neznámý e-shop je 404', async () => {
    for (const dotaz of [`eshop=${slug}&q=${r}&q=jine`, `eshop=${slug}&status=a&status=b`, `eshop=${slug}&sklad=a&sklad=b`, `eshop=${slug}&eshop=jiny`, `eshop=${slug}&q=%00`]) {
      assert.equal((await req.get(`${SEZNAM}?${dotaz}`)).status, 200, dotaz);
    }
    assert.equal((await req.get(`${SEZNAM}?eshop=neexistuje-${r}`)).status, 404);
    assert.equal((await req.get(`${SEZNAM}?eshop=%00neexistuje-${r}`)).status, 404);
  });

  describe('Toneráček', () => {
    const POCET_T = 27;
    const idsT = Array.from({ length: POCET_T }, (_, i) => `SOT-${r}-${String(i).padStart(3, '0')}`);

    before(async () => {
      // Hluboko v minulosti, aby nevytlačily objednávky jiných testů z první stránky.
      const stary = new Date('2001-01-15T10:00:00Z');
      await sql`INSERT INTO shop_orders ${sql(idsT.map((id, i) => ({ ...radek(100 + i, id, toneracek.id), created_at: stary, warehouse_sent_at: null, payment_method: 'Platba kartou' })))}`;
      uklidObjednavky.push(...idsT);
    });

    test('odkazy stran jsou bez parametru eshop, i když ho adresa nese', async () => {
      for (const adresa of [`${SEZNAM}?q=${r}`, `${SEZNAM}?eshop=toneracek&q=${r}`]) {
        const html = await nacti(adresa);
        assert.equal(naStrance(html, idsT).length, 25);
        assert.deepEqual(parametry(odkazStrany(html, 'next')), { q: r, page: '2' }, adresa);
        assert.ok(html.includes(`data-seznam="${SEZNAM}?q=${r}"`));
        assert.ok(!html.includes('name="eshop"'), 'filtr Toneráčku bez skrytého e-shopu');
      }
      const druha = await nacti(`${SEZNAM}?q=${r}&page=2`);
      assert.equal(naStrance(druha, idsT).length, POCET_T - 25);
      assert.equal(odkazStrany(druha, 'prev'), `${SEZNAM}?q=${r}`);
    });

    test('chipy a Zrušit filtr Toneráčku jsou bez parametru eshop', async () => {
      const html = await nacti(`${SEZNAM}?q=${r}`);
      assert.ok(html.includes(`href="${SEZNAM}?status=`));
      assert.ok(html.includes(`<a href="${SEZNAM}" class="btn btn-ghost">Zrušit filtr</a>`));
    });
  });

  describe('detail', () => {
    test('odznak přes tón, návrat na seznam e-shopu, položky podle id, částky česky', async () => {
      // Přepsaný řádek se v tabulce přesune na konec, bez ORDER BY by první položka skončila poslední.
      const [prvni] = await sql`SELECT id FROM shop_order_items WHERE order_id = ${ids[0]} ORDER BY id LIMIT 1`;
      await sql`UPDATE shop_order_items SET quantity = 3 WHERE id = ${prvni.id}`;
      const html = await nacti(`${SEZNAM}/${ids[0]}`);
      assert.match(html, /<span class="badge badge-ok">Vyřízena<\/span>/);
      assert.ok(html.includes(`href="${SEZNAM}?eshop=${slug}" style="color:var(--text-muted);text-decoration:none;font-size:13px;" data-zpet>`));
      assert.ok(html.indexOf('První položka') < html.indexOf('Druhá položka') && html.indexOf('Druhá položka') < html.indexOf('Třetí položka'), 'položky v pořadí podle id');
      assert.match(html, /100,00 Kč/);
      assert.match(html, /300,00 Kč/);
      assert.match(html, /1\s234,50 Kč/u);
    });
  });

  describe('v prohlížeči', () => {
    let browser; let page;
    const jsChyby = [];
    const jdi = (cesta) => page.goto(BASE + cesta, { waitUntil: 'networkidle0' });
    const url = () => page.evaluate(() => location.pathname + location.search);
    const preteka = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

    before(async () => {
      browser = await puppeteer.launch({ headless: true });
      page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      await page.setCookie({ name: 'sessionId', value: cookie.slice('sessionId='.length), domain: new URL(BASE).hostname, path: '/' });
      page.on('pageerror', e => jsChyby.push(e.message));
    });

    after(async () => { await browser?.close(); });

    test('klik do řádku otevře detail a Zpět vede na tutéž stránku a filtr', async () => {
      const seznam = `${adresaEshopu()}&q=${r}&page=2`;
      await jdi(seznam);
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('tbody tr td:nth-child(2)')]);
      assert.match(await url(), new RegExp(`^${SEZNAM}/SO-`));
      assert.equal(await page.$eval('a[data-zpet]', a => a.getAttribute('href')), seznam);
    });

    test('telefon 390 px: seznam ani detail nepřetékají, tlačítko skladu se vejde do karty', async () => {
      await page.setViewport({ width: 390, height: 844 });
      await jdi(adresaEshopu());
      assert.equal(await preteka(), false, 'seznam');
      const viditelne = await page.$$eval('.data-table thead th', ths => ths.filter(th => getComputedStyle(th).display !== 'none').map(th => th.innerText.trim().toLowerCase()));
      for (const sloupec of ['číslo', 'zákazník', 'celkem', 'stav']) assert.ok(viditelne.includes(sloupec), sloupec);

      await jdi(`${SEZNAM}/${ids[3]}`);
      assert.equal(await preteka(), false, 'detail');
      const presah = await page.$$eval('.card', karty => karty.flatMap(k => {
        const hrana = k.getBoundingClientRect().right;
        return [...k.querySelectorAll('.btn, dd, table')].filter(el => el.getBoundingClientRect().right > hrana + 0.5).map(el => el.tagName + ' ' + el.innerText.slice(0, 40));
      }));
      assert.deepEqual(presah, [], 'nic nepřetéká přes okraj karty');
      const sloupce = await page.$eval('.obj-mrizka', el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      assert.equal(sloupce, 1, 'na telefonu jeden sloupec');
      await page.setViewport({ width: 1366, height: 900 });
      await jdi(`${SEZNAM}/${ids[3]}`);
      assert.equal(await page.$eval('.obj-mrizka', el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2, 'na počítači dva');
    });

    test('detail v užším okně s bočním menu: nic nepřeteče přes okraj karty', async () => {
      await sql`UPDATE shop_orders SET tracking_number = 'Z1234567890' WHERE id = ${ids[3]}`;
      for (const sirka of [920, 1001, 1100]) {
        await page.setViewport({ width: sirka, height: 800 });
        await jdi(`${SEZNAM}/${ids[3]}`);
        const presah = await page.$$eval('.card', karty => karty.flatMap(k => {
          const hrana = k.getBoundingClientRect().right;
          return [...k.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > hrana + 0.5).map(el => el.tagName + ' ' + el.innerText.slice(0, 40));
        }));
        assert.deepEqual(presah, [], `při ${sirka} px`);
        assert.equal(await preteka(), false, `dokument při ${sirka} px`);
      }
      await page.setViewport({ width: 1366, height: 900 });
    });

    test('celý průchod bez chyby JS', () => {
      assert.deepEqual(jsChyby, []);
    });
  });
});
