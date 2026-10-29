// Jednotkový test šifrování tokenů platforem — běží bez databáze i serveru:
//
//   node --test test/marketing-tajemstvi.test.js
//
// Hlídá, že token po zašifrování a dešifrování vyjde stejný (i s diakritikou
// a prázdný), že se bez klíče, s jiným klíčem nebo s poškozeným řádkem nic
// tiše nevrátí — jen česká chyba, podle které obsluha pozná, co se stalo —,
// a že otisk je stabilních 8 hex znaků SHA-256 jako u klíčů e-shopů.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TajemstviError, desifruj, maKlic, otiskTajemstvi, zasifruj } from '../src/marketing/tajemstvi.js';

const PUVODNI = process.env.MARKETING_SECRETS_KEY;
const KLIC_A = crypto.randomBytes(32).toString('hex');
const KLIC_B = crypto.randomBytes(32).toString('hex');

beforeEach(() => { process.env.MARKETING_SECRETS_KEY = KLIC_A; });
after(() => {
  if (PUVODNI === undefined) delete process.env.MARKETING_SECRETS_KEY;
  else process.env.MARKETING_SECRETS_KEY = PUVODNI;
});

/** Poškodí jednu část uloženého tajemství (0 = verze, 1 = iv, 2 = tag, 3 = data). */
function poskod(enc, index) {
  const casti = enc.split(':');
  const buf = Buffer.from(casti[index], 'base64');
  buf[0] ^= 0xff;
  casti[index] = buf.toString('base64');
  return casti.join(':');
}

describe('šifrování a dešifrování', () => {
  test('token projde tam a zpět, i s diakritikou, dlouhý i prázdný', () => {
    for (const text of ['sk_live_abc123', 'žluťoučký kůň 🐎', 'x'.repeat(5000), '']) {
      assert.equal(desifruj(zasifruj(text)), text);
    }
  });

  test('uložený tvar je v1:<iv>:<tag>:<data> s 12bajtovým IV a 16bajtovým tagem', () => {
    const enc = zasifruj('token');
    const casti = enc.split(':');
    assert.equal(casti.length, 4);
    assert.equal(casti[0], 'v1');
    assert.equal(Buffer.from(casti[1], 'base64').length, 12);
    assert.equal(Buffer.from(casti[2], 'base64').length, 16);
    assert.equal(Buffer.from(casti[3], 'base64').length, 5);
    assert.equal(enc.includes('token'), false);
  });

  test('dvojí zašifrování téhož textu dá různé řádky (náhodný IV), oba jdou dešifrovat', () => {
    const a = zasifruj('token');
    const b = zasifruj('token');
    assert.notEqual(a, b);
    assert.equal(desifruj(a), 'token');
    assert.equal(desifruj(b), 'token');
  });

  test('jiný klíč token nedešifruje a řekne proč', () => {
    const enc = zasifruj('token');
    process.env.MARKETING_SECRETS_KEY = KLIC_B;
    assert.throws(() => desifruj(enc), (e) => e instanceof TajemstviError
      && e.message === 'token nelze dešifrovat — změnil se MARKETING_SECRETS_KEY?');
  });

  test('poškozený tag, data i IV skončí stejnou chybou jako cizí klíč', () => {
    const enc = zasifruj('token');
    for (const index of [1, 2, 3]) {
      assert.throws(() => desifruj(poskod(enc, index)), /token nelze dešifrovat — změnil se MARKETING_SECRETS_KEY\?/, `část ${index}`);
    }
  });

  test('cizí tvar (bez verze, málo částí, špatné délky) je chyba tvaru, ne klíče', () => {
    for (const enc of ['', 'token', 'v2:a:b:c', 'v1:a:b', 'v1:AAAA:AAAA:AAAA', null, undefined, 42]) {
      assert.throws(() => desifruj(enc), (e) => e instanceof TajemstviError && /neznámý tvar/.test(e.message), String(enc));
    }
  });
});

describe('klíč z prostředí', () => {
  test('maKlic pozná 64 hex znaků, i s okolními mezerami', () => {
    assert.equal(maKlic(), true);
    process.env.MARKETING_SECRETS_KEY = `  ${KLIC_A}\n`;
    assert.equal(maKlic(), true);
    assert.equal(desifruj(zasifruj('t')), 't');
    process.env.MARKETING_SECRETS_KEY = KLIC_A.slice(0, 63);
    assert.equal(maKlic(), false);
    process.env.MARKETING_SECRETS_KEY = 'g'.repeat(64);
    assert.equal(maKlic(), false);
    delete process.env.MARKETING_SECRETS_KEY;
    assert.equal(maKlic(), false);
  });

  test('bez klíče nejde šifrovat ani dešifrovat a chyba jmenuje proměnnou', () => {
    delete process.env.MARKETING_SECRETS_KEY;
    assert.throws(() => zasifruj('t'), (e) => e instanceof TajemstviError && /MARKETING_SECRETS_KEY není nastaveno/.test(e.message));
    assert.throws(() => desifruj('v1:a:b:c'), /MARKETING_SECRETS_KEY není nastaveno/);
  });

  test('klíč špatné délky nebo s ne-hex znaky se odmítne s délkou v hlášce', () => {
    process.env.MARKETING_SECRETS_KEY = 'abc';
    assert.throws(() => zasifruj('t'), /MARKETING_SECRETS_KEY musí mít 64 hex znaků \(32 bajtů\), má 3/);
    process.env.MARKETING_SECRETS_KEY = 'z'.repeat(64);
    assert.throws(() => zasifruj('t'), /musí mít 64 hex znaků/);
  });

  test('klíč se čte při každém volání — změna za běhu platí hned', () => {
    const enc = zasifruj('t');
    process.env.MARKETING_SECRETS_KEY = KLIC_B;
    const enc2 = zasifruj('t');
    assert.throws(() => desifruj(enc));
    assert.equal(desifruj(enc2), 't');
  });
});

describe('otisk', () => {
  test('8 hex znaků SHA-256, stabilní, bez klíče', () => {
    delete process.env.MARKETING_SECRETS_KEY;
    const otisk = otiskTajemstvi('sk_live_abc123');
    assert.match(otisk, /^[0-9a-f]{8}$/);
    assert.equal(otisk, crypto.createHash('sha256').update('sk_live_abc123', 'utf8').digest('hex').slice(0, 8));
    assert.equal(otiskTajemstvi('sk_live_abc123'), otisk);
    assert.notEqual(otiskTajemstvi('sk_live_abc124'), otisk);
  });

  test('prázdné tajemství nemá otisk', () => {
    assert.equal(otiskTajemstvi(''), '');
    assert.equal(otiskTajemstvi(null), '');
    assert.equal(otiskTajemstvi(undefined), '');
  });
});
