// Nastavení firmy (views/pages/settings/company.ejs) vykreslené bez serveru
// a databáze: jeden formulář přes pět karet v režimu úprav, tužka v hlavičce
// a každý sloupec, který POST /nastaveni/firma zapisuje, má ve formuláři
// pole. Serverová část jede proti běžícímu serveru a lokální databázi –
// company_settings je jednořádková a sdílená, po POSTu se řádek obnoví.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/render-nastaveni-firmy.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { vykresliStranku, zkontrolujDetail } from './pomocnici/render.js';
import { PRESKOCIT, lokalniDatabaze, serverBezi, prihlas, pozadavky } from './pomocnici/server.js';

const FORMULAR = 'formNastaveniFirmy';

// Sloupce z UPDATE company_settings v src/routes/settings.js
const SLOUPCE = [
  'name', 'ico', 'dic', 'address', 'city', 'zip', 'country', 'phone', 'email',
  'bank_account', 'bank_name', 'iban', 'swift', 'vat_payer', 'invoice_note',
  'pohoda_cash_account', 'pohoda_predkontace', 'pohoda_predkontace_prijate', 'pohoda_predkontace_repre',
  'gdrive_root_folder_id',
];

const company = {
  id: 1, name: 'SEIL <b>s.r.o.</b>', ico: '04245610', dic: 'CZ04245610', address: 'Nádražní 1', city: 'Brno', zip: '602 00',
  country: 'Česká republika', phone: '+420 777 123 456', email: 'info@example.invalid',
  bank_account: '2800828200/2010', bank_name: 'Fio banka', iban: '', swift: '',
  vat_payer: true, invoice_note: '', pohoda_cash_account: '', pohoda_predkontace: '3Vd',
  pohoda_predkontace_prijate: '', pohoda_predkontace_repre: '', gdrive_root_folder_id: '',
};

function vykresli(prepis = {}) {
  return vykresliStranku('settings/company', {
    pageTitle: 'Nastavení firmy', currentPath: '/nastaveni/firma', company, saved: false, rezimUprav: false, ...prepis,
  });
}

test('jeden formulář přes pět karet: tužka, všechny sloupce a režim podle ?upravit=1', async () => {
  const zobrazeni = await vykresli();
  zkontrolujDetail(zobrazeni, { formular: FORMULAR, sloupce: SLOUPCE, rezim: 'zobrazeni' });
  const upravy = await vykresli({ rezimUprav: true });
  zkontrolujDetail(upravy, { formular: FORMULAR, sloupce: SLOUPCE, rezim: 'upravy' });
  assert.equal((zobrazeni.match(/<form\b/g) || []).length, 1, 'na stránce je jen formulář nastavení');
  assert.ok(!zobrazeni.includes('Uložit nastavení'), 'staré tlačítko Uložit nastavení je pryč');
  assert.match(zobrazeni, /<div class="upravit-paticka jen-upravy">/, 'pod formulářem je patička Zrušit/Uložit');
});

test('hodnoty jako text: escapovaný název, odkazy, plátce DPH, výchozí pokladna; tužka a Zrušit bez JS', async () => {
  const html = await vykresli();
  assert.ok(html.includes('SEIL &lt;b&gt;s.r.o.&lt;/b&gt;'), 'název se escapuje');
  assert.ok(!html.includes('<b>s.r.o.</b>'), 'surový název v HTML není');
  assert.match(html, /<a href="mailto:info@example\.invalid">info@example\.invalid<\/a>/, 'e-mail jako odkaz');
  assert.match(html, /<a href="tel:\+420777123456">\+420 777 123 456<\/a>/, 'telefon jako odkaz');
  assert.match(html, /<div class="pole-hodnota">Plátce DPH<\/div>/, 'plátce DPH jako text');
  assert.match(html, /<input type="checkbox" value="on" id="pole-vat_payer" name="vat_payer" checked>/, 'checkbox posílá on jako dřív');
  assert.match(html, /<div class="pole-hodnota">Pokladna<\/div>/, 'prázdná pokladna ukazuje výchozí „Pokladna“');
  assert.match(html, /name="pohoda_cash_account"[^>]*maxlength="20"/, 'pokladna má maxlength jako dřív');
  assert.ok(html.includes('href="/nastaveni/firma?upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"'), 'tužka bez JS otevře úpravy');
  assert.ok(html.includes('href="/nastaveni/firma" class="btn btn-ghost upravit-zrusit"'), 'Zrušit vede zpět bez upravit');

  const neplatce = await vykresli({ company: { ...company, vat_payer: false } });
  assert.match(neplatce, /<div class="pole-hodnota">Neplátce DPH<\/div>/, 'neplátce má význam, ne „Ne“');
  assert.doesNotMatch(neplatce, /name="vat_payer"[^>]*checked/, 'checkbox neplátce není zaškrtnutý');
});

test('nápovědy jen v úpravách a bez <code>, odstavec o IČO jen v úpravách, box „Kam který doklad spadne“ vždy', async () => {
  const html = await vykresli({ saved: true });
  assert.match(html, /class="alert alert-success jen-zobrazeni"/, 'banner Uloženo je jen pro režim zobrazení');
  assert.match(html, /<div class="form-group jen-upravy" style="grid-column:1\/-1;">\s*<p[^>]*>\s*Účetní jednotku určuje IČO výše/, 'vysvětlení účetní jednotky patří k úpravám');
  const box = html.indexOf('Kam který doklad spadne');
  assert.ok(box > 0, 'box s rozdělením dokladů je na stránce');
  assert.ok(!/class="form-group jen-(upravy|zobrazeni)"[^]*?Kam který doklad spadne/.test(html.slice(html.lastIndexOf('<div class="form-group', box))), 'box je vidět v obou režimech');
  const hinty = html.match(/<small class="form-hint jen-upravy">[^]*?<\/small>/g) || [];
  assert.equal(hinty.length, 5, 'pokladna, tři předkontace a složka Disku mají nápovědu');
  assert.ok(hinty.every(h => !h.includes('<code>')), 'nápovědy jsou prostý text');
  assert.ok(hinty.some(h => h.includes('drive.google.com/drive/folders/ID')), 'adresa složky zůstala v nápovědě');
});

// ── Proti serveru ───────────────────────────────────────────────

describe('proti serveru', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(4).toString('hex');
  const uklid = { users: [], sids: [] };
  let sql, req, puvodni;

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const [u] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`nast-firma-${r}@example.invalid`}, 'x', 'Test', 'Správce', TRUE) RETURNING id`;
    uklid.users.push(u.id);
    const { sid, cookie } = await prihlas(sql, u.id);
    uklid.sids.push(sid);
    req = pozadavky(cookie);
    [puvodni] = await sql`SELECT * FROM company_settings ORDER BY id LIMIT 1`;
  });

  after(async () => {
    if (!sql) return;
    // Jednořádková sdílená tabulka: vrátit, co tam bylo (POST přepisuje všechny sloupce formuláře).
    if (puvodni) await sql`UPDATE company_settings SET ${sql(puvodni, ...SLOUPCE, 'updated_at')} WHERE id = ${puvodni.id}`;
    else await sql`DELETE FROM company_settings`;
    if (uklid.sids.length)  await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
    if (uklid.users.length) await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
    await sql.end();
  });

  test('GET: zobrazení, ?upravit=1 otevře úpravy i bez JavaScriptu', async () => {
    let res = await req.get('/nastaveni/firma');
    assert.equal(res.status, 200);
    let html = await res.text();
    assert.ok(html.includes('data-rezim="zobrazeni"'), 'výchozí je zobrazení');
    assert.ok(html.includes(`id="${FORMULAR}" class="upravitelne"`), 'formulář záznamu je označený');
    assert.ok(html.includes('href="/nastaveni/firma?upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"'), 'tužka vede na ?upravit=1');
    assert.ok(html.includes(`form="${FORMULAR}" class="btn btn-primary upravit-ulozit"`), 'Uložit míří na formulář záznamu');

    res = await req.get('/nastaveni/firma?upravit=1');
    assert.equal(res.status, 200);
    html = await res.text();
    assert.ok(html.includes('data-rezim="upravy"'), '?upravit=1 otevře úpravy');
    assert.ok(!html.includes('data-rezim="zobrazeni"'));
  });

  test('POST uloží a přesměruje bez upravit; po uložení je zobrazení s hláškou', async () => {
    const puv = puvodni || {};
    const telo = Object.fromEntries(SLOUPCE.filter(k => k !== 'vat_payer').map(k => [k, puv[k] ?? '']));
    telo.name = `Firma test ${r}`;
    telo.vat_payer = 'on';
    const res = await req.post('/nastaveni/firma', telo);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/nastaveni/firma?saved=1', 'úspěch vrací do zobrazení bez upravit');

    const [po] = await sql`SELECT name, vat_payer, ico FROM company_settings ORDER BY id LIMIT 1`;
    assert.equal(po.name, `Firma test ${r}`, 'název se uložil');
    assert.equal(po.vat_payer, true);
    assert.equal(po.ico, puv.ico ?? '', 'ostatní sloupce zůstaly');

    const html = await (await req.get('/nastaveni/firma?saved=1')).text();
    assert.ok(html.includes('data-rezim="zobrazeni"'));
    assert.ok(html.includes('class="alert alert-success jen-zobrazeni"'), 'hláška Uloženo nad zobrazením');
    assert.ok(html.includes(`<div class="pole-hodnota">Firma test ${r}</div>`), 'nový název jako text pole');
  });
});
