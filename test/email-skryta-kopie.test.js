// Skrytá kopie e-mailů (bccFor v src/email.js) – běží bez databáze i serveru:
//
//   node --test test/email-skryta-kopie.test.js
//
// Hlídá, že víc adres v EMAIL_BCC (nebo v shops.warehouse_email_bcc) odejde
// Resendu jako samostatné položky pole. Celý řetězec „a,b“ v jedné položce
// doručil kopii jen na první adresu.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bccFor } from '../src/email.js';

let puvodni;
beforeEach(() => { puvodni = process.env.EMAIL_BCC; });
afterEach(() => {
  if (puvodni === undefined) delete process.env.EMAIL_BCC;
  else process.env.EMAIL_BCC = puvodni;
});

describe('skrytá kopie', () => {
  it('rozdělí EMAIL_BCC s víc adresami na položky pole', () => {
    process.env.EMAIL_BCC = 'prvni@kopie.cz,druha@kopie.cz';
    assert.deepEqual(bccFor('customer', 'zakaznik@posta.cz'), ['prvni@kopie.cz', 'druha@kopie.cz']);
  });

  it('snese mezery, středník a prázdné položky', () => {
    process.env.EMAIL_BCC = ' prvni@kopie.cz ; druha@kopie.cz, ,';
    assert.deepEqual(bccFor('customer', 'zakaznik@posta.cz'), ['prvni@kopie.cz', 'druha@kopie.cz']);
  });

  it('vynechá adresu, která je zároveň příjemcem, a duplicity', () => {
    process.env.EMAIL_BCC = 'prvni@kopie.cz, Druha@Kopie.cz, druha@kopie.cz';
    assert.deepEqual(bccFor('customer', 'Jana <PRVNI@kopie.cz>'), ['Druha@Kopie.cz']);
  });

  it('jediná adresa, která je příjemcem, znamená bez kopie', () => {
    process.env.EMAIL_BCC = 'prvni@kopie.cz';
    assert.equal(bccFor('customer', 'prvni@kopie.cz'), undefined);
  });

  it('prázdné EMAIL_BCC je vypnuto', () => {
    process.env.EMAIL_BCC = '  ';
    assert.equal(bccFor('customer', 'zakaznik@posta.cz'), undefined);
    delete process.env.EMAIL_BCC;
    assert.equal(bccFor('customer', 'zakaznik@posta.cz'), undefined);
  });

  it('firemní pošta EMAIL_BCC nedostane, explicitní kopii ano a také rozdělenou', () => {
    process.env.EMAIL_BCC = 'prvni@kopie.cz';
    assert.equal(bccFor('company', 'sklad@posta.cz'), undefined);
    assert.deepEqual(
      bccFor('company', 'sklad@posta.cz', 'vedouci@kopie.cz, ucetni@kopie.cz'),
      ['vedouci@kopie.cz', 'ucetni@kopie.cz'],
    );
  });
});
