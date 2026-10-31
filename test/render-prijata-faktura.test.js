// Detail přijaté faktury (views/pages/invoices/received-detail.ejs) vykreslený
// bez serveru a databáze: formulář záznamu je naschvál prázdný a pole na kartách
// obou sloupců se k němu hlásí přes form= – mezi kartami leží formuláře příloh,
// párování a exportu, takže je obalit nejde (formulář ve formuláři). Serverová
// část (jen s DATABASE_URL) ověří GET v obou režimech a že POST uloží a vrátí
// na ?saved=1.
//
//   node --test test/render-prijata-faktura.test.js
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/render-prijata-faktura.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { vykresliStranku, zkontrolujDetail } from './pomocnici/render.js';
import { PRESKOCIT, lokalniDatabaze, serverBezi, prihlas, pozadavky } from './pomocnici/server.js';

// Stejné pole jako v src/routes/invoices.js – není exportované a routa tahá PDF, e-mail i Claude SDK.
const STATUSES_RECEIVED = ['Nezaplacena', 'Zaplacena', 'Po splatnosti', 'Storno'];
const FORMULAR = 'formFaktura';

// Řádek accounting_invoices, jak ho vrací postgres: DECIMAL jako řetězec, DATE jako Date.
const invoice = {
  id: 'inv_test_1', type: 'received', number: 'PF-2026-001', status: 'Nezaplacena',
  supplier: 'Papírnictví <b>Tužka</b>', supplier_ico: '12345678', supplier_dic: 'CZ12345678',
  supplier_address: 'Nádražní 1', supplier_city: 'Brno', supplier_zip: '602 00', supplier_country: 'Česká republika',
  amount: '1000.00', vat_amount: '210.00', total_amount: '1210.00', currency: 'CZK',
  issue_date: new Date('2026-02-02T00:00:00Z'), due_date: new Date('2026-02-16T00:00:00Z'), paid_date: null,
  notes: 'Kancelářské potřeby', account_debit: '518', account_credit: '321', vat_deductible: true,
  attachment_path: null, attachment_mime: null, attachment_size: null, attachment_missing: false,
  bank_transaction_id: null, pohoda_exported_at: null,
  created_at: new Date('2026-02-03T10:00:00Z'), modified_at: new Date('2026-02-03T10:00:00Z'),
};

function vykresli(prepis = {}) {
  return vykresliStranku('invoices/received-detail', {
    pageTitle: `Přijatá ${invoice.number}`, currentPath: '/ucetnictvi/prijate-faktury',
    invoice, bankTx: null, STATUSES_RECEIVED, saved: false, rezimUprav: false, ...prepis,
  });
}

// Sloupce z UPDATE v POST /ucetnictvi/prijate-faktury/:id/upravit (src/routes/invoices.js)
const SLOUPCE = ['number', 'supplier', 'supplier_ico', 'supplier_dic', 'supplier_address', 'supplier_city', 'supplier_zip', 'supplier_country',
  'amount', 'vat_amount', 'total_amount', 'currency', 'issue_date', 'due_date', 'notes', 'account_debit', 'account_credit', 'vat_deductible'];

test('tužka, formulář záznamu a všechny sloupce v obou režimech, bez vnořeného formuláře', async () => {
  const zobrazeni = await vykresli();
  zkontrolujDetail(zobrazeni, { formular: FORMULAR, sloupce: SLOUPCE, rezim: 'zobrazeni' });
  const upravy = await vykresli({ rezimUprav: true });
  zkontrolujDetail(upravy, { formular: FORMULAR, sloupce: SLOUPCE, rezim: 'upravy' });
});

test('formulář je prázdný hned za hlavičkou a každé pole se k němu hlásí přes form=', async () => {
  const html = await vykresli();
  assert.ok(html.includes(`<form method="post" action="/ucetnictvi/prijate-faktury/${invoice.id}/upravit" id="${FORMULAR}" class="upravitelne"></form>`), 'prázdný formulář záznamu');
  assert.ok(html.indexOf(`id="${FORMULAR}"`) < html.indexOf('<!-- Levý sloupec -->'), 'leží před mřížkou karet');
  for (const name of SLOUPCE) {
    assert.match(html, new RegExp(`<(?:input|select|textarea)\\b[^>]*name="${name}"[^>]*form="${FORMULAR}"`), `pole ${name} má form="${FORMULAR}"`);
  }
  assert.equal((html.match(new RegExp(`form="${FORMULAR}" class="btn btn-primary upravit-ulozit"`, 'g')) || []).length, 2, 'Uložit v hlavičce i v patičce míří přes form=');
  assert.ok(html.includes('class="upravit-paticka jen-upravy"'), 'patička Zrušit/Uložit pod levým sloupcem');
  // CSS přepíná každé .pole podle data-rezim obalu, pomocná třída na mřížce není potřeba.
  assert.ok(!html.includes('<div class="upravitelne" style="display:grid'), 'mřížka karet nenese pomocnou třídu upravitelne');

  // Ostatní formuláře (příloha, POHODA XML, stav) zůstávají vlastní a mimo dosah tužky.
  assert.ok(html.includes(`action="/ucetnictvi/prijate-faktury/${invoice.id}/priloha"`), 'formulář přílohy zůstal');
  assert.ok(html.includes('action="/ucetnictvi/prijate-faktury/pohoda-xml"'), 'export do POHODY zůstal');
  assert.ok(html.includes('id="modalStatus"'), 'modal změny stavu zůstal');
  assert.ok(!html.includes('modalEdit'), 'modal úprav je pryč');
  assert.equal((html.match(/data-modal-open="modalStatus"/g) || []).length, 2, 'Stav v hlavičce i v Akcích otevírá modal');
  assert.ok(!html.includes("document.querySelectorAll('[data-modal-open]')"), 'duplicitní obsluhu modalů dělá app.js');
  assert.ok(html.includes('window.prilohaSubmit = async function'), 'nahrání přílohy zůstalo');
});

test('hodnoty jako escapovaný text, odkazy tužky a Zrušit, Upravit fakturu v Akcích otevírá úpravy', async () => {
  const html = await vykresli({ invoice: { ...invoice, attachment_path: 'inv_recv_test.pdf', attachment_mime: 'application/pdf', attachment_size: 2048 } });
  assert.ok(html.includes('Papírnictví &lt;b&gt;Tužka&lt;/b&gt;'), 'dodavatel se escapuje');
  assert.ok(!html.includes('<b>Tužka</b>'), 'surové HTML z hodnoty v stránce není');
  assert.match(html, /<div class="pole-hodnota">2\. 2\. 2026<\/div>/, 'datum přijetí nezávisle na časovém pásmu');
  assert.match(html, /<div class="pole-hodnota pole-varovani">16\. 2\. 2026 ⚠<\/div>/, 'splatnost po termínu s varováním a varovnou barvou');
  assert.match(html, /<div class="pole-hodnota">Uplatněn<\/div>/, 'odpočet DPH jako text');
  assert.match(html, /<div class="pole-hodnota">CZK<\/div>/, 'měna jako popisek vybrané možnosti');
  assert.ok(html.includes('href="?upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"'), 'tužka bez JS otevře ?upravit=1');
  assert.ok(html.includes(`href="/ucetnictvi/prijate-faktury/${invoice.id}" class="btn btn-ghost upravit-zrusit"`), 'Zrušit vede na detail bez upravit');
  assert.match(html, /<a href="\?upravit=1" class="btn btn-outline jen-zobrazeni" data-upravit-otevrit[^>]*>✏️ Upravit fakturu<\/a>/, 'Upravit fakturu v Akcích je odkaz, který JS zachytí jako tužku');

  const hlavicka = html.slice(html.indexOf('<div class="page-header-akce">'), html.indexOf(`id="${FORMULAR}"`));
  assert.ok(hlavicka.includes('📄 Zobrazit přílohu') && hlavicka.includes('🔄 Stav'), 'dosavadní akce v hlavičce zůstaly');
  assert.ok(!hlavicka.includes('btn-sm'), 'akce v hlavičce mají plnou velikost jako tužka');
  assert.ok(!hlavicka.includes('✏️ Upravit</button>'), 'tlačítko modalu úprav je pryč');
});

test('rekapitulace zůstává v zobrazení, v úpravách ji nahradí vstupy částek; číslo faktury jen v úpravách', async () => {
  const html = await vykresli();
  const rekapitulace = html.slice(html.indexOf('<!-- Rekapitulace -->'), html.indexOf('<!-- Akce -->'));
  assert.ok(rekapitulace.includes('<div class="jen-zobrazeni">'), 'řádky rekapitulace jen v zobrazení');
  assert.match(rekapitulace, /K úhradě<\/span>\s*<span>1\s210,00 CZK<\/span>/, 'K úhradě s dosavadním formátem');
  assert.match(rekapitulace, /<div class="jen-upravy">\s*<div style="display:grid;gap:14px;">\s*<div class="form-group pole">/, 'vstupy částek v bloku jen-upravy bez inline display, aby ho CSS mohlo skrýt');
  assert.match(rekapitulace, /<input type="number" class="form-control" value="1000\.00" id="pole-amount" name="amount" form="formFaktura" max="9999999999\.99" step="0\.01">/, 'základ jako číselný vstup');
  assert.match(html, /<div class="form-group pole jen-upravy" style="grid-column:1\/-1">\s*<label class="form-label required" for="pole-number">Číslo faktury<\/label>/, 'číslo faktury je v zobrazení v nadpisu, pole jen v úpravách');
  assert.ok(html.includes('<h1>Přijatá faktura PF-2026-001</h1>'), 'nadpis s číslem zůstal');
});

test('bez nároku na odpočet: žlutý box jen v zobrazení; zaplaceno jen pro čtení; Uloženo se v úpravách skryje', async () => {
  const html = await vykresli({ invoice: { ...invoice, vat_deductible: false, paid_date: new Date('2026-02-20T00:00:00Z'), status: 'Zaplacena' }, saved: true });
  assert.match(html, /<div class="jen-zobrazeni" style="background:#fef3c7[^"]*">\s*<strong>Bez nároku na odpočet DPH\.<\/strong>/, 'žlutý box má jen-zobrazeni');
  assert.match(html, /<div class="pole-hodnota">Bez nároku<\/div>/, 'odpočet jako text');
  assert.match(html, /<input type="checkbox" value="on" id="pole-vat_deductible" name="vat_deductible" form="formFaktura">/, 'checkbox nezaškrtnutý, hodnota on jako v routě');
  assert.match(html, /<div class="form-group pole pole-stale">\s*<span class="form-label">Zaplaceno<\/span>\s*<div class="pole-hodnota pole-uspech">20\. 2\. 2026<\/div>/, 'zaplaceno zůstává vidět i v úpravách, není to pole formuláře');
  assert.ok(!/name="paid_date"/.test(html), 'paid_date formulář neposílá');
  assert.match(html, /<div data-hlaska class="jen-zobrazeni" style="background:#dcfce7[^"]*">✓ Uloženo<\/div>/, 'banner Uloženo jen pro zobrazení');
  assert.ok(!html.includes('⚠'), 'zaplacená faktura není po splatnosti');

  const bez = await vykresli({ invoice: { ...invoice, notes: '', account_debit: '', account_credit: '', supplier_dic: '' } });
  assert.ok(bez.includes('Účtování (předkontace)') && bez.includes('Poznámka / předmět plnění'), 'karty se vykreslí i prázdné, jinak nejde hodnotu poprvé vyplnit');
  assert.ok((bez.match(/<span class="pole-prazdne">–/g) || []).length >= 4, 'prázdná pole ukážou pomlčku');
});

// ── Proti běžícímu serveru a lokální databázi ──────────────────

describe('proti serveru', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(4).toString('hex');
  const id = `test-pf-${r}`;
  let sql, req, sid, userId;

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const [u] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`pf-${r}@example.invalid`}, 'x', 'Test', 'Správce', TRUE) RETURNING id`;
    userId = u.id;
    const prihlaseni = await prihlas(sql, userId);
    sid = prihlaseni.sid;
    req = pozadavky(prihlaseni.cookie);
    // accounting_invoices: jen id a type jsou bez výchozí hodnoty (migrations/001, 013).
    await sql`
      INSERT INTO accounting_invoices (id, type, number, supplier, supplier_ico, amount, vat_amount, total_amount, currency, issue_date, due_date, status)
      VALUES (${id}, 'received', ${`PF-${r}`}, ${`Dodavatel ${r}`}, '12345678', 1000, 210, 1210, 'CZK', '2026-02-02', '2026-02-16', 'Nezaplacena')`;
  });

  after(async () => {
    if (!sql) return;
    await sql`DELETE FROM accounting_invoices WHERE id = ${id}`;
    if (sid) await sql`DELETE FROM session WHERE sid = ${sid}`;
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.end();
  });

  test('GET detail: zobrazení, ?upravit=1 otevře úpravy i bez JavaScriptu', async () => {
    const res = await req.get(`/ucetnictvi/prijate-faktury/${id}`);
    assert.equal(res.status, 200);
    let html = await res.text();
    assert.ok(html.includes('data-rezim="zobrazeni"'), 'výchozí je zobrazení');
    assert.ok(html.includes(`id="${FORMULAR}" class="upravitelne"></form>`), 'prázdný formulář záznamu');
    assert.ok(html.includes('href="?upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"'), 'tužka vede bez JS na ?upravit=1');
    assert.ok(html.includes(`form="${FORMULAR}" class="btn btn-primary upravit-ulozit"`), 'Uložit míří na formulář záznamu');
    assert.ok(html.includes(`<div class="pole-hodnota">Dodavatel ${r}</div>`), 'dodavatel jako text pole');
    assert.ok(!/<form\b[^>]*>(?:(?!<\/form>)[\s\S])*<form\b/.test(html), 'žádný vnořený formulář ani s layoutem');

    html = await (await req.get(`/ucetnictvi/prijate-faktury/${id}?upravit=1`)).text();
    assert.ok(html.includes('data-rezim="upravy"'), '?upravit=1 otevře úpravy');
    assert.ok(!html.includes('data-rezim="zobrazeni"'));
  });

  test('POST upravit uloží dodavatele a vrátí na ?saved=1 bez upravit', async () => {
    const telo = {
      number: `PF-${r}`, supplier: `Nový dodavatel ${r}`, supplier_ico: '87654321', supplier_dic: 'CZ87654321',
      supplier_address: 'Nádražní 1', supplier_city: 'Brno', supplier_zip: '602 00', supplier_country: 'Česká republika',
      amount: '1000', vat_amount: '210', total_amount: '1210', currency: 'CZK', issue_date: '2026-02-02', due_date: '2026-02-16',
      notes: 'Kancelářské potřeby', account_debit: '518', account_credit: '321', vat_deductible: 'on',
    };
    const res = await req.post(`/ucetnictvi/prijate-faktury/${id}/upravit`, telo);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/ucetnictvi/prijate-faktury/${id}?saved=1`, 'úspěch vrací do zobrazení bez upravit');
    const [po] = await sql`SELECT supplier, supplier_ico, notes, account_debit, vat_deductible FROM accounting_invoices WHERE id = ${id}`;
    assert.equal(po.supplier, `Nový dodavatel ${r}`);
    assert.deepEqual([po.supplier_ico, po.notes, po.account_debit, po.vat_deductible], ['87654321', 'Kancelářské potřeby', '518', true]);

    const html = await (await req.get(`/ucetnictvi/prijate-faktury/${id}?saved=1`)).text();
    assert.ok(html.includes('data-rezim="zobrazeni"'), 'po uložení je zpět zobrazení');
    assert.match(html, /<div data-hlaska class="jen-zobrazeni" style="background:#dcfce7[^"]*">✓ Uloženo<\/div>/, 'hláška Uloženo nad zobrazením');
    assert.ok(html.includes(`<div class="pole-hodnota">Nový dodavatel ${r}</div>`), 'nový dodavatel jako text pole');
  });

  test('duplicitní číslo a neplatné datum: návrat do otevřeného formuláře s hláškou, řádek beze změny', async () => {
    const druha = `tpf2${r}`;
    await sql`INSERT INTO accounting_invoices (id, type, number, supplier, amount, vat_amount, total_amount, currency, issue_date, status)
      VALUES (${druha}, 'received', ${`PF2-${r}`}, 'Jiný', 1, 0, 1, 'CZK', '2026-02-02', 'Nezaplacena')`;
    try {
      const [pred] = await sql`SELECT number, notes, issue_date::text AS d FROM accounting_invoices WHERE id = ${id}`;
      let res = await req.post(`/ucetnictvi/prijate-faktury/${id}/upravit`, { number: `PF2-${r}`, supplier: 'X', issue_date: '2026-02-02', notes: 'jiné' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), `/ucetnictvi/prijate-faktury/${id}?error=duplicita&upravit=1`);
      for (const zmena of [{ issue_date: '' }, { issue_date: '20266-02-02' }, { issue_date: '2026-02-02', due_date: '2026-02-30' }]) {
        res = await req.post(`/ucetnictvi/prijate-faktury/${id}/upravit`, { number: `PF-${r}`, supplier: 'X', notes: 'jiné', ...zmena });
        assert.equal(res.headers.get('location'), `/ucetnictvi/prijate-faktury/${id}?error=datum&upravit=1`, JSON.stringify(zmena));
      }
      const [po] = await sql`SELECT number, notes, issue_date::text AS d FROM accounting_invoices WHERE id = ${id}`;
      assert.deepEqual(po, pred);
      const html = await (await req.get(`/ucetnictvi/prijate-faktury/${id}?error=duplicita&upravit=1`)).text();
      assert.ok(html.includes('data-rezim="upravy"') && html.includes('s tímto číslem už v systému je'));
      assert.ok(!(await (await req.get(`/ucetnictvi/prijate-faktury/${id}?error=vymysleno`)).text()).includes('<div data-hlaska style="background:var(--danger-bg)'), 'neznámý kód hlášku neukáže');
    } finally {
      await sql`DELETE FROM accounting_invoices WHERE id = ${druha}`;
    }
  });
});
