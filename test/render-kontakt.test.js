// Detail kontaktu (views/pages/crm/contact-detail.ejs) vykreslený bez serveru
// a databáze: záložky Přehled, Objednávky a Faktury, stránka jen ke čtení.
// Seznamy se stránkováním a součty ze SQL proti databázi: test/seznam-crm.test.js.
//
//   node --test test/render-kontakt.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vykresliStranku } from './pomocnici/render.js';
import { strankovani } from '../src/strankovani.js';

const contact = {
  id: 'kontakttest01', first_name: 'Jana', last_name: 'Nováková <b>tučně</b>', title: 'Jednatelka',
  email: 'jana@example.invalid', phone: '+420 777 123 456', company_id: 'firma01', company_display_name: 'Vlněnka & synové',
  notes: 'Volat <i>dopoledne</i>\ndruhý řádek', source: 'eshop', is_registered: true,
  created_at: new Date('2026-03-05T23:30:00Z'), last_login: new Date('2026-10-01T10:00:00Z'),
  gdpr_consent_at: new Date('2026-01-15T10:00:00Z'), marketing_consent: true, notifications_consent: false,
};

const ZALOZKY = [
  { klic: 'prehled', popisek: 'Přehled' },
  { klic: 'objednavky', popisek: 'Objednávky', pocet: 2 },
  { klic: 'faktury', popisek: 'Faktury', pocet: 3 },
];

const orders = [
  { id: 'obj1', order_number: '1001', status: 'Přijata', total_price: '1234.50', currency: 'CZK', created_at: new Date('2026-10-10T10:00:00Z') },
  { id: 'obj2', order_number: '1002', status: 'Stornována', total_price: '99.00', currency: 'EUR', created_at: new Date('2026-10-09T10:00:00Z') },
];
const invoices = [
  { id: 'fv1', type: 'issued', number: 'FV2026', status: 'Zaplacena', issue_date: new Date('2026-10-10T00:00:00Z'), due_date: new Date('2026-10-24T00:00:00Z'), total_amount: '1234.50', currency: 'CZK' },
  { id: 'za1', type: 'proforma', number: 'ZF2026', status: 'Nezaplacena', issue_date: new Date('2026-10-09T00:00:00Z'), due_date: null, total_amount: '500.00', currency: 'CZK' },
  { id: 'fp1', type: 'received', number: 'FP2026', status: 'Po splatnosti', issue_date: new Date('2026-10-08T00:00:00Z'), due_date: null, total_amount: '20.00', currency: 'EUR' },
];
const souhrn = { objednavek: 2, faktur: 3, utraceno: 1333.5, zaplaceno: 1234.5, posledni: new Date('2026-10-10T10:00:00Z') };

function vykresli(tab, prepis = {}) {
  return vykresliStranku('crm/contact-detail', {
    pageTitle: 'Jana', currentPath: '/crm/kontakty', contact, souhrn, tab, zalozky: ZALOZKY,
    orders: tab === 'objednavky' ? orders : [], invoices: tab === 'faktury' ? invoices : [],
    strany: tab === 'prehled' ? null : strankovani({ cesta: `/crm/kontakty/${contact.id}`, celkem: tab === 'faktury' ? 3 : 2, pevne: { tab } }),
    ...prepis,
  });
}

for (const tab of ['prehled', 'objednavky', 'faktury']) {
  test(`záložka ${tab}: pruh s počty, návrat na seznam, stránka jen ke čtení`, async () => {
    const html = await vykresli(tab);
    assert.match(html, /<nav class="tabs" aria-label="Sekce kontaktu">/);
    for (const k of ['prehled', 'objednavky', 'faktury']) {
      assert.ok(html.includes(`href="/crm/kontakty/kontakttest01?tab=${k}"`), `odkaz záložky ${k}`);
    }
    assert.match(html, new RegExp(`href="/crm/kontakty/kontakttest01\\?tab=${tab}" class="tab active" aria-current="page"`), 'otevřená záložka je označená');
    assert.equal(html.match(/class="tab active"/g).length, 1);
    assert.match(html, /Objednávky <span class="tab-pocet">2<\/span>/);
    assert.match(html, /Faktury <span class="tab-pocet">3<\/span>/);
    assert.match(html, /<a href="\/crm\/kontakty"[^>]*\bdata-zpet\b/, 'odkaz zpět se přesměruje na poslední stránku seznamu');
    assert.ok(!/<form\b/.test(html), 'žádný formulář');
    assert.ok(!html.includes('upravit-otevrit') && !html.includes('data-rezim') && !html.includes('upravit=1'), 'žádná tužka ani režim úprav');
    assert.ok(!html.includes('<b>tučně</b>') && html.includes('Nováková &lt;b&gt;tučně&lt;/b&gt;'), 'jméno se escapuje');
  });
}

test('přehled: informace, souhlasy, poznámky a čtyři čísla souhrnu, bez řádků dokladů', async () => {
  const html = await vykresli('prehled');
  for (const popisek of ['Objednávek', 'Objednáno za', 'Zaplaceno na dokladech', 'Poslední objednávka']) {
    assert.ok(html.includes(`<div class="kpi-label">${popisek}</div>`), popisek);
  }
  const hodnoty = [...html.matchAll(/<div class="kpi-value">([^<]*)<\/div>/g)].map(m => m[1]);
  assert.deepEqual(hodnoty, ['2', '1 334 Kč', '1 235 Kč', '10. 10. 2026'], 'souhrn z routy, zaokrouhlený jako dřív');

  assert.match(html, /<strong>Informace<\/strong>/);
  assert.match(html, /<strong>Souhlasy<\/strong>/);
  assert.match(html, /<strong>Poznámky<\/strong>/);
  assert.ok(html.includes('Volat &lt;i&gt;dopoledne&lt;/i&gt;'), 'poznámka se escapuje');
  assert.ok(!html.includes('<i>dopoledne</i>'));
  assert.ok(html.includes('6. 3. 2026'), 'okamžik těsně před půlnocí UTC je v Praze už další den');
  assert.ok(html.includes('15. 1. 2026'), 'datum souhlasu');
  assert.ok(html.includes('Odebírá') && html.includes('>Ne<'), 'stav souhlasů');
  assert.ok(!html.includes('class="data-table"') && !html.includes('class="strankovani"'), 'přehled nemá tabulky ani patičku');
});

test('přehled bez objednávek: souhrn je vidět s nulami a pomlčkou, bez poznámky karta není', async () => {
  const html = await vykresli('prehled', {
    contact: { ...contact, notes: '' },
    souhrn: { objednavek: 0, faktur: 1, utraceno: 0, zaplaceno: 500, posledni: null },
  });
  const hodnoty = [...html.matchAll(/<div class="kpi-value">([^<]*)<\/div>/g)].map(m => m[1]);
  assert.deepEqual(hodnoty, ['0', '0 Kč', '500 Kč', '–']);
  assert.ok(!html.includes('<strong>Poznámky</strong>'));
});

test('firma: připojená je odkaz na detail, text z účtu bez odkazu, bez firmy nic', async () => {
  let html = await vykresli('prehled');
  assert.equal(html.match(/<a href="\/crm\/firmy\/firma01"[^>]*>Vlněnka &amp; synové<\/a>/g).length, 2, 'v hlavičce a v informacích');

  html = await vykresli('prehled', { contact: { ...contact, company_id: null, company_display_name: 'Text z e-shopu' } });
  assert.ok(html.includes('Text z e-shopu'));
  assert.ok(!html.includes('/crm/firmy/'), 'kontakt bez firmy nevede na neexistující detail');

  html = await vykresli('prehled', { contact: { ...contact, company_id: null, company_display_name: '' } });
  assert.ok(!html.includes('>Firma<'), 'bez firmy řádek není');
});

test('kontakt bez jména: nadpis je e-mail, bez e-mailu popis', async () => {
  let html = await vykresli('prehled', { contact: { ...contact, first_name: '', last_name: '' } });
  assert.match(html, /<h1[^>]*>jana@example\.invalid<\/h1>/);
  html = await vykresli('prehled', { contact: { ...contact, first_name: '', last_name: '', email: null } });
  assert.match(html, /<h1[^>]*>\(bez jména\)<\/h1>/);
});

test('objednávky: řádek je odkaz, částka podle měny objednávky, patička nese záložku', async () => {
  const html = await vykresli('objednavky');
  assert.ok(html.includes('<tr data-href="/ucetnictvi/objednavky/obj1">'), 'řádek bez onclick');
  assert.ok(html.includes('<a href="/ucetnictvi/objednavky/obj1" class="radek-odkaz">#1001</a>'), 'skutečný odkaz v první buňce');
  assert.ok(html.includes('1 234,50 CZK') && html.includes('99,00 EUR'), 'částka z numeric je formátovaná, ne surový text');
  assert.ok(html.includes('badge-info') && html.includes('badge-chyba'), 'tóny stavů');
  assert.equal((html.match(/<th\b/g) || []).length, 4, 'kontakt nemá sloupec Zákazník');
  assert.match(html, /<div class="strankovani" data-seznam="\/crm\/kontakty\/kontakttest01\?tab=objednavky">/);
  assert.ok(!html.includes('onclick'));
  assert.ok(!html.includes('FV2026'), 'jiná záložka řádky nemá');
});

test('faktury: záloha i vydaná vedou na vydané, přijatá na přijaté, typ odpovídá', async () => {
  const html = await vykresli('faktury');
  assert.ok(html.includes('<tr data-href="/ucetnictvi/vydane-faktury/fv1">'));
  assert.ok(html.includes('<tr data-href="/ucetnictvi/vydane-faktury/za1">'), 'záloha pod přijatými skončí 404');
  assert.ok(html.includes('<tr data-href="/ucetnictvi/prijate-faktury/fp1">'));
  assert.ok(!html.includes('/ucetnictvi/prijate-faktury/za1'));
  for (const typ of ['Faktura', 'Zálohová faktura', 'Přijatá faktura']) assert.ok(html.includes(`>${typ}</td>`), typ);
  assert.ok(html.includes('10. 10. 2026') && html.includes('24. 10. 2026'), 'datum a splatnost z DATE');
  assert.ok(html.includes('20,00 EUR'), 'měna dokladu');
  assert.match(html, /<div class="strankovani" data-seznam="\/crm\/kontakty\/kontakttest01\?tab=faktury">/);
});

test('prázdné záložky: prázdný stav přes všechny sloupce a bez patičky', async () => {
  const obj = await vykresli('objednavky', { orders: [], strany: strankovani({ cesta: '/x', celkem: 0, pevne: { tab: 'objednavky' } }) });
  assert.ok(obj.includes('<td colspan="4"><div class="prazdno"><strong>Žádné objednávky</strong>'));
  assert.ok(!obj.includes('class="strankovani"'));
  const fak = await vykresli('faktury', { invoices: [], strany: strankovani({ cesta: '/x', celkem: 0, pevne: { tab: 'faktury' } }) });
  assert.ok(fak.includes('<td colspan="6"><div class="prazdno"><strong>Žádné faktury</strong>'));
  assert.ok(!fak.includes('class="strankovani"'));
});
