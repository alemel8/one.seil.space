// Rozložení aplikace (views/layouts/base.ejs) bez serveru i databáze:
// šablona se vykreslí přímo přes EJS s napodobeným uživatelem. Hlídá jen
// to, co by se v prohlížeči projevilo — pořadí inline skriptu proti stylům
// a filtrování menu podle přístupové matice.
//
//   node --test test/layout-sidebar.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const base = fileURLToPath(new URL('../views/layouts/base.ejs', import.meta.url));

function uzivatel(prepis = {}) {
  return {
    id: 1, is_admin: true, first_name: 'Test', last_name: 'Správce', email: 't@example.invalid',
    photo: null, bezici_mereni: null, can: () => true, canSection: () => true, ...prepis,
  };
}

const vykresli = (user, currentPath = '/') =>
  ejs.renderFile(base, { body: '<p>obsah</p>', pageTitle: 'Test', currentPath, user });

test('téma i stav menu se nastaví dřív, než se načte první stylesheet', async () => {
  const html = await vykresli(uzivatel());
  const tema = html.indexOf("getItem('seil-theme')");
  const menu = html.indexOf("getItem('seil-sidebar')");
  const styl = html.indexOf('rel="stylesheet"');
  assert.ok(tema > 0 && menu > 0 && styl > 0, 'skript i stylesheet jsou v hlavičce');
  assert.ok(tema < styl && menu < styl, 'inline skript stojí před prvním <link rel="stylesheet">');
});

test('přepínač menu je v liště vždy a sidebar nese obě značky', async () => {
  const html = await vykresli(uzivatel());
  const tlacitko = html.match(/<button class="topbar-hamburger"[^>]*>/)?.[0];
  assert.ok(tlacitko, 'tlačítko #sidebarToggle existuje');
  assert.match(tlacitko, /aria-controls="sidebar"/);
  assert.doesNotMatch(tlacitko, /aria-expanded/, 'aria-expanded nastaví až JS podle skutečného stavu');
  assert.ok(html.includes('/static/img/logo-white.png'), 'wordmark pro rozbalené menu');
  assert.ok(html.includes('/static/img/znak.png'), 'znak pro sbalený pruh');
});

test('menu ukazuje jen sekce, které uživatel smí', async () => {
  const html = await vykresli(uzivatel({
    is_admin: false,
    can: k => k.startsWith('prace'),
    canSection: k => k === 'prace',
  }), '/prace');
  assert.ok(html.includes('Můj čas'), 'povolená sekce je vidět');
  for (const text of ['Domovská stránka', 'Projekty', 'Monitoring', 'Účetnictví', 'CRM', 'Marketing', 'Nastavení', 'Lidé &amp; Kultura']) {
    assert.ok(!html.includes(`<span class="nav-label">${text}</span>`), `${text} v menu není`);
  }
});
