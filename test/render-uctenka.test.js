// Detail účtenky (views/pages/receipts/detail.ejs) vykreslený bez serveru a
// databáze: režim úprav na jediném formuláři záznamu, každý sloupec, který
// POST /ucetnictvi/uctenky/:id/upravit zapisuje, má ve formuláři pole, a
// skript stránky (rdUhrada — zámek odpočtu DPH u reprezentace) visí na polích
// přes id, ne přes inline onchange. Druhá část jede proti běžícímu serveru
// a lokální databázi (bez DATABASE_URL se přeskočí).
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/render-uctenka.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { vykresliStranku, zkontrolujDetail } from './pomocnici/render.js';
import { BASE, PRESKOCIT, lokalniDatabaze, serverBezi, prihlas, pozadavky } from './pomocnici/server.js';
import { STATUSES, CATEGORIES, NO_VAT_CATEGORIES } from '../src/routes/receipts.js';
import { PAYMENT_METHODS } from '../src/pohoda.js';

const receipt = {
  id: 42, number: 'U-0042', vendor: 'Papírnictví <b>Kudrna</b>', vendor_ico: '12345678',
  amount: '100.00', vat_amount: '21.00', total_amount: '121.00', currency: 'CZK',
  receipt_date: new Date('2026-02-02T00:00:00Z'), category: 'Kancelář', status: 'Nezaúčtována',
  payment_method: 'Karta', vat_deductible: true, notes: 'Toner <b>a papír</b>',
  account_debit: '518', account_credit: '211',
  attachment_path: null, attachment_mime: null, attachment_size: null, attachment_missing: false,
  created_at: new Date('2026-02-02T10:00:00Z'), updated_at: new Date('2026-02-02T10:00:00Z'),
};

// Stejné locals, jaké předává GET /ucetnictvi/uctenky/:id (src/routes/receipts.js)
function vykresli(prepis = {}) {
  return vykresliStranku('receipts/detail', {
    pageTitle: 'Účtenka U-0042', currentPath: '/ucetnictvi/uctenky', receipt,
    STATUSES, CATEGORIES, PAYMENT_METHODS, NO_VAT_CATEGORIES,
    saved: false, error: null, rezimUprav: false, ...prepis,
  });
}

// Sloupce z UPDATE v POST /ucetnictvi/uctenky/:id/upravit
const SLOUPCE = ['number', 'vendor', 'vendor_ico', 'amount', 'vat_amount', 'total_amount', 'currency', 'receipt_date',
  'category', 'status', 'payment_method', 'vat_deductible', 'notes', 'account_debit', 'account_credit'];

test('tužka, formulář záznamu a všechny sloupce v obou režimech', async () => {
  zkontrolujDetail(await vykresli(), { formular: 'formUctenka', sloupce: SLOUPCE, rezim: 'zobrazeni' });
  zkontrolujDetail(await vykresli({ rezimUprav: true }), { formular: 'formUctenka', sloupce: SLOUPCE, rezim: 'upravy' });
});

test('hodnoty jako text: escapované, částky s měnou, datum, odpočet DPH; odkazy tužky a Zrušit', async () => {
  const html = await vykresli();
  assert.ok(html.includes('Papírnictví &lt;b&gt;Kudrna&lt;/b&gt;'), 'dodavatel se escapuje');
  assert.ok(!html.includes('<b>Kudrna'), 'surové HTML z hodnoty se nevykreslí');
  assert.match(html, /<div class="pole-hodnota">121,00 CZK<\/div>/, 'částka s měnou v dosavadním formátu');
  assert.match(html, /<div class="pole-hodnota">2\. 2\. 2026<\/div>/, 'datum dokladu česky, nezávisle na časovém pásmu');
  assert.match(html, /<input type="date" class="form-control" value="2026-02-02" id="pole-receipt_date" name="receipt_date">/, 'vstup data dostane YYYY-MM-DD');
  assert.match(html, /<div class="pole-hodnota">Uplatněn odpočet<\/div>/, 'odpočet DPH jako text');
  assert.ok(html.includes('id="rdVatDeductible" name="vat_deductible" checked'), 'uplatněný odpočet je zaškrtnutý');
  assert.match(html, /<option value="Karta" selected>Karta<\/option>/, 'forma úhrady vybraná');
  assert.ok(html.includes('href="?upravit=1"'), 'tužka bez JS otevře úpravy');
  assert.ok(html.includes('href="/ucetnictvi/uctenky/42" class="btn btn-ghost upravit-zrusit"'), 'Zrušit vede na čistou adresu detailu');

  const bez = await vykresli({ receipt: { ...receipt, vat_deductible: false }, saved: true });
  assert.match(bez, /<div class="pole-hodnota">Bez odpočtu DPH<\/div>/, 'bez odpočtu jako text');
  assert.ok(!/id="rdVatDeductible"[^>]*checked/.test(bez), 'checkbox bez odpočtu není zaškrtnutý');
  assert.match(bez, /<div class="jen-zobrazeni"[^>]*>✓ Uloženo<\/div>/, 'banner Uloženo je jen pro režim zobrazení');
});

test('skript stránky: pole mají id pro rdUhrada, žádný inline onchange, hinty a přepočet po reset', async () => {
  const html = await vykresli();
  for (const id of ['rdCategory', 'rdPayment', 'rdVatDeductible']) assert.ok(html.includes(`id="${id}"`), `${id} je v HTML`);
  assert.ok(!html.includes('onchange="rdUhrada'), 'selecty nemají inline onchange — posluchače věší skript dole');
  assert.ok(html.includes('<small id="rdAgendaHint" class="form-hint jen-upravy"></small>'), 'hint agendy jen v úpravách');
  assert.ok(html.includes('<small id="rdVatHint" class="form-hint jen-upravy"></small>'), 'hint odpočtu jen v úpravách');
  assert.ok(html.includes("document.getElementById('formUctenka').addEventListener('reset'"), 'po Zrušit (form.reset) se zámek odpočtu přepočítá');
  assert.ok(html.includes('<datalist id="rdAcList"></datalist>'), 'našeptávač předkontací zůstal');
  assert.match(html, /name="account_debit"[^>]*autocomplete="off"[^>]*list="rdAcList"/, 'předkontace MD s našeptávačem');
  assert.ok(!html.includes('Zpět na seznam'), 'stará patička je pryč');
});

test('chyba z routy se vypíše escapovaně nad otevřenými poli', async () => {
  const html = await vykresli({ error: 'Soubor <script>', rezimUprav: true });
  assert.ok(html.includes('⚠ Soubor &lt;script&gt;'), 'zpráva escapovaná');
  assert.match(html, /data-rezim="upravy"/);
});

// ── Proti serveru ───────────────────────────────────────────────

describe('proti serveru', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(4).toString('hex');
  let sql;
  const ctx = {};

  // Detail posílá urlencoded formulář s Accept: text/html — pozadavky().post ho nenastavuje.
  const postHtml = (cesta, telo, hlavicky = {}) => fetch(BASE + cesta, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: ctx.cookie, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded', ...hlavicky },
    body: telo,
  });

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const [u] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`uctenka-${r}@example.invalid`}, 'x', 'Test', 'Správce', TRUE) RETURNING id`;
    ctx.userId = u.id;
    const { sid, cookie } = await prihlas(sql, u.id);
    ctx.sid = sid; ctx.cookie = cookie; ctx.req = pozadavky(cookie);
    const [uct] = await sql`
      INSERT INTO receipts (vendor, amount, vat_amount, total_amount, currency, receipt_date, category, status)
      VALUES (${`Dodavatel ${r}`}, 100, 21, 121, 'CZK', '2026-02-02', 'Kancelář', 'Nezaúčtována') RETURNING id`;
    ctx.id = uct.id;
  });

  after(async () => {
    if (!sql) return;
    if (ctx.id)     await sql`DELETE FROM receipts WHERE id = ${ctx.id}`;
    if (ctx.sid)    await sql`DELETE FROM session WHERE sid = ${ctx.sid}`;
    if (ctx.userId) await sql`DELETE FROM users WHERE id = ${ctx.userId}`;
    await sql.end();
  });

  test('detail v zobrazení, s ?upravit=1 v úpravách', async () => {
    const res = await ctx.req.get(`/ucetnictvi/uctenky/${ctx.id}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /data-rezim="zobrazeni"/);
    assert.ok(html.includes(`Dodavatel ${r}`));
    assert.ok(html.includes('id="formUctenka"'));
    const upravy = await ctx.req.get(`/ucetnictvi/uctenky/${ctx.id}?upravit=1`);
    assert.equal(upravy.status, 200);
    assert.match(await upravy.text(), /data-rezim="upravy"/);
  });

  test('POST upravit uloží dodavatele a přesměruje na ?saved=1 bez upravit', async () => {
    const res = await postHtml(`/ucetnictvi/uctenky/${ctx.id}/upravit`, new URLSearchParams({
      number: 'U-1', receipt_date: '2026-02-03', vendor: `Nový dodavatel ${r}`, vendor_ico: '12345678',
      amount: '200', vat_amount: '42', total_amount: '242', currency: 'CZK', category: 'Kancelář', status: 'Nezaúčtována',
      payment_method: 'Karta', vat_deductible: 'on', notes: 'test', account_debit: '518', account_credit: '211',
    }));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/ucetnictvi/uctenky/${ctx.id}?saved=1`);
    const [u] = await sql`SELECT vendor, payment_method, vat_deductible, total_amount FROM receipts WHERE id = ${ctx.id}`;
    assert.equal(u.vendor, `Nový dodavatel ${r}`);
    assert.equal(u.payment_method, 'Karta');
    assert.equal(u.vat_deductible, true);
    assert.equal(Number(u.total_amount), 242);
  });
});
