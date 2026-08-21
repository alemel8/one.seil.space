// Přístupová matice — katalog, vyhodnocení práv a mapování URL.
//
// Nepotřebuje běžící server ani databázi:
//   node --test test/access.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_SECTIONS, ACCESS_ITEMS, ACCESS_KEYS,
  accessItem, isAllowed, visibleItems, visibleSections, matchAccessItem,
} from '../src/access.js';

const spravce  = (access = {}) => ({ id: 1, is_admin: true,  access });
const uzivatel = (access = {}) => ({ id: 2, is_admin: false, access });

describe('katalog přístupů', () => {
  test('klíče jsou jedinečné a mají tvar sekce.polozka', () => {
    assert.equal(new Set(ACCESS_KEYS).size, ACCESS_KEYS.length);
    for (const item of ACCESS_ITEMS) {
      assert.match(item.key, /^[a-z-]+\.[a-z0-9-]+$/);
      assert.equal(item.key.split('.')[0], item.section.key);
    }
  });

  test('každá položka má popisek i cestu', () => {
    for (const item of ACCESS_ITEMS) {
      assert.ok(item.label, `${item.key} nemá popisek`);
      assert.ok(item.path?.startsWith('/'), `${item.key} nemá cestu`);
    }
  });
});

describe('vyhodnocení práv', () => {
  test('bez uloženého záznamu uživatel sekci vidí', () => {
    assert.equal(isAllowed(uzivatel(), 'ucetnictvi.banka'), true);
  });

  test('odškrtnutá sekce se skryje', () => {
    assert.equal(isAllowed(uzivatel({ 'ucetnictvi.banka': false }), 'ucetnictvi.banka'), false);
    assert.equal(isAllowed(spravce({ 'ucetnictvi.banka': false }), 'ucetnictvi.banka'), false);
  });

  test('zaškrtnutí nepovýší uživatele na správce', () => {
    assert.equal(isAllowed(uzivatel({ 'nastaveni.firma': true }), 'nastaveni.firma'), false);
    assert.equal(isAllowed(uzivatel({ 'monitoring.healthchecky': true }), 'monitoring.healthchecky'), false);
    assert.equal(isAllowed(spravce(), 'nastaveni.firma'), true);
  });

  test('správce nepřijde o editor přístupů, ani když ho odškrtne', () => {
    assert.equal(isAllowed(spravce({ 'lide.pristupy': false }), 'lide.pristupy'), true);
    // …a Tým odebrat lze
    assert.equal(isAllowed(spravce({ 'lide.tym': false }), 'lide.tym'), false);
  });

  test('citlivé položky se musí zaškrtnout vědomě', () => {
    // Mzdy nesmí být vidět jen proto, že se někdo stal správcem. Bez
    // uloženého záznamu je defaultDeny drží zavřené.
    assert.equal(isAllowed(spravce(), 'lide.mzdy'), false);
    assert.equal(isAllowed(spravce(), 'lide.ekonomika'), false);
    assert.equal(isAllowed(spravce({ 'lide.mzdy': true }), 'lide.mzdy'), true);
    assert.equal(isAllowed(spravce({ 'lide.mzdy': false }), 'lide.mzdy'), false);

    // Zbytek katalogu se chová dál po starém — nasazení nikoho neodřízne
    assert.equal(isAllowed(spravce(), 'lide.tym'), true);
    assert.equal(isAllowed(spravce(), 'lide.podklady'), true);

    // A role je pořád tvrdší než matice
    assert.equal(isAllowed(uzivatel({ 'lide.mzdy': true }), 'lide.mzdy'), false);
  });

  test('nepřihlášený nevidí nic, neznámý klíč neomezuje', () => {
    assert.equal(isAllowed(null, 'crm.firmy'), false);
    assert.equal(isAllowed(uzivatel(), 'neexistuje.klic'), true);
  });

  test('sekce bez viditelné položky vypadne z menu', () => {
    const bezUcetnictvi = uzivatel(Object.fromEntries(
      ACCESS_SECTIONS.find(s => s.key === 'ucetnictvi').items.map(i => [i.key, false])
    ));
    const klice = visibleSections(bezUcetnictvi).map(s => s.key);
    assert.ok(!klice.includes('ucetnictvi'));
    assert.ok(!klice.includes('nastaveni'), 'Nastavení je jen pro správce');
    assert.ok(klice.includes('crm'));

    const monitoring = ACCESS_SECTIONS.find(s => s.key === 'monitoring');
    assert.deepEqual(visibleItems(uzivatel(), monitoring).map(i => i.key), ['monitoring.vps']);
    assert.equal(visibleItems(spravce(), monitoring).length, 2);
  });
});

describe('mapování URL na položku katalogu', () => {
  const key = url => matchAccessItem(url)?.key ?? null;

  test('přesná i podstromová shoda', () => {
    assert.equal(key('/'), 'home.prehled');
    assert.equal(key('/ucetnictvi/uctenky'), 'ucetnictvi.uctenky');
    assert.equal(key('/ucetnictvi/uctenky/42/upravit'), 'ucetnictvi.uctenky');
    assert.equal(key('/ucetnictvi/prijate-faktury/gdrive/import'), 'ucetnictvi.prijate-faktury');
    assert.equal(key('/projekty/podprojekty/7'), 'projekty.seznam');
  });

  test('domovská stránka nechytá všechno ostatní', () => {
    assert.equal(key('/profil'), null);
    assert.equal(key('/api/v1/orders'), null);
    assert.equal(key('/static/css/layout.css'), null);
  });

  test('při překryvu vyhrává nejdelší cesta', () => {
    assert.equal(key('/nastaveni'), null, 'osobní nastavení matice neřeší');
    assert.equal(key('/nastaveni/firma'), 'nastaveni.firma');
    assert.equal(key('/nastaveni/healthchecky/3/toggle'), 'monitoring.healthchecky');
    assert.equal(key('/nastaveni/notifikace/kanal/vytvorit'), 'monitoring.healthchecky');
  });

  test('vedlejší cesty patří ke své sekci', () => {
    assert.equal(key('/crm/smlouvy/9/smazat'), 'crm.firmy');
    assert.equal(key('/ucetnictvi/migrace'), 'ucetnictvi.objednavky');
  });

  test('query a fragment nevadí', () => {
    assert.equal(key('/lide/tym?q=novak'), 'lide.tym');
    assert.equal(key('/lide/tym/abc123#pristupy'), 'lide.tym');
  });

  test('každá položka katalogu se najde podle vlastní cesty', () => {
    for (const item of ACCESS_ITEMS) {
      assert.equal(matchAccessItem(item.path)?.key, item.key, `${item.key} → ${item.path}`);
    }
  });

  test('accessItem vrací položku i sekci', () => {
    assert.equal(accessItem('crm.kontakty').section.label, 'CRM');
    assert.equal(accessItem('nesmysl'), null);
  });
});
