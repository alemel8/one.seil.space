// Pomocník testů marketingu: přečte migrations/042_marketing.sql, když už
// v repozitáři je, a vytáhne z ní sloupce tabulek. Migraci píše jiný krok —
// testy, které ji chtějí, se bez ní přeskočí (`t.skip`), místo aby názvy
// a typy sloupců hádaly. Jakmile je migrace v repozitáři, hlídá se, že
// METRIKY, číselníky a SELECTy v kpi.js sedí na skutečné schéma: překlep
// ve sloupci by se jinak ukázal až jako 500 na prvním /marketing.
//
// Spouští se jen přes testy: node --test test/marketing-*.test.js

import { readFileSync } from 'node:fs';

const CESTA = new URL('../../../migrations/042_marketing.sql', import.meta.url);

/** Text migrace, nebo null, když v repozitáři ještě není. */
export function nactiMigraci042() {
  try {
    return readFileSync(CESTA, 'utf8');
  } catch {
    return null;
  }
}

/** Tělo `CREATE TABLE IF NOT EXISTS <tabulka> (…)` po závěrečné `);`, nebo null. */
export function blokTabulky(text, tabulka) {
  const zacatek = (text ?? '').indexOf(`CREATE TABLE IF NOT EXISTS ${tabulka} (`);
  if (zacatek < 0) return null;
  const konec = text.indexOf('\n);', zacatek);
  return konec < 0 ? null : text.slice(zacatek, konec);
}

/**
 * `{ sloupec: 'NUMERIC(12,2)' | 'INTEGER' | 'TEXT' | … }` z těla tabulky.
 * Řádky CHECK, CONSTRAINT a UNIQUE (velkými písmeny) se přeskočí.
 */
export function sloupceTabulky(blok) {
  const sloupce = {};
  for (const radek of (blok ?? '').split('\n').slice(1)) {
    const m = radek.match(/^\s+([a-z_]+)\s+([A-Z]+(?:\(\d+(?:,\s*\d+)?\))?)/);
    if (m) sloupce[m[1]] = m[2];
  }
  return sloupce;
}

/** Hodnoty z `CHECK (<sloupec> IN ('a', 'b'))` v těle tabulky, nebo null. */
export function hodnotyCheck(blok, sloupec) {
  const m = (blok ?? '').match(new RegExp(`CHECK \\(${sloupec} IN \\(([^)]*)\\)`));
  return m ? m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')) : null;
}

/** Sloupce přidané `ALTER TABLE <tabulka> ADD COLUMN IF NOT EXISTS <sloupec>` (shop_orders, shop_order_items, shops). */
export function pridaneSloupce(text, tabulka) {
  const sloupce = [];
  const prikazy = (text ?? '').matchAll(new RegExp(`ALTER TABLE ${tabulka}\\b([^;]*);`, 'g'));
  for (const [, telo] of prikazy) {
    for (const [, sloupec] of telo.matchAll(/ADD COLUMN IF NOT EXISTS\s+([a-z_]+)/g)) sloupce.push(sloupec);
  }
  return sloupce;
}
