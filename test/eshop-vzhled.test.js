// Vzhled e-shopu v přehledech (src/eshop-vzhled.js): hodnoty z Nastavení →
// Eshopy jdou do atributů src a style, proto projdou kontrolou.
//
//   node --test test/eshop-vzhled.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VYCHOZI_BARVA, barvaEshopu, inicialaEshopu, logoEshopu, sVzhledem } from '../src/eshop-vzhled.js';

test('barva jen jako hex, jinak barva SEILu', () => {
  assert.equal(barvaEshopu('#0891b2'), '#0891b2');
  assert.equal(barvaEshopu(' #A85E56 '), '#A85E56');
  assert.equal(barvaEshopu('#abc'), '#abc');
  for (const spatne of ['', null, undefined, 'red', '#12345', '#0891b2;background:url(x)', 'var(--x)']) {
    assert.equal(barvaEshopu(spatne), VYCHOZI_BARVA, String(spatne));
  }
});

test('logo jen přes http(s)', () => {
  assert.equal(logoEshopu('https://toneracek.cz/images/logo.png'), 'https://toneracek.cz/images/logo.png');
  assert.equal(logoEshopu('http://example.invalid/a.png'), 'http://example.invalid/a.png');
  for (const spatne of ['', null, 'javascript:alert(1)', 'data:image/png;base64,AAAA', '/images/logo.png', 'nesmysl']) {
    assert.equal(logoEshopu(spatne), '', String(spatne));
  }
});

test('iniciála: první písmeno názvu bez www., velké', () => {
  assert.equal(inicialaEshopu('Toneráček.cz'), 'T');
  assert.equal(inicialaEshopu('www.dilnavlnenka.cz'), 'D');
  assert.equal(inicialaEshopu('  čajovna'), 'Č');
  assert.equal(inicialaEshopu(''), '?');
});

test('sVzhledem doplní barvu, logo a iniciálu a zbytek řádku nechá', () => {
  const e = sVzhledem({ id: 2, name: 'Dílna Vlněnka', color_primary: '#A85E56', logo_mark_url: 'https://dilnavlnenka.cz/znak.png' });
  assert.deepEqual(e, {
    id: 2, name: 'Dílna Vlněnka', color_primary: '#A85E56', logo_mark_url: 'https://dilnavlnenka.cz/znak.png',
    barva: '#A85E56', logo: 'https://dilnavlnenka.cz/znak.png', iniciala: 'D',
  });
});
