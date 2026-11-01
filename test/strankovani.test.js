// Stránkování seznamů bez serveru a databáze: čísla a odkazy (src/strankovani.js),
// patička (views/includes/strankovani.ejs), návratová adresa (src/navrat.js)
// a klíč záložky (src/zalozky.js).
//
//   node --test test/strankovani.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { parametr, cisloStranky, velikostStranky, oknoStran, strankovani, VELIKOSTI } from '../src/strankovani.js';
import { bezpecnyNavrat } from '../src/navrat.js';
import { zalozka } from '../src/zalozky.js';
import { tonStavu } from '../src/stavy.js';

const sablona = fileURLToPath(new URL('../views/includes/strankovani.ejs', import.meta.url));
const vykresli = (strany) => ejs.renderFile(sablona, { strany });
const seznam = (query, celkem, dalsi = {}) => strankovani({ cesta: '/seznam', query, celkem, ...dalsi });

describe('čtení parametrů', () => {
  test('parametr: první hodnota, ořez, bez NUL; jiné typy jsou prázdné', () => {
    assert.equal(parametr(' abc '), 'abc');
    assert.equal(parametr(['a', 'b']), 'a');
    assert.equal(parametr('a\0b'), 'ab');
    for (const v of [undefined, null, 5, {}, []]) assert.equal(parametr(v), '');
  });

  test('cisloStranky: platná čísla', () => {
    assert.equal(cisloStranky('1'), 1);
    assert.equal(cisloStranky('2'), 2);
    assert.equal(cisloStranky('007'), 7);
    assert.equal(cisloStranky(['3', '4']), 3);
  });

  test('cisloStranky: všechno ostatní je první stránka', () => {
    for (const v of [undefined, null, '', ' ', 'abc', '0', '-1', '1.5', '1e3', '2abc', '0x10', 'NaN', 'Infinity', '\0', {}, []]) {
      assert.equal(cisloStranky(v), 1, JSON.stringify(v));
    }
  });

  test('cisloStranky: obří číslo je bezpečné celé číslo', () => {
    const n = cisloStranky('99999999999999999999');
    assert.ok(Number.isSafeInteger(n));
  });

  test('velikostStranky: jen z nabídky', () => {
    assert.equal(velikostStranky('50'), 50);
    assert.equal(velikostStranky('100'), 100);
    for (const v of [undefined, '', '10', '1000', 'abc', '-25', '0']) assert.equal(velikostStranky(v), 25, JSON.stringify(v));
    assert.equal(velikostStranky('1000', 50), 50, 'neznámá hodnota je výchozí seznamu');
  });
});

describe('výpočet stránky', () => {
  const pripady = [
    // stránka, celkem, na stránku → stránka, stran, offset, od, do
    [1, 0, 25, 1, 1, 0, 0, 0],
    [5, 0, 25, 1, 1, 0, 0, 0],
    [1, 25, 25, 1, 1, 0, 1, 25],
    [2, 25, 25, 1, 1, 0, 1, 25],
    [2, 26, 25, 2, 2, 25, 26, 26],
    [3, 61, 25, 3, 3, 50, 51, 61],
    [999, 61, 25, 3, 3, 50, 51, 61],
    [2, 120, 50, 2, 3, 50, 51, 100],
  ];
  for (const [page, celkem, naStranku, strana, pocetStran, offset, od, po] of pripady) {
    test(`page=${page}, celkem ${celkem}, po ${naStranku}`, () => {
      const s = seznam({ page: String(page) }, celkem, { naStranku });
      assert.deepEqual([s.strana, s.pocetStran, s.offset, s.od, s.do], [strana, pocetStran, offset, od, po]);
    });
  }

  test('page=abc a obří číslo: nikdy NaN ani offset mimo rozsah', () => {
    assert.equal(seznam({ page: 'abc' }, 61).offset, 0);
    const s = seznam({ page: '99999999999999999999' }, 61);
    assert.equal(s.strana, 3);
    assert.equal(s.offset, 50);
  });

  test('stránky pokryjí každý řádek právě jednou', () => {
    for (const naStranku of VELIKOSTI) {
      for (const celkem of [0, 1, 24, 25, 26, 49, 50, 51, 99, 100, 101, 130, 250]) {
        const videno = new Array(celkem).fill(0);
        const stran = seznam({}, celkem, { naStranku }).pocetStran;
        for (let p = 1; p <= stran; p++) {
          const s = seznam({ page: String(p) }, celkem, { naStranku });
          for (let i = s.offset; i < Math.min(s.offset + s.naStranku, celkem); i++) videno[i]++;
        }
        assert.ok(videno.every(n => n === 1), `celkem ${celkem}, po ${naStranku}`);
      }
    }
  });

  test('?velikost= přepíše výchozí, jen z nabídky', () => {
    assert.equal(seznam({ velikost: '100' }, 500).naStranku, 100);
    assert.equal(seznam({ velikost: '7' }, 500).naStranku, 25);
    assert.equal(seznam({}, 500, { naStranku: 50 }).naStranku, 50);
  });
});

describe('okno stran', () => {
  test('do 7 stran všechna čísla', () => {
    assert.deepEqual(oknoStran(1, 1), [1]);
    assert.deepEqual(oknoStran(4, 7), [1, 2, 3, 4, 5, 6, 7]);
  });

  test('přesné výstupy pro delší seznam', () => {
    assert.deepEqual(oknoStran(1, 20), [1, 2, null, 20]);
    assert.deepEqual(oknoStran(4, 20), [1, 2, 3, 4, 5, null, 20]);
    assert.deepEqual(oknoStran(10, 20), [1, null, 9, 10, 11, null, 20]);
    assert.deepEqual(oknoStran(20, 20), [1, null, 19, 20]);
  });

  test('vždy první, poslední a aktuální, roste, mezera nikdy nezastupuje jedinou stranu, nejvýš 7 položek', () => {
    for (let pocet = 1; pocet <= 200; pocet++) {
      for (let strana = 1; strana <= pocet; strana++) {
        const okno = oknoStran(strana, pocet);
        const cisla = okno.filter(c => c !== null);
        assert.ok(cisla.includes(1) && cisla.includes(pocet) && cisla.includes(strana));
        assert.ok(okno.length <= 7, `${strana}/${pocet}: ${okno}`);
        for (let i = 1; i < cisla.length; i++) assert.ok(cisla[i] > cisla[i - 1]);
        okno.forEach((c, i) => {
          if (c === null) assert.ok(okno[i + 1] - okno[i - 1] > 2, `${strana}/${pocet}: ${okno}`);
        });
      }
    }
  });
});

describe('odkazy stran', () => {
  test('drží filtry, první stránka bez page, prázdné vynechá', () => {
    const s = seznam({ q: 'abc', status: '', page: '2' }, 100, { zachovat: ['q', 'status'] });
    assert.equal(s.odkaz(3), '/seznam?q=abc&page=3');
    assert.equal(s.odkaz(1), '/seznam?q=abc');
    assert.equal(s.aktualni, '/seznam?q=abc&page=2');
  });

  test('bez filtrů je první stránka čistá adresa', () => {
    const s = seznam({}, 100);
    assert.equal(s.odkaz(1), '/seznam');
    assert.equal(s.aktualni, '/seznam');
  });

  test('hodnoty se znaky přežijí cestu přes URL', () => {
    for (const q of ['a&b=c', '50 %', 'R+D', 'č ř', '"x"', '#y', "o'neil"]) {
      const adresa = seznam({ q, page: '1' }, 100, { zachovat: ['q'] }).odkaz(2);
      assert.equal(new URL(adresa, 'http://x').searchParams.get('q'), q);
      assert.equal(new URL(adresa, 'http://x').searchParams.get('page'), '2');
    }
  });

  test('jednorázové parametry se nepřenášejí', () => {
    const s = seznam({ q: 'a', saved: '1', error: 'x', formError: 'y', sent: '1', expedice: 'z', upravit: '1' }, 100, { zachovat: ['q'] });
    for (const a of [s.odkaz(2), s.aktualni, s.odkazVelikost(50)]) {
      for (const k of ['saved', 'error', 'formError', 'sent', 'expedice', 'upravit']) assert.ok(!a.includes(k), a);
    }
  });

  test('pole v dotazu se neslije: ?q=a&q=b bere první', () => {
    const s = seznam({ q: ['a', 'b'] }, 100, { zachovat: ['q'] });
    assert.equal(s.odkaz(2), '/seznam?q=a&page=2');
  });

  test('velikost: odkazy ji drží, výchozí se do adresy nepíše, změna vrací na první stránku', () => {
    const s = seznam({ velikost: '50', page: '2' }, 500);
    assert.equal(s.odkaz(3), '/seznam?velikost=50&page=3');
    assert.equal(s.odkazVelikost(100), '/seznam?velikost=100');
    assert.equal(s.odkazVelikost(25), '/seznam');
  });

  test('pevné parametry routy jsou první a nezávisí na dotazu', () => {
    const s = seznam({}, 100, { pevne: { tab: 'faktury' } });
    assert.equal(s.odkaz(2), '/seznam?tab=faktury&page=2');
    assert.equal(s.aktualni, '/seznam?tab=faktury');
  });
});

describe('patička seznamu', () => {
  test('bez řádků se nevykreslí nic', async () => {
    assert.equal((await vykresli(seznam({}, 0))).trim(), '');
  });

  test('jedna stránka: rozsah bez navigace', async () => {
    const html = await vykresli(seznam({}, 12));
    assert.match(html, /<strong>1–12<\/strong> z <strong>12<\/strong>/);
    assert.ok(!html.includes('<nav'));
    assert.ok(!html.includes('strankovani-velikost'), '12 řádků se vejde na nejmenší stránku');
    assert.ok(html.includes('data-seznam="/seznam"'));
  });

  test('první ze tří: aktuální je 1, Předchozí není odkaz, Další vede na druhou', async () => {
    const html = await vykresli(seznam({}, 61));
    assert.match(html, /<span class="strankovani-cislo" aria-current="page">1<\/span>/);
    assert.match(html, /<span class="strankovani-krok" aria-disabled="true">[^]*?Předchozí<\/span>/);
    assert.match(html, /<a class="strankovani-krok" rel="next" href="\/seznam\?page=2">/);
    assert.ok(!html.includes('rel="prev"'));
    assert.equal(html.match(/aria-current="page"/g).length, 1);
  });

  test('prostřední má oba směry, poslední jen zpět', async () => {
    let html = await vykresli(seznam({ page: '2' }, 61));
    assert.ok(html.includes('rel="prev" href="/seznam"'), 'první stránka je čistá adresa');
    assert.ok(html.includes('rel="next" href="/seznam?page=3"'));
    html = await vykresli(seznam({ page: '3' }, 61));
    assert.ok(html.includes('rel="prev"'));
    assert.ok(!html.includes('rel="next"'));
    assert.match(html, /<strong>51–61<\/strong> z <strong>61<\/strong>/);
  });

  test('dlouhý seznam: výpustka bez odkazu, pozice pro telefon', async () => {
    const html = await vykresli(seznam({ page: '10' }, 500));
    assert.equal(html.match(/strankovani-vypustka/g).length, 2);
    assert.ok(html.includes('<span class="strankovani-pozice">10 / 20</span>'));
  });

  test('velikost: odkazy na ostatní, aktuální je text', async () => {
    const html = await vykresli(seznam({ velikost: '50' }, 500));
    assert.match(html, /<span class="strankovani-volba" aria-current="true">50<\/span>/);
    assert.ok(html.includes('<a class="strankovani-volba" href="/seznam">25</a>'));
    assert.ok(html.includes('<a class="strankovani-volba" href="/seznam?velikost=100">100</a>'));
  });

  test('tisíce se oddělují, rozsah má krátkou pomlčku', async () => {
    const html = await vykresli(seznam({ page: '41' }, 1234));
    assert.ok(/<strong>1[\s ]001–1[\s ]025<\/strong> z <strong>1[\s ]234<\/strong>/.test(html), html);
    assert.ok(!html.includes('\u2014'));
  });

  test('útočná hodnota filtru se v odkazu escapuje a zůstane stejná', async () => {
    const q = '"><img src=x onerror=alert(1)>&x=1';
    const html = await vykresli(seznam({ q, page: '2' }, 100, { zachovat: ['q'] }));
    assert.ok(!html.includes('<img'), 'žádná surová značka');
    const href = /rel="next" href="([^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
    assert.equal(new URL(href, 'http://x').searchParams.get('q'), q);
  });

  test('žádný formulář ani obsluha v atributu: patička smí ležet uvnitř formuláře', async () => {
    const html = await vykresli(seznam({ page: '2' }, 500));
    assert.ok(!html.includes('<form'));
    assert.ok(!/\son\w+=/.test(html));
  });

  test('použité třídy existují ve stylech', async () => {
    const css = readFileSync(fileURLToPath(new URL('../public/css/components.css', import.meta.url)), 'utf8');
    const html = await vykresli(seznam({ page: '10' }, 500));
    for (const [, tridy] of html.matchAll(/class="([^"]+)"/g)) {
      for (const t of tridy.split(/\s+/)) assert.ok(css.includes(`.${t}`), t);
    }
  });
});

describe('návratová adresa', () => {
  test('cesta v aplikaci projde i s diakritikou a znaky filtru', () => {
    for (const v of ['/ucetnictvi/prijate-faktury', '/ucetnictvi/prijate-faktury?q=%C4%8D+a&page=7']) {
      assert.equal(bezpecnyNavrat(v, '/vychozi'), v);
    }
    assert.equal(bezpecnyNavrat('/prace/ukoly?q=č ř&vse=1', '/vychozi'), '/prace/ukoly?q=%C4%8D%20%C5%99&vse=1', 'hlavička Location smí jen ASCII');
    assert.equal(bezpecnyNavrat('/a?q=😀', '/vychozi'), '/a?q=%F0%9F%98%80');
    assert.equal(bezpecnyNavrat('/a?q=\ud800', '/vychozi'), '/vychozi', 'neplatné UTF-16 nespadne');
  });

  test('cizí web a nesmysl dají výchozí', () => {
    for (const v of ['https://evil.example', '//evil.example', '/\\evil.example', '\\\\evil.example', 'evil.example', '', ' /x', '/x\ny', '/\tevil.example', '/x\\y', undefined, null, 5, {}, []]) {
      assert.equal(bezpecnyNavrat(v, '/vychozi'), '/vychozi', JSON.stringify(v));
    }
  });

  test('pole z dvojitého parametru: první hodnota', () => {
    assert.equal(bezpecnyNavrat(['/a', '/b'], '/vychozi'), '/a');
    assert.equal(bezpecnyNavrat(['//evil.example', '/b'], '/vychozi'), '/vychozi');
  });
});

describe('klíč záložky', () => {
  const seznamZalozek = [['a', 'A'], ['b', 'B', 'formB']];
  test('známý klíč zůstane, neznámý i pole padá na první', () => {
    assert.equal(zalozka(seznamZalozek, 'b'), 'b');
    for (const v of ['x', '', undefined, null, ['b', 'a'], {}, '__proto__', 'constructor']) {
      assert.equal(zalozka(seznamZalozek, v), 'a', JSON.stringify(v));
    }
  });
});

describe('tón stavu', () => {
  test('známé stavy mají tón, ostatní neutrální, ani názvy z prototypu nic neudělají', () => {
    assert.equal(tonStavu('Zaplacena'), 'ok');
    assert.equal(tonStavu('Po splatnosti'), 'chyba');
    assert.equal(tonStavu('Nezaplacena'), 'varovani');
    assert.equal(tonStavu('Storno'), 'neutral');
    for (const v of ['Něco', '', undefined, null, 'constructor', '__proto__']) assert.equal(tonStavu(v), 'neutral');
  });
});
