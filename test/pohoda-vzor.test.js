// Vzor předkontace a členění DPH z předchozích dokladů téhož partnera
// (src/pohoda-vzor.js). Běží bez databáze:
//
//   node --test test/pohoda-vzor.test.js
//
// Data podle exportu POHODY ze 14. 11. 2026: Anthropic je v POHODĚ pod několika
// názvy a bez IČO, nová faktura z Disku ho musí najít podle názvu nebo podle
// předpony čísla ze Stripe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { najdiVzor, stejnyPartner } from '../src/pohoda-vzor.js';

const prijata = (supplier, number, navic = {}) => ({
  id: number, type: 'received', number, supplier, supplier_ico: '', supplier_number: '', vat_amount: 0, ...navic,
});
const zPohody = (supplier, number, supplier_number, predkontace, cleneni, navic = {}) =>
  prijata(supplier, number, { supplier_number, pohoda_predkontace: predkontace, pohoda_cleneni_dph: cleneni, ...navic });

const historie = [
  zPohody('Anthropic, PBC @anthropic548 Market Street', '261100120', 'IM69EW9T-0011', '11Fp', 'bez', { internal_number: 'PF26-0121' }),
  zPohody('Anthropic, PBC @anthropic548 Market Street', '261100116', '9BF0758D-9552734', '11Fp', 'bez'),
  zPohody('Twilio Ireland Limited', '261100110', 'SID AC7d1c', '2Fp', 'bez'),
  zPohody('WEDOS Internet, a.s.', '261100114', '7526341906', '13Fp', 'PD', { supplier_ico: '28115708', vat_amount: 46.2 }),
];

test('Anthropic z Disku najde předchozí fakturu podle začátku názvu', () => {
  const vzor = najdiVzor(prijata('Anthropic, PBC', 'IM69EW9T-0034'), historie);
  assert.deepEqual(vzor, { predkontace: '11Fp', cleneni: 'bez', cislo: 'PF26-0121' });
});

test('jiný název, ale stejná předpona čísla ze Stripe', () => {
  const vzor = najdiVzor(prijata('Anthropic Ireland, Limited', '9BF0758D-12647992'), historie);
  assert.equal(vzor?.predkontace, '11Fp');
});

test('IČO rozhoduje samo: shodné spojí i jinak zapsaný název, různé nikdy', () => {
  assert.equal(najdiVzor(prijata('WEDOS', '1', { supplier_ico: 'CZ28115708', vat_amount: 21 }), historie)?.predkontace, '13Fp');
  assert.equal(najdiVzor(prijata('WEDOS Internet, a.s.', '2', { supplier_ico: '12345678', vat_amount: 21 }), historie), null);
});

test('krátký název nestačí jako předpona jiného', () => {
  assert.equal(stejnyPartner(prijata('Alza', '1'), prijata('Alza.cz a.s.', '2')), false);
  assert.equal(stejnyPartner(prijata('Alza.cz a.s.', '1'), prijata('ALZA.CZ, a. s.', '2')), true);
});

test('neznámý dodavatel vzor nemá', () => {
  assert.equal(najdiVzor(prijata('Meta Platforms Ireland Limited', 'FBADS-706-106668697'), historie), null);
});

test('členění se nepřevezme, když jeden doklad DPH má a druhý ne', () => {
  const sDph = najdiVzor(prijata('Twilio Ireland Limited', 'X1', { vat_amount: 2.52 }), historie);
  assert.deepEqual([sDph.predkontace, sDph.cleneni], ['2Fp', '']);
  const bezDph = najdiVzor(prijata('WEDOS Internet, a.s.', 'X2', { supplier_ico: '28115708' }), historie);
  assert.deepEqual([bezDph.predkontace, bezDph.cleneni], ['13Fp', '']);
});

test('vydaná faktura hledá podle odběratele a jen mezi vydanými', () => {
  const vydane = [
    { id: 'a', type: 'issued', number: '21260020', client_name: 'LASVIT s.r.o.', client_ico: '27129121', vat_amount: 0, pohoda_predkontace: 'L', pohoda_cleneni_dph: 'UDA4' },
  ];
  const nova = { id: 'b', type: 'issued', number: '21260027', client_name: 'Lasvit', client_ico: '27129121', vat_amount: 0 };
  assert.equal(najdiVzor(nova, vydane)?.predkontace, 'L');
  assert.equal(najdiVzor(nova, historie), null);
});

test('doklad sám sobě vzorem není', () => {
  const sam = zPohody('Twilio Ireland Limited', '261100110', 'SID AC7d1c', '2Fp', 'bez');
  assert.equal(najdiVzor(sam, [sam]), null);
});
