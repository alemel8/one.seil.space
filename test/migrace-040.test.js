// Migrace 040 poběží při startu nad živou databází, na které visí Toneráček.
// Hlídá se tu, co z ní dělá bezpečnou změnu, aby to pozdější úprava souboru
// nerozbila potichu:
//
//  - jen přidává (CREATE/ADD COLUMN … IF NOT EXISTS, komentáře), nic nemaže,
//    nemění typy ani výchozí hodnoty a nepřepisuje data;
//  - lock_timeout nejvýš 2 s;
//  - `shops` (čte ho každý požadavek Toneráčku) se zamyká výhradně až na
//    konci — výhradní zámek se pak drží milisekundy do COMMIT, ne po dobu
//    čekání na zámky ostatních tabulek.
//
// Databázi nepotřebuje.
//
//   node --test test/migrace-040.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOUBOR = new URL('../migrations/040_eshop_api_a_ucty_po_eshopech.sql', import.meta.url);

/** Příkazy bez komentářů, každý na jednom řádku. */
function prikazy() {
  return readFileSync(SOUBOR, 'utf8')
    .split('\n').map((radek) => radek.replace(/--.*$/, '')).join('\n')
    .split(';').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

test('migrace 040 jen přidává', () => {
  for (const p of prikazy()) {
    assert.match(p, /^(SET LOCAL lock_timeout|CREATE (TABLE|INDEX) IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS|COMMENT ON)/i,
      `nečekaný příkaz: ${p.slice(0, 80)}`);
    // „ON DELETE CASCADE“ u cizích klíčů nové tabulky je v pořádku.
    const bezCizichKlicu = p.replace(/ON DELETE (CASCADE|SET NULL)/gi, '');
    assert.doesNotMatch(bezCizichKlicu, /\b(DROP|TRUNCATE|UPDATE|DELETE|RENAME)\b|ALTER COLUMN|SET DEFAULT|\bTYPE\b/i,
      `nic nemaže, nepřejmenovává ani nemění existující sloupce: ${p.slice(0, 80)}`);
  }
});

test('lock_timeout nejvýš 2 s', () => {
  const [nastaveni] = prikazy().filter((p) => /^SET LOCAL lock_timeout/i.test(p));
  assert.ok(nastaveni, 'migrace nastavuje lock_timeout');
  const [, cislo, jednotka = 'ms'] = nastaveni.match(/'(\d+)\s*(ms|s)?'/i);
  const ms = Number(cislo) * (jednotka.toLowerCase() === 's' ? 1000 : 1);
  assert.ok(ms > 0 && ms <= 2000, `lock_timeout ${ms} ms`);
  assert.equal(prikazy()[0], nastaveni, 'lock_timeout platí od prvního příkazu');
});

test('výhradní zámek na shops až úplně nakonec', () => {
  const vse = prikazy();
  const alter = vse.findIndex((p) => /^ALTER TABLE shops\b/i.test(p));
  assert.ok(alter > 0, 'migrace přidává shops.webhook_secret');
  const potom = vse.slice(alter + 1);
  assert.ok(potom.every((p) => /^COMMENT ON COLUMN shops\./i.test(p)),
    `po ALTER TABLE shops smí být jen komentář k jeho sloupci, ne: ${potom.find((p) => !/^COMMENT ON COLUMN shops\./i.test(p))}`);
});
