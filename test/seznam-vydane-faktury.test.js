// Seznam vydaných a zálohových faktur: stránkování obou záložek, počty v odznacích,
// filtry v odkazech, hromadný výběr jen u vydaných, detail a jeho modaly v prohlížeči.
//
//   node --test test/seznam-vydane-faktury.test.js        (jen šablona bez serveru)
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/seznam-vydane-faktury.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import puppeteer from 'puppeteer';
import { BASE, PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';
import { overSeznam, odkazStrany } from './pomocnici/seznamy.js';
import { vykresliStranku } from './pomocnici/render.js';
import { filtrDokladu } from '../src/filtr-dokladu.js';
import { strankovani } from '../src/strankovani.js';

const SEZNAM = '/ucetnictvi/vydane-faktury';
const detail = (id) => `${SEZNAM}/${id}`;
const STATUSES_ISSUED = ['Nezaplacena', 'Zaplacena', 'Po splatnosti', 'Storno'];

describe('šablona seznamu bez serveru', () => {
  const vykresli = (prepis = {}) => {
    const typ = prepis.typ ?? 'vydane';
    return vykresliStranku('invoices/issued', {
      invoices: [], total: 0, typ, filtr: filtrDokladu({ q: prepis.q }), klienti: [], statusFilter: '', STATUSES_ISSUED, series: [], formError: '',
      strany: strankovani({ cesta: SEZNAM, query: {}, celkem: 0 }),
      zalozky: [{ klic: 'vydane', popisek: 'Vydané', pocet: 0 }, { klic: 'zalohove', popisek: 'Zálohové', pocet: 0 }],
      adresaZalozky: (k) => (k === 'vydane' ? SEZNAM : `${SEZNAM}?typ=${k}`),
      ...prepis,
    });
  };
  const colspan = (html) => Number(/<td colspan="(\d+)">/.exec(html)[1]);
  const sloupcu = (html) => html.slice(html.indexOf('<thead>'), html.indexOf('</thead>')).match(/<th\b/g).length;

  test('prázdný seznam vydaných: text, colspan podle sloupců, tlačítka a modal', async () => {
    const html = await vykresli();
    assert.ok(html.includes('Zatím žádné vydané faktury'));
    assert.equal(colspan(html), sloupcu(html));
    assert.equal(sloupcu(html), 11);
    assert.ok(html.includes('id="modalCreate"'));
    assert.ok(html.includes('id="bulkBar"'));
    assert.ok(!html.includes('class="strankovani"'), 'prázdný seznam nemá patičku');
  });

  test('prázdné zálohové: vlastní text, bez výběru, exportu a modalu', async () => {
    const html = await vykresli({ typ: 'zalohove' });
    assert.ok(html.includes('Zatím žádné zálohové faktury'));
    assert.equal(colspan(html), sloupcu(html));
    assert.equal(sloupcu(html), 10);
    for (const nesmi of ['bulkBar', 'bulk-cb', 'bulkSelectAll', 'pohoda-xml', 'export.csv', 'modalCreate', 'acList']) {
      assert.ok(!html.includes(nesmi), nesmi);
    }
  });

  test('prázdný výsledek filtru nabídne Zrušit filtr a drží záložku', async () => {
    const vydane = await vykresli({ q: 'nic' });
    assert.ok(vydane.includes('Filtru neodpovídá žádná faktura'));
    assert.ok(vydane.includes(`<a href="${SEZNAM}" class="btn btn-outline btn-sm">Zrušit filtr</a>`));
    const zalohove = await vykresli({ typ: 'zalohove', statusFilter: 'Storno' });
    assert.ok(zalohove.includes(`<a href="${SEZNAM}?typ=zalohove" class="btn btn-outline btn-sm">Zrušit filtr</a>`));
    assert.ok(zalohove.includes(`<a href="${SEZNAM}?typ=zalohove" class="btn btn-ghost">Zrušit filtr</a>`));
  });

  test('český tvar v podtitulku', async () => {
    const titulek = async (total, prepis = {}) => /<p>([^<]*)<\/p>/.exec(await vykresli({ total, ...prepis }))[1].replace(/\s/g, ' ');
    assert.equal(await titulek(1), '1 faktura celkem');
    assert.equal(await titulek(3), '3 faktury celkem');
    assert.equal(await titulek(1234), '1 234 faktur celkem');
    assert.equal(await titulek(1, { q: 'x' }), '1 faktura odpovídá filtru');
    assert.equal(await titulek(2, { q: 'x' }), '2 faktury odpovídají filtru');
    assert.equal(await titulek(118, { q: 'x' }), '118 faktur odpovídá filtru');
    assert.equal(await titulek(1, { typ: 'zalohove' }), '1 zálohová faktura celkem');
    assert.equal(await titulek(4, { typ: 'zalohove' }), '4 zálohové faktury celkem');
    assert.equal(await titulek(5, { typ: 'zalohove', statusFilter: 'Storno' }), '5 zálohových faktur odpovídá filtru');
  });

  test('útočný text ve filtru se escapuje', async () => {
    const q = '"><img src=x onerror=alert(1)>';
    const html = await vykresli({ q });
    assert.ok(!html.includes('<img src=x'));
  });
});

describe('seznam vydaných a zálohových faktur', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  // Dvě vydané navíc mají společné číslo pro filtr s výsledkem 2.
  const POCET_VYDANYCH = 63;
  const POCET_ZALOHOVYCH = 61;
  let sql; let sid; let req; let uzivatel; let cookie;
  const vydane = []; const zalohove = [];

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`sv-${r}@example.invalid`}, 'x', TRUE, TRUE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    cookie = prihlaseni.cookie;
    req = pozadavky(cookie);
    // Shodné datum i čas založení: pořadí mezi stranami drží jen poslední klíč.
    // Bez splatnosti, jinak by je worker přepnul na Po splatnosti.
    const cas = new Date('2026-01-15T10:00:00Z');
    const radek = (prefix, type, i, cislo) => ({
      id: `${prefix}-${r}-${String(i).padStart(3, '0')}`, type, number: cislo, client_name: `Klient ${r}`,
      status: i % 2 ? 'Zaplacena' : 'Nezaplacena', issue_date: '2026-01-15',
      amount: 100, vat_amount: 21, total_amount: 121, currency: 'CZK', created_at: cas, modified_at: cas,
    });
    const radkyVydane = Array.from({ length: POCET_VYDANYCH }, (_, i) => radek('sv', 'issued', i, i < 2 ? `SV${r}dve${i}` : `SV${r}${i}`));
    const radkyZalohove = Array.from({ length: POCET_ZALOHOVYCH }, (_, i) => radek('sz', 'proforma', i, `ZF${r}${i}`));
    vydane.push(...radkyVydane.map(x => x.id));
    zalohove.push(...radkyZalohove.map(x => x.id));
    await sql`INSERT INTO accounting_invoices ${sql([...radkyVydane, ...radkyZalohove])}`;
  });

  after(async () => {
    await sql`DELETE FROM accounting_invoices WHERE id = ANY(${[...vydane, ...zalohove]})`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  const html = async (adresa) => {
    const res = await req.get(adresa);
    assert.equal(res.status, 200, adresa);
    return res.text();
  };
  const naStrance = (stranka, ids) => ids.filter(id => stranka.includes(detail(id)));
  const pocetZalozky = (stranka, popisek) => new RegExp(`${popisek} <span class="tab-pocet">([^<]*)</span>`).exec(stranka)?.[1];

  test('vydané: každý řádek právě jednou při shodném klíči řazení, neplatné page nespadne', () => overSeznam({
    req, adresa: `${SEZNAM}?q=${r}`, tokeny: vydane.map(detail), filtr: { q: r },
  }));

  test('zálohové: každý řádek právě jednou, odkazy drží typ a filtr', () => overSeznam({
    req, adresa: `${SEZNAM}?typ=zalohove&q=${r}`, tokeny: zalohove.map(detail), filtr: { typ: 'zalohove', q: r },
  }));

  test('záložky neukazují doklady té druhé', async () => {
    const proVydane = await html(`${SEZNAM}?q=${r}&velikost=100`);
    assert.equal(naStrance(proVydane, zalohove).length, 0);
    assert.equal(naStrance(proVydane, vydane).length, POCET_VYDANYCH);
    const proZalohove = await html(`${SEZNAM}?typ=zalohove&q=${r}&velikost=100`);
    assert.equal(naStrance(proZalohove, vydane).length, 0);
    assert.equal(naStrance(proZalohove, zalohove).length, POCET_ZALOHOVYCH);
  });

  test('odznaky mají počty celého filtru z SQL, ne z načtené stránky', async () => {
    for (const adresa of [`${SEZNAM}?q=${r}`, `${SEZNAM}?typ=zalohove&q=${r}`, `${SEZNAM}?q=${r}&page=3`]) {
      const stranka = await html(adresa);
      assert.equal(pocetZalozky(stranka, 'Vydané'), String(POCET_VYDANYCH), adresa);
      assert.equal(pocetZalozky(stranka, 'Zálohové'), String(POCET_ZALOHOVYCH), adresa);
    }
    const zaplacene = await html(`${SEZNAM}?q=${r}&status=Zaplacena`);
    assert.equal(pocetZalozky(zaplacene, 'Vydané'), String(Math.floor(POCET_VYDANYCH / 2)));
    assert.equal(pocetZalozky(zaplacene, 'Zálohové'), String(Math.floor(POCET_ZALOHOVYCH / 2)));
  });

  test('bez filtru jsou v odznacích celkové počty', async () => {
    const [{ v, z }] = await sql`SELECT COUNT(*) FILTER (WHERE type = 'issued')::int AS v, COUNT(*) FILTER (WHERE type = 'proforma')::int AS z FROM accounting_invoices`;
    const stranka = await html(SEZNAM);
    assert.equal(pocetZalozky(stranka, 'Vydané'), v.toLocaleString('cs-CZ'));
    assert.equal(pocetZalozky(stranka, 'Zálohové'), z.toLocaleString('cs-CZ'));
  });

  test('otevřená záložka je aktivní a přechod na druhou drží filtr', async () => {
    const stranka = await html(`${SEZNAM}?q=${r}&status=Zaplacena&page=2`);
    assert.match(stranka, /class="tab active" aria-current="page">Vydané/);
    assert.ok(stranka.includes(`href="${SEZNAM}?typ=zalohove&amp;q=${r}&amp;status=Zaplacena" class="tab"`));
    const druha = await html(`${SEZNAM}?typ=zalohove&q=${r}&status=Zaplacena`);
    assert.match(druha, /class="tab active" aria-current="page">Zálohové/);
    assert.ok(druha.includes(`href="${SEZNAM}?q=${r}&amp;status=Zaplacena" class="tab"`));
  });

  test('neznámý nebo dvojitý typ je záložka Vydané a odkazy ho nenesou', async () => {
    for (const dotaz of ['typ=nesmysl', 'typ=zalohove&typ=vydane', 'typ=__proto__']) {
      const stranka = await html(`${SEZNAM}?q=${r}&${dotaz}`);
      assert.match(stranka, /class="tab active" aria-current="page">Vydané/, dotaz);
      assert.equal(naStrance(stranka, vydane).length, 25, dotaz);
      assert.ok(!odkazStrany(stranka, 'next').includes('typ='), dotaz);
    }
  });

  test('filtr podle stavu platí na další stránce obou záložek', async () => {
    for (const [dotaz, ids] of [[`q=${r}`, vydane], [`typ=zalohove&q=${r}`, zalohove]]) {
      const zaplacene = ids.filter((_, i) => i % 2);
      assert.ok(zaplacene.length > 25);
      const stranka = await html(`${SEZNAM}?${dotaz}&status=Zaplacena&page=2`);
      const radky = naStrance(stranka, ids);
      assert.equal(radky.length, zaplacene.length - 25);
      assert.ok(radky.every(id => zaplacene.includes(id)));
      assert.ok(new URL(odkazStrany(stranka, 'prev'), 'http://x').searchParams.get('status') === 'Zaplacena');
    }
  });

  test('podtitulek odliší filtr a český tvar sedí na výsledek', async () => {
    assert.ok((await html(`${SEZNAM}?q=${r}dve`)).includes('2 faktury odpovídají filtru'));
    assert.ok((await html(`${SEZNAM}?q=${r}`)).includes(`${POCET_VYDANYCH} faktur odpovídá filtru`));
    assert.ok((await html(`${SEZNAM}?typ=zalohove&q=${r}`)).includes(`${POCET_ZALOHOVYCH} zálohových faktur odpovídá filtru`));
    assert.match(await html(SEZNAM), /\d faktur(a|y)? celkem/);
  });

  test('Zrušit filtr drží záložku, formulář filtru nese typ a nemá page', async () => {
    const proZalohove = await html(`${SEZNAM}?typ=zalohove&q=${r}`);
    assert.ok(proZalohove.includes(`<a href="${SEZNAM}?typ=zalohove" class="btn btn-ghost">Zrušit filtr</a>`));
    assert.ok(proZalohove.includes('<input type="hidden" name="typ" value="zalohove">'));
    const proVydane = await html(`${SEZNAM}?q=${r}`);
    assert.ok(proVydane.includes(`<a href="${SEZNAM}" class="btn btn-ghost">Zrušit filtr</a>`));
    assert.ok(!proVydane.includes('name="typ"'));
    const filtr = /<form method="get" class="filtr-lista">[^]*?<\/form>/.exec(proVydane)[0];
    assert.ok(!filtr.includes('name="page"'));
    assert.ok(!(await html(SEZNAM)).includes('Zrušit filtr'));
  });

  test('formError se nepřenáší a otevře modal jen na vydaných', async () => {
    const stranka = await html(`${SEZNAM}?q=${r}&formError=klient&page=2`);
    assert.ok(stranka.includes('Vyplňte klienta.'));
    assert.ok(stranka.includes("getElementById('modalCreate').classList.add('open')"));
    for (const rel of ['next', 'prev']) assert.ok(!odkazStrany(stranka, rel).includes('formError'), rel);
    assert.ok(!/data-seznam="[^"]*formError/.test(stranka));

    const proZalohove = await html(`${SEZNAM}?typ=zalohove&q=${r}&formError=klient`);
    assert.ok(!proZalohove.includes('Vyplňte klienta.'));
    assert.ok(!proZalohove.includes('modalCreate'));

    const nesmysl = await html(`${SEZNAM}?q=${r}&formError=constructor`);
    assert.ok(!nesmysl.includes('native code'), 'text chyby nejde z adresy ani z prototypu');
    assert.ok(!nesmysl.includes("classList.add('open')"));
  });

  test('neplatné založení faktury vrátí na seznam s otevřeným modalem', async () => {
    const res = await req.post(`${SEZNAM}/vytvorit`, { client_name: '' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${SEZNAM}?formError=klient`);
  });

  test('hromadný výběr: lišta na vydaných říká rozsah, na zálohových není', async () => {
    const stranka = await html(`${SEZNAM}?q=${r}&page=2`);
    assert.ok(stranka.includes('id="bulkBar" class="hromadna-lista"'));
    assert.ok(stranka.includes('Výběr platí jen pro tuto stránku (2 z 3).'));
    assert.ok(stranka.includes('title="Vybrat všechny na této stránce"'));
    assert.ok(stranka.includes(`action="${SEZNAM}/pohoda-xml"`));
    assert.ok(stranka.includes(`${SEZNAM}/export.csv`));
    assert.equal((stranka.match(/class="bulk-cb"/g) || []).length, 25);

    const proZalohove = await html(`${SEZNAM}?typ=zalohove&q=${r}`);
    for (const nesmi of ['bulkBar', 'bulk-cb', 'bulkSelectAll', 'pohoda-xml', 'export.csv', 'modalCreate']) {
      assert.ok(!proZalohove.includes(nesmi), nesmi);
    }
  });

  test('export do POHODY zálohovou fakturu nevezme ani při ručním POST', async () => {
    const res = await req.post(`${SEZNAM}/pohoda-xml`, { ids: zalohove[0] });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Není co exportovat/);
    const [radek] = await sql`SELECT pohoda_exported_at FROM accounting_invoices WHERE id = ${zalohove[0]}`;
    assert.equal(radek.pohoda_exported_at, null);
  });

  test('CSV je úplný seznam vydaných bez zálohových', async () => {
    const csv = await (await req.get(`${SEZNAM}/export.csv`)).text();
    assert.equal(csv.split(`SV${r}`).length - 1, POCET_VYDANYCH);
    assert.ok(!csv.includes(`ZF${r}`));
  });

  test('řádek je odkaz, stav má tón, žádná obsluha na řádku', async () => {
    const stranka = await html(`${SEZNAM}?q=${r}`);
    assert.match(stranka, new RegExp(`<tr data-href="${SEZNAM}/sv-${r}-`));
    assert.match(stranka, new RegExp(`<a href="${SEZNAM}/sv-${r}-[^"]+" class="radek-odkaz">`));
    assert.ok(stranka.includes('class="badge badge-ok">Zaplacena'));
    assert.ok(stranka.includes('class="badge badge-varovani">Nezaplacena'));
    assert.ok(!stranka.includes('clickable-row'));
    assert.ok(!stranka.includes('stopPropagation'));
    assert.ok(!stranka.includes('onclick="window.location'));
    assert.ok(!/\?page=\d/.test(stranka.replace(/href="[^"]*"/g, '')), 'žádný ruční pager mimo odkazy patičky');
  });

  test('útočný text ve filtru: v odkazech záložek a stran se escapuje a zůstane stejný', async () => {
    const q = `"><img src=x onerror=alert(1)>&x=1${r}`;
    const stranka = await html(`${SEZNAM}?typ=zalohove&q=${encodeURIComponent(q)}`);
    assert.ok(!stranka.includes('<img src=x'));
    const odkaz = /href="([^"]*)" class="tab"/.exec(stranka)[1].replace(/&amp;/g, '&');
    assert.equal(new URL(odkaz, 'http://x').searchParams.get('q'), q);
  });

  test('dvojité parametry a shoda bez výsledku nespadnou', async () => {
    assert.equal((await req.get(`${SEZNAM}?q=${r}&q=jine&status=a&status=b`)).status, 200);
    const prazdne = await html(`${SEZNAM}?typ=zalohove&q=${r}-nic&page=3`);
    assert.ok(prazdne.includes('Filtru neodpovídá žádná faktura'));
    assert.ok(!prazdne.includes('class="strankovani"'));
  });

  describe('detail', () => {
    test('vydaná: odkaz zpět se stavem seznamu, tón stavu bez barev v atributu', async () => {
      const stranka = await html(detail(vydane[1]));
      assert.ok(stranka.includes(`<a href="${SEZNAM}" class="btn btn-ghost btn-sm" data-zpet>`));
      assert.ok(stranka.includes('class="badge badge-ok" style="font-size:13px;"'));
      assert.ok(!stranka.includes('background:#dcfce7'));
      assert.match(stranka, /<h1>Faktura SV/);
    });

    test('zálohová: stejný detail, odkaz zpět na záložku Zálohové', async () => {
      const stranka = await html(detail(zalohove[1]));
      assert.ok(stranka.includes(`<a href="${SEZNAM}?typ=zalohove" class="btn btn-ghost btn-sm" data-zpet>`));
      assert.match(stranka, /<h1>Zálohová faktura ZF/);
      assert.ok(!stranka.includes('name="taxable_date"'), 'zálohová faktura nemá DUZP');
    });

    test('přijatá: odznak přes tón', async () => {
      const id = `sp-${r}`;
      await sql`INSERT INTO accounting_invoices (id, type, number, supplier, status, issue_date, amount, vat_amount, total_amount, currency)
        VALUES (${id}, 'received', ${`SP${r}`}, 'Dodavatel', 'Storno', '2026-01-15', 1, 0, 1, 'CZK')`;
      try {
        const stranka = await html(`/ucetnictvi/prijate-faktury/${id}`);
        assert.ok(stranka.includes('class="badge badge-neutral" style="font-size:13px;">Storno'));
        assert.ok(stranka.includes('data-zpet'));
      } finally {
        await sql`DELETE FROM accounting_invoices WHERE id = ${id}`;
      }
    });

    test('historie odeslání: do deseti bez poznámky, nad deset poctivý počet', async () => {
      const id = vydane[2];
      const zapis = (n) => sql`INSERT INTO invoice_emails ${sql(Array.from({ length: n }, (_, i) => ({
        invoice_id: id, kind: 'faktura', email: `h${i}@example.invalid`, subject: 'x', status: 'odeslano',
      })))}`;
      await zapis(3);
      let stranka = await html(detail(id));
      assert.ok(stranka.includes('Historie odeslání'));
      assert.ok(!stranka.includes('Posledních'));
      await zapis(9);
      stranka = await html(detail(id));
      assert.ok(stranka.includes('Posledních 10 z 12'));
      assert.equal((stranka.match(/h\d+@example\.invalid/g) || []).length, 10);
      await sql`DELETE FROM invoice_emails WHERE invoice_id = ${id}`;
    });
  });

  describe('modaly v prohlížeči', () => {
    let browser; let page; const jsChyby = [];

    before(async () => {
      browser = await puppeteer.launch({ headless: true });
      page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 640 });
      page.on('pageerror', e => jsChyby.push(e.message));
      await page.setCookie({ name: 'sessionId', value: cookie.slice('sessionId='.length), domain: new URL(BASE).hostname, path: '/' });
    });
    after(() => browser.close());

    // Modal mizí přechodem, čeká se na konec, ať další klik netrefí překryv.
    const pockej = (id, stav) => page.waitForFunction((id, stav) => {
      const s = getComputedStyle(document.getElementById(id));
      return s.visibility === stav && (stav === 'hidden' || s.opacity === '1');
    }, { timeout: 3000 }, id, stav);
    const scrollPotom = () => page.evaluate(() => {
      window.scrollTo(0, 0);
      window.scrollBy(0, 150);
      const y = window.scrollY;
      window.scrollTo(0, 0);
      return { y, zamek: document.body.style.overflow };
    });

    async function overZavirani(adresa, id, otevrit) {
      await page.goto(BASE + adresa, { waitUntil: 'networkidle0' });
      const zaviraci = {
        křížkem: () => page.click(`#${id} .modal-close`),
        Zrušit: () => page.click(`#${id} .modal-footer .btn-ghost`),
        'klikem mimo': () => page.mouse.click(4, 636),
        Esc: () => page.keyboard.press('Escape'),
      };
      for (const [jak, zavri] of Object.entries(zaviraci)) {
        await page.click(otevrit);
        await pockej(id, 'visible');
        assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden', `${id}: tělo se zamkne`);
        // Patička s Uložit musí jít dosáhnout i u formuláře delšího než okno.
        const patka = await page.$eval(`#${id} button[type=submit]`, el => el.getBoundingClientRect().bottom <= window.innerHeight);
        assert.equal(patka, true, `${id}: tlačítko v patičce je v okně`);
        await zavri();
        await pockej(id, 'hidden').catch(() => assert.fail(`${id} se nezavřel ${jak}`));
        const { y, zamek } = await scrollPotom();
        assert.equal(zamek, '', `${id} po zavření ${jak}: tělo není zamčené`);
        assert.ok(y > 0, `${id} po zavření ${jak}: stránka jde scrollovat`);
      }
    }

    test('Nová faktura na seznamu', () => overZavirani(`${SEZNAM}?q=${r}`, 'modalCreate', '[data-modal-open="modalCreate"]'));

    test('Stav, Odeslat, Upravit a Upomínka na detailu', async () => {
      const id = vydane[3];
      await sql`INSERT INTO invoice_emails ${sql(Array.from({ length: 10 }, (_, i) => ({
        invoice_id: id, kind: 'faktura', email: `m${i}@example.invalid`, subject: 'x', status: 'odeslano',
      })))}`;
      await sql`UPDATE accounting_invoices SET status = 'Po splatnosti' WHERE id = ${id}`;
      try {
        const adresa = detail(id);
        await overZavirani(adresa, 'modalStatus', '.page-header-akce [data-modal-open="modalStatus"]');
        await overZavirani(adresa, 'modalEmail', '.page-header-akce [data-modal-open="modalEmail"]');
        await overZavirani(adresa, 'modalEdit', '[data-modal-open="modalEdit"]');
        await overZavirani(adresa, 'modalUpominka', '[data-modal-open="modalUpominka"]');
      } finally {
        await sql`DELETE FROM invoice_emails WHERE invoice_id = ${id}`;
        await sql`UPDATE accounting_invoices SET status = 'Zaplacena' WHERE id = ${id}`;
      }
    });

    test('modal otevřený chybou ze serveru: hláška je vidět, po zavření jde stránka scrollovat', async () => {
      for (const [adresa, id] of [[`${SEZNAM}?q=${r}&formError=klient`, 'modalCreate'], [`${detail(vydane[3])}?formError=klient`, 'modalEdit']]) {
        await page.goto(BASE + adresa, { waitUntil: 'networkidle0' });
        await pockej(id, 'visible');
        assert.equal(await page.$eval(`#${id} .hlaska-chyba`, el => el.textContent), 'Vyplňte klienta.');
        await page.click(`#${id} .modal-close`);
        await pockej(id, 'hidden');
        const { y, zamek } = await scrollPotom();
        assert.equal(zamek, '', id);
        assert.ok(y > 0, id);
      }
    });

    test('hromadná lišta sedí se zaškrtnutím a výběr drží počet', async () => {
      await page.goto(`${BASE}${SEZNAM}?q=${r}`, { waitUntil: 'networkidle0' });
      const lista = () => page.$eval('#bulkBar', el => getComputedStyle(el).display);
      assert.equal(await lista(), 'none');
      await page.click('#bulkSelectAll');
      assert.notEqual(await lista(), 'none');
      assert.equal(await page.$eval('#bulkCount', el => el.textContent), '25 vybráno');
      assert.equal(await page.$$eval('#bulkInputs input', els => els.length), 25);
      // Klik do buňky s checkboxem nesmí otevřít detail.
      assert.ok((await page.url()).includes(SEZNAM));
      await page.click('[onclick="bulkClearAll()"]');
      assert.equal(await lista(), 'none');
    });

    test('po návratu tlačítkem Zpět lišta sedí se zaškrtnutím, které prohlížeč vrátil', async () => {
      // Vlastní panel: po návratu z bfcache Puppeteer na téže stránce nečeká navigaci spolehlivě.
      const panel = await browser.newPage();
      panel.on('pageerror', e => jsChyby.push(e.message));
      await panel.setViewport({ width: 1366, height: 800 });
      try {
        await panel.goto(`${BASE}${SEZNAM}?q=${r}`, { waitUntil: 'networkidle0' });
        const boxy = await panel.$$('.bulk-cb');
        await boxy[0].click();
        await boxy[1].click();
        await Promise.all([panel.waitForNavigation({ waitUntil: 'networkidle0' }), panel.click('tbody tr .radek-odkaz')]);
        await panel.goBack({ waitUntil: 'networkidle0' });
        const { zaskrtnuto, popisek, zobrazena } = await panel.evaluate(() => ({
          zaskrtnuto: document.querySelectorAll('.bulk-cb:checked').length,
          popisek: document.getElementById('bulkCount').textContent,
          zobrazena: getComputedStyle(document.getElementById('bulkBar')).display !== 'none',
        }));
        assert.equal(zobrazena, zaskrtnuto > 0);
        if (zaskrtnuto) assert.equal(popisek, `${zaskrtnuto} vybráno`);
      } finally {
        await panel.close();
      }
    });

    test('klik do řádku otevře detail', async () => {
      await page.goto(`${BASE}${SEZNAM}?typ=zalohove&q=${r}`, { waitUntil: 'networkidle0' });
      const [navigace] = await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.click('tbody tr td:nth-child(2)'),
      ]);
      assert.equal(navigace.status(), 200);
      assert.match(page.url(), new RegExp(`${SEZNAM}/sz-${r}-`));
    });

    test('Zpět z detailu vede na stránku a filtr seznamu', async () => {
      const adresa = `${SEZNAM}?typ=zalohove&q=${r}&page=2`;
      await page.goto(BASE + adresa, { waitUntil: 'networkidle0' });
      await page.goto(BASE + detail(zalohove[0]), { waitUntil: 'networkidle0' });
      assert.equal(await page.$eval('a[data-zpet]', a => a.getAttribute('href')), adresa);
    });

    test('bez chyb JavaScriptu', () => {
      assert.deepEqual(jsChyby, []);
    });
  });
});
