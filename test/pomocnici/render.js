// Vykreslení šablony detailu bez serveru a databáze (vzor
// test/layout-sidebar.test.js) a kontroly společné všem detailům s režimem
// úprav: obal nese data-rezim, tužka míří na formulář záznamu, formuláře se
// nevnořují a každý sloupec, který routa zapisuje, má ve formuláři pole —
// routy přepisují celý řádek, vypadlé pole by ho tiše vynulovalo.
//
//   import { vykresliStranku, zkontrolujDetail } from './pomocnici/render.js';

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { jenDatum, ceskeDatum } from '../../src/prazsky-cas.js';

const views = fileURLToPath(new URL('../../views/', import.meta.url));

/** Správce pro šablony: `user` i jeho práva. */
export function uzivatel(prepis = {}) {
  return {
    id: 1, public_id: 'abcdef123456', is_admin: true, first_name: 'Test', last_name: 'Správce',
    email: 't@example.invalid', photo: null, bezici_mereni: null, can: () => true, canSection: () => true, ...prepis,
  };
}

/**
 * Vykreslí stránku `pages/<cesta>.ejs` s danými locals (bez layoutu).
 * `rezimUprav` je v locals jako v routě; jenDatum/ceskeDatum dodává
 * server.js přes defaultContext, tady se přidávají stejně.
 */
export function vykresliStranku(cesta, locals) {
  return ejs.renderFile(`${views}pages/${cesta}.ejs`, { jenDatum, ceskeDatum, user: uzivatel(), ...locals });
}

/**
 * Společné kontroly detailu v jednom režimu.
 *   formular  id upravitelného formuláře (null = na stránce tužka být nemá)
 *   sloupce   name= polí, která routa čte z těla (viditelná i hidden)
 *   rezim     'zobrazeni' | 'upravy' — co má obal hlásit
 */
export function zkontrolujDetail(html, { formular, sloupce = [], rezim = 'zobrazeni' }) {
  assert.match(html, new RegExp(`data-rezim="${rezim}"`), `obal hlásí režim ${rezim}`);
  assert.ok(!/<form\b[^>]*>(?:(?!<\/form>)[\s\S])*<form\b/.test(html), 'žádný formulář není vnořený v jiném');

  if (!formular) {
    assert.ok(!html.includes('upravit-otevrit'), 'bez formuláře záznamu není tužka');
    return;
  }
  assert.ok(html.includes(`id="${formular}"`), `formulář ${formular} je na stránce`);
  assert.match(html, new RegExp(`<form[^>]*id="${formular}"[^>]*class="[^"]*\\bupravitelne\\b|<form[^>]*class="[^"]*\\bupravitelne\\b[^"]*"[^>]*id="${formular}"`), 'formulář záznamu má třídu upravitelne');
  assert.ok(html.includes(`form="${formular}" class="btn btn-primary upravit-ulozit"`), 'Uložit v hlavičce míří na formulář záznamu');
  assert.match(html, /class="btn btn-outline btn-ikona upravit-otevrit"[^>]*aria-label="Upravit"/, 'tužka je jen ikona s přístupným názvem');
  const pole = poleFormulare(html, formular);
  for (const name of sloupce) {
    assert.ok(pole.has(name), `pole ${name} patří formuláři ${formular} — routa ho zapisuje`);
  }
}

/**
 * name= prvků, které prohlížeč odešle s formulářem: leží uvnitř <form id=…>,
 * nebo na něj míří atributem form=. Prosté hledání name= na stránce by přehlédlo
 * vypadlé pole, když se stejně jmenuje pole v modalu (email, notes, name).
 */
function poleFormulare(html, formular) {
  const zacatek = html.search(new RegExp(`<form\\b[^>]*\\bid="${formular}"`));
  const konec = html.indexOf('</form>', zacatek);
  const pole = new Set();
  for (const m of html.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
    if (!name) continue;
    const cil = /\bform="([^"]*)"/.exec(m[0])?.[1];
    if (cil ? cil === formular : (m.index > zacatek && m.index < konec)) pole.add(name);
  }
  return pole;
}
