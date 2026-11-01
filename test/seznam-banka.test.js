// Seznam banky a karty po splatnosti na finančním přehledu proti běžícímu serveru
// a lokální databázi. Banka stránkuje po 50, ovládání dřív chybělo a starší pohyby
// nebyly vidět; akce v řádku vracely na začátek seznamu bez filtru.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test --test-concurrency=1 test/seznam-banka.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import puppeteer from 'puppeteer';
import { BASE, PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';
import { overSeznam, odkazStrany } from './pomocnici/seznamy.js';

const SEZNAM = '/ucetnictvi/banka';

describe('seznam banky a přehled po splatnosti', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  const POCET = 121;
  let sql; let sid; let cookie; let req; let uzivatel; let ucetId; let ucetZalozen = false; let txIds = [];
  const zpravy = Array.from({ length: POCET }, (_, i) => `BT${r}-${String(i).padStart(3, '0')}`);
  const fakturaId = `sb-${r}-f`;
  let uctenkaId;

  const nacti = async (adresa) => {
    const res = await req.get(adresa);
    assert.equal(res.status, 200, adresa);
    return res.text();
  };

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`sb-${r}@example.invalid`}, 'x', TRUE, TRUE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    cookie = prihlaseni.cookie;
    req = pozadavky(cookie);

    // Účet stejným dotazem jako routa, jinak by řádky v seznamu nebyly.
    let [ucet] = await sql`SELECT id FROM accounting_bank_accounts WHERE active = TRUE ORDER BY id LIMIT 1`;
    if (!ucet) {
      [ucet] = await sql`INSERT INTO accounting_bank_accounts (name) VALUES (${`Test ${r}`}) RETURNING id`;
      ucetZalozen = true;
    }
    ucetId = ucet.id;

    // Shodné datum: pořadí mezi stranami drží jen id.
    const radky = zpravy.map((message, i) => ({
      bank_account_id: ucetId, type: i % 2 ? 'debit' : 'credit', amount: 100 + i, currency: 'CZK',
      message, counterparty_name: `Protistrana ${r}`, variable_symbol: i === 7 ? `77${r}` : '', transaction_date: '2026-01-15',
    }));
    txIds = (await sql`INSERT INTO accounting_bank_transactions ${sql(radky)} RETURNING id`).map(x => x.id);

    await sql`INSERT INTO accounting_invoices ${sql({
      id: fakturaId, type: 'issued', number: `SB${r}`, status: 'Nezaplacena', client_name: `Klient ${r}`,
      issue_date: '2026-01-15', amount: 100, vat_amount: 0, total_amount: 100, currency: 'CZK',
    })}`;
    [{ id: uctenkaId }] = await sql`INSERT INTO receipts (vendor, receipt_date) VALUES (${`Párování ${r}`}, '2026-01-15') RETURNING id`;
  });

  after(async () => {
    await sql`DELETE FROM accounting_bank_transactions WHERE message LIKE ${`%${r}%`}`;
    await sql`DELETE FROM accounting_invoices WHERE id = ${fakturaId}`;
    await sql`DELETE FROM receipts WHERE id = ${uctenkaId}`;
    if (ucetZalozen) await sql`DELETE FROM accounting_bank_accounts WHERE id = ${ucetId}`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  // Řádky jdou od nejvyššího id: strana 1 je i=120…71, strana 2 i=70…21, strana 3 i=20…0.
  const NA_DRUHE = 50;

  describe('banka', () => {
    test('121 řádků po 50 se shodným datem: každý právě jednou, neplatné page nespadne', () => overSeznam({
      req, adresa: `${SEZNAM}?q=${r}`, tokeny: zpravy, naStranku: 50, filtr: { q: r },
    }));

    test('filtr podle typu platí i na další stránce a odkazy ho drží', async () => {
      const prijmy = zpravy.filter((_, i) => i % 2 === 0);
      const html = await nacti(`${SEZNAM}?q=${r}&type=credit&page=2`);
      const radky = zpravy.filter(z => html.includes(z));
      assert.equal(radky.length, prijmy.length - 50);
      assert.ok(radky.every(z => prijmy.includes(z)));
      const predchozi = new URL(odkazStrany(html, 'prev'), 'http://x').searchParams;
      assert.equal(predchozi.get('q'), r);
      assert.equal(predchozi.get('type'), 'credit');
      assert.match(html, /<option value="credit" selected>/);
    });

    test('hledání najde i variabilní symbol a protistranu', async () => {
      const podleVs = await nacti(`${SEZNAM}?q=77${r}`);
      assert.deepEqual(zpravy.filter(z => podleVs.includes(z)), [zpravy[7]]);
      assert.ok(podleVs.includes('1 transakce odpovídá filtru'));
      const podleProtistrany = await nacti(`${SEZNAM}?q=${encodeURIComponent(`Protistrana ${r}`)}`);
      assert.ok(podleProtistrany.includes(`${POCET} transakcí odpovídá filtru`));
    });

    test('velikost stránky: 25 se drží v odkazech, výchozích 50 odkaz nenese', async () => {
      const html = await nacti(`${SEZNAM}?q=${r}&velikost=25`);
      assert.equal(zpravy.filter(z => html.includes(z)).length, 25);
      assert.ok(html.includes('velikost=25&amp;page=2'));
      assert.ok(html.includes(`href="${SEZNAM}?q=${r}"`), 'volba 50 je výchozí stav bez parametru');
    });

    test('zrušení párování v řádku vrací na tutéž stránku a filtr', async () => {
      const id = txIds[NA_DRUHE];
      await sql`UPDATE accounting_bank_transactions SET matched_invoice_id = ${fakturaId} WHERE id = ${id}`;
      const adresa = `${SEZNAM}?q=${r}&type=credit&page=2`;
      const html = await nacti(`${SEZNAM}?q=${r}&page=2`);
      const formular = new RegExp(`action="${SEZNAM}/${id}/zrusit-parovani"[^>]*>\\s*<input type="hidden" name="redirect_to" value="([^"]+)"`).exec(html);
      assert.ok(formular, 'spárovaný řádek má formulář s návratem');
      assert.equal(formular[1].replace(/&amp;/g, '&'), `${SEZNAM}?q=${r}&page=2`);

      const res = await req.post(`${SEZNAM}/${id}/zrusit-parovani`, { redirect_to: adresa });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), adresa);
      const [tx] = await sql`SELECT matched_invoice_id FROM accounting_bank_transactions WHERE id = ${id}`;
      assert.equal(tx.matched_invoice_id, null);
    });

    test('spárování s fakturou a s účtenkou vrací na tutéž stránku a filtr', async () => {
      const id = txIds[NA_DRUHE];
      const adresa = `${SEZNAM}?q=${r}&page=2`;
      const html = await nacti(adresa);
      assert.ok(html.includes(`data-navrat="${SEZNAM}?q=${r}&amp;page=2"`), 'modal párování zná návrat');

      let res = await req.post(`${SEZNAM}/${id}/parovat`, { document_type: 'invoice', document_id: fakturaId, redirect_to: adresa });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), adresa);
      const [faktura] = await sql`SELECT status FROM accounting_invoices WHERE id = ${fakturaId}`;
      assert.equal(faktura.status, 'Zaplacena');

      res = await req.post(`${SEZNAM}/${id}/parovat`, { document_type: 'receipt', document_id: String(uctenkaId), redirect_to: adresa });
      assert.equal(res.headers.get('location'), adresa);
      const [tx] = await sql`SELECT matched_receipt_id FROM accounting_bank_transactions WHERE id = ${id}`;
      assert.equal(tx.matched_receipt_id, uctenkaId);

      // Bez dokladu nic nezapíše a vrátí tamtéž.
      res = await req.post(`${SEZNAM}/${id}/parovat`, { redirect_to: adresa });
      assert.equal(res.headers.get('location'), adresa);
      await req.post(`${SEZNAM}/${id}/zrusit-parovani`, {});
    });

    test('nová transakce vede na první stránku téhož filtru, kde nový řádek je', async () => {
      const html = await nacti(`${SEZNAM}?q=${r}&type=credit&page=2`);
      const navrat = /action="\/ucetnictvi\/banka\/vytvorit">[\s\S]*?name="redirect_to" value="([^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
      assert.equal(navrat, `${SEZNAM}?q=${r}&type=credit`);

      const res = await req.post(`${SEZNAM}/vytvorit`, { description: `Nová ${r}`, type: 'credit', amount: '5', date: '2030-01-01', redirect_to: navrat });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), navrat);
      assert.ok((await nacti(navrat)).includes(`Nová ${r}`), 'nový řádek je na stránce, kam se člověk vrátil');
      await sql`DELETE FROM accounting_bank_transactions WHERE message = ${`Nová ${r}`}`;
    });

    test('cizí návratová adresa se nepoužije, bez adresy zpět na seznam', async () => {
      const id = txIds[0];
      for (const cil of ['https://evil.example/x', '//evil.example/x', '/\\evil.example']) {
        assert.equal((await req.post(`${SEZNAM}/${id}/zrusit-parovani`, { redirect_to: cil })).headers.get('location'), SEZNAM, cil);
        assert.equal((await req.post(`${SEZNAM}/${id}/parovat`, { redirect_to: cil })).headers.get('location'), SEZNAM, cil);
        assert.equal((await req.post(`${SEZNAM}/vytvorit`, { description: `Cizí ${r}`, amount: '1', date: '2000-01-01', redirect_to: cil })).headers.get('location'), SEZNAM, cil);
      }
      assert.equal((await req.post(`${SEZNAM}/${id}/zrusit-parovani`, {})).headers.get('location'), SEZNAM);
      await sql`DELETE FROM accounting_bank_transactions WHERE message = ${`Cizí ${r}`}`;
    });

    test('prázdný výsledek filtru: nabídne zrušení filtru a nemá patičku', async () => {
      const html = await nacti(`${SEZNAM}?q=${r}-nic&page=3`);
      assert.ok(html.includes('Filtru neodpovídá žádná transakce'));
      assert.ok(!html.includes('class="strankovani"'));
      assert.match(html, /<td colspan="7">/);
    });

    test('dvojitý parametr ani NUL nespadnou, formulář filtru nemá page', async () => {
      for (const dotaz of [`q=${r}&q=jine`, 'type=credit&type=debit', 'q=%00']) {
        assert.equal((await req.get(`${SEZNAM}?${dotaz}`)).status, 200, dotaz);
      }
      const filtr = /<form method="get" class="filtr-lista">[\s\S]*?<\/form>/.exec(await nacti(`${SEZNAM}?q=${r}&page=2`))[0];
      assert.ok(!filtr.includes('name="page"'));
    });

    test('jednorázový parametr parovat se do odkazů nepřenáší', async () => {
      const html = await nacti(`${SEZNAM}?q=${r}&parovat=abc`);
      assert.ok(!html.includes('parovat=abc'));
    });

    test('záložky modalu párování nemají cyan jako barvu textu a výběr účtu je jednoznačný', () => {
      const sablona = readFileSync(new URL('../views/pages/accounting/bank.ejs', import.meta.url), 'utf8');
      assert.match(sablona, /\.bank-tab\.active \{ color: var\(--text-primary\); border-bottom-color: var\(--primary\); \}/);
      const routa = readFileSync(new URL('../src/routes/accounting.js', import.meta.url), 'utf8');
      assert.equal((routa.match(/accounting_bank_accounts WHERE active = TRUE ORDER BY id LIMIT 1/g) || []).length, 3);
      assert.ok(!/WHERE active = TRUE LIMIT 1/.test(routa));
    });
  });

  describe('banka v prohlížeči', () => {
    let browser; let page;
    const jsChyby = [];
    const jdi = (cesta) => page.goto(BASE + cesta, { waitUntil: 'networkidle0' });
    const url = () => page.evaluate(() => location.pathname + location.search);

    before(async () => {
      browser = await puppeteer.launch({ headless: true });
      page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      await page.setCookie({ name: 'sessionId', value: cookie.slice('sessionId='.length), domain: new URL(BASE).hostname, path: '/' });
      page.on('pageerror', e => jsChyby.push(e.message));
    });

    after(async () => { await browser?.close(); });

    test('Nová transakce otevře modal', async () => {
      await jdi(`${SEZNAM}?q=${r}`);
      await page.click('[data-modal-open="modalCreateTransaction"]');
      await new Promise(res => setTimeout(res, 150));
      assert.ok(await page.$('#modalCreateTransaction.open'));
    });

    test('potvrzení párování z modalu vrátí na tutéž stránku a filtr', async () => {
      const adresa = `${SEZNAM}?q=${r}&page=2`;
      const id = txIds[NA_DRUHE];
      await jdi(adresa);
      // Tlačítko Spárovat dnes končí na openModal (banka se nestahuje, docs/todo-rezim-uprav.md), tady jde jen o návrat.
      await page.evaluate((tx) => { try { window.bankPairOpen(tx); } catch {} }, id);
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.evaluate((d) => window.bankPairConfirm(d), fakturaId)]);
      assert.equal(await url(), adresa);
      const [tx] = await sql`SELECT matched_invoice_id FROM accounting_bank_transactions WHERE id = ${id}`;
      assert.equal(tx.matched_invoice_id, fakturaId);
      await req.post(`${SEZNAM}/${id}/zrusit-parovani`, {});
    });

    test('stránka nepřetéká na telefonu ani v užším okně s bočním menu', async () => {
      for (const [sirka, vyska] of [[390, 844], [820, 800], [1024, 800]]) {
        await page.setViewport({ width: sirka, height: vyska });
        for (const adresa of [`${SEZNAM}?q=${r}`, `${SEZNAM}?q=${r}-nic`]) {
          await jdi(adresa);
          const { dokument, okno } = await page.evaluate(() => ({ dokument: document.documentElement.scrollWidth, okno: window.innerWidth }));
          assert.ok(dokument <= okno, `${adresa} při ${sirka} px: dokument ${dokument} px`);
        }
      }
      await page.setViewport({ width: 390, height: 844 });
      await jdi(`${SEZNAM}?q=${r}`);
      const viditelne = await page.$$eval('.data-table thead th', ths => ths.filter(th => getComputedStyle(th).display !== 'none').map(th => th.innerText.trim().toLowerCase()));
      assert.deepEqual(viditelne, ['popis', 'částka', 'datum']);
      await page.setViewport({ width: 1366, height: 900 });
    });

    test('celý průchod bez chyby JS', () => {
      assert.deepEqual(jsChyby, []);
    });
  });

  describe('finanční přehled: po splatnosti', () => {
    const PREHLED = '/ucetnictvi/prehled';
    const vydane = Array.from({ length: 12 }, (_, i) => ({
      id: `sb-${r}-v${String(i).padStart(2, '0')}`, type: 'issued', number: `SBV${r}${i}`, status: 'Po splatnosti', client_name: `Klient ${r} ${i}`,
      issue_date: '2000-01-01', due_date: `2000-02-${String(i + 1).padStart(2, '0')}`, amount: 10, vat_amount: 0, total_amount: 10, currency: 'CZK',
    }));
    const prijate = Array.from({ length: 3 }, (_, i) => ({
      id: `sb-${r}-p${i}`, type: 'received', number: `SBP${r}${i}`, status: 'Po splatnosti', supplier: `Dodavatel ${r} ${i}`,
      issue_date: '2000-01-01', due_date: '2000-03-01', amount: 10, vat_amount: 0, total_amount: 10, currency: 'CZK',
    }));
    let pocetVydanych; let pocetPrijatych;

    before(async () => {
      await sql`INSERT INTO accounting_invoices ${sql([...vydane])}`;
      await sql`INSERT INTO accounting_invoices ${sql([...prijate])}`;
      [{ n: pocetVydanych }] = await sql`SELECT COUNT(*)::int AS n FROM accounting_invoices WHERE type = 'issued' AND status = 'Po splatnosti'`;
      [{ n: pocetPrijatych }] = await sql`SELECT COUNT(*)::int AS n FROM accounting_invoices WHERE type = 'received' AND status = 'Po splatnosti'`;
    });

    after(async () => {
      await sql`DELETE FROM accounting_invoices WHERE id = ANY(${[...vydane, ...prijate].map(x => x.id)})`;
    });

    test('ukáže 10 nejstarších, počet z COUNT a odkaz na celý seznam', async () => {
      const html = await nacti(PREHLED);
      const naPrehledu = vydane.filter(f => html.includes(`/ucetnictvi/vydane-faktury/${f.id}"`));
      assert.deepEqual(naPrehledu.map(f => f.id), vydane.slice(0, 10).map(f => f.id), 'nejstarších deset podle splatnosti, v tomto pořadí');
      assert.ok(html.includes(`Pohledávky po splatnosti (${pocetVydanych})`));
      assert.ok(html.includes(`<a href="/ucetnictvi/vydane-faktury?status=Po%20splatnosti"`));
      assert.ok(html.includes(`Zobrazit všechny (${pocetVydanych})`));
    });

    test('závazky do deseti se vypíšou všechny a odkaz není potřeba', async () => {
      const html = await nacti(PREHLED);
      assert.ok(prijate.every(f => html.includes(`/ucetnictvi/prijate-faktury/${f.id}"`)));
      assert.ok(html.includes(`Závazky po splatnosti (${pocetPrijatych})`));
      if (pocetPrijatych <= 10) assert.ok(!html.includes('/ucetnictvi/prijate-faktury?status=Po%20splatnosti'));
    });

    test('závazky nad deset dostanou odkaz na přijaté faktury', async () => {
      const navic = Array.from({ length: 11 }, (_, i) => ({ ...prijate[0], id: `sb-${r}-pn${i}`, number: `SBPN${r}${i}` }));
      await sql`INSERT INTO accounting_invoices ${sql(navic)}`;
      try {
        const html = await nacti(PREHLED);
        assert.ok(html.includes(`<a href="/ucetnictvi/prijate-faktury?status=Po%20splatnosti"`));
        assert.ok(html.includes(`Zobrazit všechny (${pocetPrijatych + 11})`));
      } finally {
        await sql`DELETE FROM accounting_invoices WHERE id = ANY(${navic.map(x => x.id)})`;
      }
    });

    test('odkaz vede na filtr, který seznam faktur umí', async () => {
      const html = await nacti(`/ucetnictvi/vydane-faktury?status=Po%20splatnosti&q=${r}`);
      assert.ok(vydane.every(f => html.includes(`/ucetnictvi/vydane-faktury/${f.id}`)));
    });

    test('řádek má skutečný odkaz, řazení končí jednoznačným klíčem', async () => {
      const html = await nacti(PREHLED);
      assert.ok(!/<tr[^>]*onclick/.test(html));
      assert.match(html, new RegExp(`<a href="/ucetnictvi/vydane-faktury/${vydane[0].id}" class="radek-odkaz">`));
      const routa = readFileSync(new URL('../src/routes/accounting.js', import.meta.url), 'utf8');
      assert.equal((routa.match(/status='Po splatnosti' ORDER BY due_date, id LIMIT/g) || []).length, 2);
    });
  });
});
