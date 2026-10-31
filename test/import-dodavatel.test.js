// Rozhodování importu z POHODY: omyl tady přepíše cizí fakturu nebo založí druhý
// řádek téhož dokladu, proto se testuje bez databáze a bez XLSX.
//
//   node --test test/import-dodavatel.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { porovnejDodavatele, posudCislo, posudVs } from '../scripts/lib/dodavatel.js';

const radek = (supplier, supplier_ico, navic = {}) => ({ id: 'x', supplier, supplier_ico, issue_date: '2026-03-01', total_amount: '1210.00', ...navic });
const doklad = (name, ico, navic = {}) => ({ name, ico, issueDate: '2026-03-01', total: 1210, ...navic });
const jinyDoklad = { issue_date: '2026-01-01', total_amount: '500.00' };

test('obě IČO: rozhoduje jen IČO, i v jiném zápisu, s předponou CZ a bez úvodních nul', () => {
  assert.equal(porovnejDodavatele(radek('Alfa', '11111111'), doklad('Beta', '11111111')), 'stejny');
  assert.equal(porovnejDodavatele(radek('Alfa', '012 345 67'), doklad('Alfa', '1234567')), 'stejny');
  assert.equal(porovnejDodavatele(radek('Alfa', 'cz11111111'), doklad('Beta', '11111111')), 'stejny');
  assert.equal(porovnejDodavatele(radek('Alfa', '11111111'), doklad('Alfa', '22222222')), 'jiny', 'stejný název, různá IČO');
});

test('jedna strana bez IČO: shodný název je stejný dodavatel, jinak se nerozhoduje', () => {
  assert.equal(porovnejDodavatele(radek(' ALFA ', null), doklad('alfa', '11111111')), 'stejny');
  assert.equal(porovnejDodavatele(radek('Alfa', '11111111'), doklad('Beta', '')), 'nejisty');
  assert.equal(porovnejDodavatele(radek('Alfa', ''), doklad('Beta', '11111111')), 'nejisty');
});

test('bez IČO na obou stranách rozhoduje název, samé nuly a samotné CZ znamenají bez IČO', () => {
  assert.equal(porovnejDodavatele(radek('Alfa', null), doklad('alfa ', '')), 'stejny');
  assert.equal(porovnejDodavatele(radek('Alfa', null), doklad('Beta', undefined)), 'jiny');
  assert.equal(porovnejDodavatele(radek('Alfa', '000'), doklad('Beta', '00000000')), 'jiny');
  assert.equal(porovnejDodavatele(radek('Alfa', 'CZ'), doklad('Beta', '')), 'jiny');
});

test('krok číslo: opravené IČO nebo název nezaloží druhý řádek, ani když se změnily údaje', () => {
  assert.equal(posudCislo([radek('Alfa', '28115709')], doklad('Alfa', '28115708')).akce, 'nejiste', 'opravené IČO');
  assert.equal(posudCislo([radek('Google Ireland Limited', null)], doklad('Google Ireland Ltd', '')).akce, 'nejiste', 'opravený název bez IČO');
  assert.equal(posudCislo([radek('Alfa', '28115709', jinyDoklad)], doklad('Alfa', '28115708')).akce, 'nejiste', 'IČO a částka, název sedí');
  assert.equal(posudCislo([radek('Limited', null, jinyDoklad)], doklad('Ltd', '')).akce, 'nejiste', 'název a datum, bez IČO');
  assert.equal(posudCislo([radek('Alfa', '11111111')], doklad('Beta', '22222222')).akce, 'nejiste', 'jiný dodavatel, stejné datum a částka');
});

test('krok číslo: jiné IČO, název i údaje je nová faktura', () => {
  const r = posudCislo([radek('Alfa', '11111111', jinyDoklad)], doklad('Beta', '22222222'));
  assert.equal(r.akce, 'nova');
  assert.equal(r.radky.length, 1, 'skript na ni upozorní');
  assert.equal(posudCislo([], doklad('Beta', '22222222')).akce, 'nova');
});

test('krok číslo: stejný dodavatel existuje, víc stejných a nejistý se přeskočí', () => {
  const alfa = radek('Alfa', '11111111');
  assert.deepEqual(posudCislo([alfa, radek('Beta', '22222222', jinyDoklad)], doklad('Alfa', '11111111')), { akce: 'existuje', radek: alfa });
  assert.equal(posudCislo([alfa, alfa], doklad('Alfa', '11111111')).akce, 'nejiste');
  assert.equal(posudCislo([radek('Alfa', '11111111', jinyDoklad)], doklad('Beta', '')).akce, 'nejiste');
});

test('krok VS: slučuje jen stejného dodavatele s podobnými údaji, cizí fakturu nepřepíše', () => {
  const alfa = radek('Alfa', '11111111');
  assert.deepEqual(posudVs([alfa, radek('Beta', '22222222', jinyDoklad)], doklad('Alfa', 'cz11111111')), { akce: 'sloucit', radek: alfa });
  assert.equal(posudVs([radek('Alfa', '11111111', { total_amount: '50.00' })], doklad('Alfa', '11111111')).akce, 'sloucit', 'stačí datum, částka může být v cizí měně');
  assert.equal(posudVs([radek('Alfa', '11111111', jinyDoklad)], doklad('Alfa', '11111111')).akce, 'nejiste', 'jiné datum i částka je jiný doklad, třeba VS rovný internímu číslu');
  assert.equal(posudVs([radek('Alfa', '11111111', jinyDoklad)], doklad('Beta', '22222222')).akce, 'zadna', 'různá IČO a jiné údaje');
  assert.equal(posudVs([], doklad('Beta', '22222222')).akce, 'zadna');
});

test('krok VS: různá IČO, ale stejné datum i částka se nezaloží, je to nejspíš tentýž doklad', () => {
  assert.equal(posudVs([radek('Jan Novak', 'CZ7001011234')], doklad('Jan Novak', '12345678')).akce, 'nejiste');
  assert.equal(posudVs([radek('Alfa', '11111111')], doklad('Beta', '22222222')).akce, 'nejiste');
  assert.equal(posudVs([radek('Alfa', '11111111', { total_amount: '50.00' })], doklad('Beta', '22222222')).akce, 'zadna', 'jen datum u různých IČO nestačí');
});

test('krok VS: bez IČO a s jiným názvem rozhodne člověk, jen když údaje aspoň zčásti sedí', () => {
  assert.equal(posudVs([radek('Google Ireland Ltd.', null)], doklad('Google Ireland Limited', '')).akce, 'nejiste');
  assert.equal(posudVs([radek('Google', null, { total_amount: '50.00' })], doklad('Alphabet', '')).akce, 'nejiste', 'cizí měna, sedí datum');
  assert.equal(posudVs([radek('Zeta', null, jinyDoklad)], doklad('Eta', '')).akce, 'zadna', 'jiné datum i částka je jiný dodavatel');
  assert.equal(posudVs([radek('Alfa', '11111111')], doklad('Beta', '')).akce, 'nejiste', 'jedna strana bez IČO');
  assert.equal(posudVs([radek('Google', null)], doklad('GOOGLE ', '')).akce, 'sloucit', 'jen velikost písmen');
});

test('krok VS: řádek z tohoto běhu není kandidát, je to samostatný doklad', () => {
  assert.equal(posudVs([radek('Alfa', '11111111', { id: null })], doklad('Alfa', '11111111')).akce, 'zadna');
});
