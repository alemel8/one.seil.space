// Detail člena týmu (views/pages/people/member-detail.ejs) vykreslený bez
// serveru a databáze: režim úprav na záložkách Detail a Bankovní účet, tužka
// jen tam, a každý sloupec, který POST /lide/tym/:id zapisuje, má v obou
// formulářích pole — routa přepisuje všech šestnáct sloupců naráz, druhá
// záložka je posílá skrytě. Serverová část jede proti běžícímu serveru
// a lokální testovací databázi (test/pomocnici/server.js).
//
//   node --test test/render-clen.test.js
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/render-clen.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { vykresliStranku, zkontrolujDetail } from './pomocnici/render.js';
import { lokalniDatabaze, serverBezi, prihlas, pozadavky, PRESKOCIT } from './pomocnici/server.js';
import { ACCESS_SECTIONS, isAllowed } from '../src/access.js';
import { PLATBA_DRUHY, PODKLAD_STAVY } from '../src/hr.js';

// Záložky z ZALOZKY v src/routes/people.js; formulář záznamu mají jen první dvě.
const ZALOZKY = [
  ['detail', 'formDetail'], ['banka', 'formBanka'],
  ['ekonomika', null], ['podklady', null], ['mzdy', null], ['hodiny', null],
  ['vydaje', null], ['dokumenty', null], ['pristupy', null],
];

const member = {
  id: 42, public_id: 'abcdef123456', email: 'jana@example.invalid', first_name: 'Jana', last_name: 'Nováková <b>',
  title: 'Ing.', phone: '+420 777 123 456', position: 'Účetní', bio: 'Krátký <b>popis</b>\ndruhý řádek',
  address: 'Nádražní 1', city: 'Brno', zip: '602 00', country: '',
  bank_account: '123456789/0100', bank_name: 'Komerční banka', iban: 'CZ65 0800 0000 1920 0014 5399',
  is_admin: false, is_active: true, photo: null, created_at: new Date('2025-03-05T00:00:00Z'), updated_at: null, access: {},
};

function vykresli(currentTab, prepis = {}) {
  return vykresliStranku('people/member-detail', {
    pageTitle: 'Jana Nováková', currentPath: '/lide/tym', member, sections: ACCESS_SECTIONS, isAllowed, currentTab,
    pocty: { podklady: 0, mzdy: 0, platby: 0, dokumenty: 0, mereni: 0 },
    ucet: { prijmy: 0, prijmyPocet: 0, vydaje: 0, vydajePocet: 0, nakladFirmy: 0, hodiny: 0, odmena: 0, ostatni: 0, ostatniPocet: 0, zustatek: 0 },
    pohyby: [], podklady: [], mzdy: [], platby: [], dokumenty: [], mesice: [],
    maData: false, PLATBA_DRUHY, PODKLAD_STAVY, saved: false, rezimUprav: false, ...prepis,
  });
}

// Sloupce z UPDATE users v POST /lide/tym/:id — oba formuláře posílají všech šestnáct (+ tab).
const SLOUPCE = ['tab', 'email', 'first_name', 'last_name', 'title', 'phone', 'position', 'bio', 'address', 'city', 'zip', 'country',
  'bank_account', 'bank_name', 'iban', 'is_admin', 'is_active'];

for (const [tab, formular] of ZALOZKY) {
  test(`záložka ${tab}: ${formular ? 'tužka, formulář a všech 16 sloupců' : 'bez tužky'} v obou režimech`, async () => {
    const zobrazeni = await vykresli(tab);
    zkontrolujDetail(zobrazeni, { formular, sloupce: formular ? SLOUPCE : [], rezim: 'zobrazeni' });
    const upravy = await vykresli(tab, { rezimUprav: true });
    zkontrolujDetail(upravy, { formular, sloupce: formular ? SLOUPCE : [], rezim: formular ? 'upravy' : 'zobrazeni' });
  });
}

test('detail: hodnoty jako text a odkazy, escapované, role a stav slovy, výchozí stát', async () => {
  const html = await vykresli('detail');
  assert.ok(html.includes('Nováková &lt;b&gt;'), 'příjmení se escapuje');
  assert.ok(!html.includes('<b>'), 'surové <b> v HTML není');
  assert.match(html, /<a href="mailto:jana@example\.invalid">jana@example\.invalid<\/a>/, 'e-mail jako odkaz');
  assert.match(html, /<a href="tel:\+420777123456">\+420 777 123 456<\/a>/, 'telefon jako odkaz bez mezer');
  assert.match(html, /<div class="pole-hodnota pole-hodnota-blok">Krátký &lt;b&gt;popis&lt;\/b&gt;\ndruhý řádek<\/div>/, 'bio jako blok se zachovanými řádky');
  assert.match(html, /<div class="pole-hodnota">Uživatel<\/div>/, 'role slovy, ne Ano/Ne');
  assert.match(html, /<div class="pole-hodnota">Aktivní<\/div>/, 'stav účtu slovy');
  assert.match(html, /name="is_admin"(?![^>]*checked)/, 'přepínač správce není zaškrtnutý');
  assert.match(html, /name="is_active"[^>]*checked/, 'přepínač aktivního účtu je zaškrtnutý');
  assert.match(html, /<div class="pole-hodnota">Česká republika<\/div>/, 'prázdný stát ukáže výchozí hodnotu');
  assert.match(html, /value="Česká republika"[^>]*name="country"/, 'výchozí stát je i ve vstupu');
  assert.ok(!html.includes('--bg-secondary'), 'šedý box rolí s neexistující proměnnou je pryč');

  const spravce = await vykresli('detail', { member: { ...member, is_admin: true, is_active: false } });
  assert.match(spravce, /<div class="pole-hodnota">Správce<\/div>/);
  assert.match(spravce, /<div class="pole-hodnota">Neaktivní<\/div>/);
});

test('hlavička: Zpět na tým v plné velikosti vedle tužky, tužka a Zrušit vedou na tutéž záložku, patička jen u dlouhého formuláře', async () => {
  const detail = await vykresli('detail', { saved: true });
  assert.match(detail, /<div class="page-header-akce">\s*<a href="\/lide\/tym" class="btn btn-outline">← Zpět na tým<\/a>\s*<a href="\?tab=detail&amp;upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"/, 'Zpět na tým bez btn-sm, tužka hned za ním');
  assert.ok(detail.includes('href="?tab=detail" class="btn btn-ghost upravit-zrusit"'), 'Zrušit vede zpět bez upravit');
  assert.match(detail, /<div class="jen-zobrazeni" style="[^"]*">\s*Změny byly uloženy\./, 'banner Uloženo se v úpravách skryje');
  assert.ok(detail.includes('class="upravit-paticka jen-upravy"'), 'dlouhý formulář detailu má patičku');
  assert.ok(!detail.includes('Uložit změny'), 'staré tlačítko je pryč');

  const banka = await vykresli('banka');
  assert.ok(banka.includes('href="?tab=banka&amp;upravit=1"'), 'tužka na záložce banky vede na ni');
  assert.ok(!banka.includes('upravit-paticka'), 'tři pole patičku nepotřebují');
  assert.ok(!banka.includes('Uložit bankovní účet'), 'staré tlačítko je pryč');
  assert.match(banka, /<input type="hidden" name="first_name" value="Jana">/, 'osobní údaje jdou skrytě');
  assert.match(banka, /<input type="hidden" name="is_admin" value="">/, 'nesprávce posílá prázdné is_admin (routa čte jen 1/on)');
  assert.match(banka, /<input type="hidden" name="is_active" value="1">/);
  assert.match(banka, /<div class="pole-hodnota">123456789\/0100<\/div>/, 'číslo účtu jako text');
});

test('záložka bez formuláře zůstává v zobrazení i s ?upravit=1 a fotka má vlastní formulář mimo režim', async () => {
  const html = await vykresli('pristupy', { rezimUprav: true });
  assert.ok(html.includes('data-rezim="zobrazeni"'));
  assert.ok(!html.includes('upravit-ulozit'), 'bez formuláře záznamu není ani Uložit');
  assert.ok(html.includes('Co uživatel vidí'), 'obsah přístupů se vykreslí');
  assert.match(html, /<form method="post" action="\/lide\/tym\/abcdef123456\/foto" enctype="multipart\/form-data"\s+style="[^"]*">/, 'formulář fotky zůstal');
  assert.ok(!/action="\/lide\/tym\/abcdef123456\/foto"[^>]*upravitelne/.test(html), 'formulář fotky režim nezná');
});

// ── Proti serveru ──────────────────────────────────────────────────

describe('proti serveru', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(4).toString('hex');
  let sql, req, sid;
  const uklid = { users: [] };
  const ctx = {};

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const [admin] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`clen-admin-${r}@example.invalid`}, 'x', 'Test', 'Správce', TRUE) RETURNING id`;
    uklid.users.push(admin.id);
    const [clen] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin, position, bank_account)
      VALUES (${`clen-${r}@example.invalid`}, 'x', 'Jana', ${`Nováková ${r}`}, FALSE, 'Účetní', '123456789/0100')
      RETURNING id, public_id`;
    uklid.users.push(clen.id);
    ctx.clen = clen;
    const session = await prihlas(sql, admin.id);
    sid = session.sid;
    req = pozadavky(session.cookie);
  });

  after(async () => {
    if (!sql) return;
    if (sid) await sql`DELETE FROM session WHERE sid = ${sid}`;
    if (uklid.users.length) await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
    await sql.end();
  });

  const detail = async (q = '') => {
    const res = await req.get(`/lide/tym/${ctx.clen.public_id}${q}`);
    assert.equal(res.status, 200, q);
    return res.text();
  };

  test('detail: zobrazení, ?upravit=1 otevře úpravy, banka má tužku, přístupy ne', async () => {
    let html = await detail('?tab=detail');
    assert.ok(html.includes('data-rezim="zobrazeni"'), 'výchozí je zobrazení');
    assert.ok(html.includes('href="?tab=detail&amp;upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"'), 'tužka vede bez JS na ?upravit=1');
    assert.ok(html.includes('form="formDetail" class="btn btn-primary upravit-ulozit"'), 'Uložit míří na formulář záznamu');
    assert.ok(html.includes('id="formDetail" class="upravitelne"'));
    assert.ok(html.includes(`Nováková ${r}`), 'data člena jsou na stránce');

    html = await detail('?tab=detail&upravit=1');
    assert.ok(html.includes('data-rezim="upravy"'), '?upravit=1 otevře úpravy i bez JavaScriptu');

    html = await detail('?tab=banka&upravit=1');
    assert.ok(html.includes('data-rezim="upravy"') && html.includes('id="formBanka" class="upravitelne"'), 'banka má svůj formulář záznamu');

    html = await detail('?tab=pristupy&upravit=1');
    assert.ok(html.includes('data-rezim="zobrazeni"') && !html.includes('upravit-otevrit') && !html.includes('upravit-ulozit'), 'přístupy: bez formuláře záznamu není tužka ani úpravy');
    assert.ok(!/<form\b[^>]*>(?:(?!<\/form>)[\s\S])*<form\b/.test(html), 'žádný vnořený formulář');
  });

  test('POST uloží jméno a skrytý bankovní účet zůstane, přesměruje na záložku bez upravit', async () => {
    const c = ctx.clen;
    let res = await req.post(`/lide/tym/${c.public_id}`, {
      tab: 'detail', email: `clen-${r}@example.invalid`, first_name: 'Jana Marie', last_name: `Nováková ${r}`, title: 'Ing.',
      phone: '', position: 'Hlavní účetní', bio: '', address: '', city: 'Brno', zip: '', country: 'Česká republika',
      bank_account: '123456789/0100', bank_name: '', iban: '', is_active: '1',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/lide/tym/${c.public_id}?tab=detail&saved=1`);
    let [u] = await sql`SELECT first_name, position, city, bank_account, is_admin, is_active FROM users WHERE id = ${c.id}`;
    assert.deepEqual([u.first_name, u.position, u.city, u.bank_account, u.is_admin, u.is_active],
      ['Jana Marie', 'Hlavní účetní', 'Brno', '123456789/0100', false, true]);

    // Banka: prázdné is_admin ze skrytého pole = dál nesprávce, účet se změní
    res = await req.post(`/lide/tym/${c.public_id}`, {
      tab: 'banka', email: `clen-${r}@example.invalid`, first_name: 'Jana Marie', last_name: `Nováková ${r}`, title: 'Ing.',
      phone: '', position: 'Hlavní účetní', bio: '', address: '', city: 'Brno', zip: '', country: 'Česká republika',
      bank_account: '987654321/0300', bank_name: 'ČSOB', iban: '', is_admin: '', is_active: '1',
    });
    assert.equal(res.headers.get('location'), `/lide/tym/${c.public_id}?tab=banka&saved=1`);
    [u] = await sql`SELECT first_name, bank_account, bank_name, is_admin FROM users WHERE id = ${c.id}`;
    assert.deepEqual([u.first_name, u.bank_account, u.bank_name, u.is_admin], ['Jana Marie', '987654321/0300', 'ČSOB', false]);

    const html = await detail('?tab=banka&saved=1');
    assert.match(html, /<div class="jen-zobrazeni" style="[^"]*">\s*Změny byly uloženy\./, 'hláška po uložení jen v zobrazení');
    assert.match(html, /<div class="pole-hodnota">987654321\/0300<\/div>/, 'nová hodnota je vidět jako text');
  });
});
