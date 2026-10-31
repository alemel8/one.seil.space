// Porovnání dodavatele při importu z POHODY: omyl tady přepíše cizí fakturu
// nebo jí změní stav úhrady, proto se testuje bez databáze a bez XLSX.
//
//   node --test test/import-dodavatel.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { porovnejDodavatele } from '../scripts/lib/dodavatel.js';

const radek = (supplier, supplier_ico) => ({ supplier, supplier_ico });
const doklad = (name, ico) => ({ name, ico });

test('obě IČO: rozhoduje jen IČO, i v jiném zápisu a bez úvodních nul', () => {
  assert.equal(porovnejDodavatele(radek('Alfa', '11111111'), doklad('Beta', '11111111')), 'stejny');
  assert.equal(porovnejDodavatele(radek('Alfa', '012 345 67'), doklad('Alfa', '1234567')), 'stejny');
  assert.equal(porovnejDodavatele(radek('Alfa', '11111111'), doklad('Alfa', '22222222')), 'jiny', 'stejný název, různá IČO');
});

test('jedna strana bez IČO: shodný název je stejný dodavatel, jinak se nerozhoduje', () => {
  assert.equal(porovnejDodavatele(radek(' ALFA ', null), doklad('alfa', '11111111')), 'stejny');
  assert.equal(porovnejDodavatele(radek('Alfa', '11111111'), doklad('Beta', '')), 'nejisty');
  assert.equal(porovnejDodavatele(radek('Alfa', ''), doklad('Beta', '11111111')), 'nejisty');
});

test('bez IČO na obou stranách rozhoduje název, samé nuly znamenají bez IČO', () => {
  assert.equal(porovnejDodavatele(radek('Alfa', null), doklad('alfa ', '')), 'stejny');
  assert.equal(porovnejDodavatele(radek('Alfa', null), doklad('Beta', undefined)), 'jiny');
  assert.equal(porovnejDodavatele(radek('Alfa', '000'), doklad('Beta', '00000000')), 'jiny');
});
