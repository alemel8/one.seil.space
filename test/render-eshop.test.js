// Detail e-shopu (views/pages/settings/shop-detail.ejs) vykreslený bez
// serveru a databáze: režim úprav na záložkách s formulářem záznamu, tužka
// jen tam, kde formulář je, a každý sloupec, který POST routy zapisují, má
// ve formuláři pole. Chování proti serveru hlídá test/eshop-nastaveni.test.js.
//
//   node --test test/render-eshop.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vykresliStranku, zkontrolujDetail } from './pomocnici/render.js';

const ZALOZKY = [
  ['zakladni',     'Základní informace', 'formZakladni'],
  ['identita',     'Identita e-mailů',   'formIdentita'],
  ['napojeni',     'Napojení e-shopu',   null],
  ['expedice',     'Expedice do skladu', 'formExpedice'],
  ['marketing',    'Marketing',          'formMarketing'],
  ['healthchecky', 'Healthchecky',       null],
];

const shop = {
  id: 7, slug: 'dilna', name: 'Dílna <Vlněnka>', url: 'https://dilna.example.invalid', active: true, created_at: new Date('2025-03-05T00:00:00Z'),
  email_from_name: 'Dílna', email_from_address: 'noreply@dilna.example.invalid', email_reply_to: '', support_email: '', support_phone: '', support_phone_link: '',
  tagline: '', claim: '', logo_mark_url: '', logo_wordmark_url: '', color_primary: '#0891b2', color_primary_dark: 'modrá', color_primary_light: '', color_on_primary_soft: '',
  warehouse_email: '', warehouse_email_bcc: '', warehouse_dispatch_since: new Date('2026-03-05T00:00:00Z'),
  marketing_margin_pct: '33.00', marketing_pno_alert_pct: '0', webhook_secret: null,
};

function vykresli(tab, prepis = {}) {
  return vykresliStranku('settings/shop-detail', {
    pageTitle: shop.name, currentPath: '/nastaveni/eshopy', shop, tab, zalozky: ZALOZKY,
    checks: [], channels: [], rules: [], eshopKlice: [], expedice: [], marketingZdroje: [], marketingBehy: [],
    maPacketaHeslo: false, maWebhookSecret: false, tajemstviZProstredi: false, otiskWebhookSecret: '', vydavaEshopKlice: true,
    novyEshopKlic: null, novyWebhookSecret: null, serviceAccountEmail: '', maGoogleSa: false, maSecretsKey: false, overeni: null,
    saved: false, error: null, rezimUprav: false, ...prepis,
  });
}

// Sloupce z UPDATE v src/routes/settings.js (zakladni, identita, expedice, marketing)
const SLOUPCE = {
  zakladni:  ['name', 'url', 'active'],
  identita:  ['email_from_name', 'email_from_address', 'email_reply_to', 'support_email', 'support_phone', 'support_phone_link',
              'tagline', 'claim', 'logo_mark_url', 'logo_wordmark_url', 'color_primary', 'color_primary_dark', 'color_primary_light', 'color_on_primary_soft'],
  expedice:  ['warehouse_email', 'warehouse_email_bcc', 'warehouse_dispatch_since'],
  marketing: ['marketing_margin_pct', 'marketing_pno_alert_pct'],
};

for (const [tab, , formular] of ZALOZKY) {
  test(`záložka ${tab}: ${formular ? 'tužka, formulář a všechny sloupce' : 'bez tužky'} v obou režimech`, async () => {
    const zobrazeni = await vykresli(tab);
    zkontrolujDetail(zobrazeni, { formular, sloupce: SLOUPCE[tab] || [], rezim: 'zobrazeni' });
    const upravy = await vykresli(tab, { rezimUprav: true });
    zkontrolujDetail(upravy, { formular, sloupce: SLOUPCE[tab] || [], rezim: formular ? 'upravy' : 'zobrazeni' });
  });
}

test('základní informace: hodnoty jako text, slug jen pro čtení, vzorek barvy jen u platného hexu', async () => {
  const html = await vykresli('zakladni');
  assert.ok(html.includes('Dílna &lt;Vlněnka&gt;'), 'název se escapuje');
  assert.match(html, /<div class="pole-hodnota">Aktivní<\/div>/, 'stav jako text');
  assert.match(html, /<a href="https:\/\/dilna\.example\.invalid" target="_blank" rel="noopener noreferrer">/, 'URL jako odkaz');
  assert.match(html, /<div class="form-group pole pole-stale">\s*<span class="form-label">Slug \(ID\)<\/span>/, 'slug zůstává vidět i v úpravách');
  assert.ok(html.includes('Založen 5. 3. 2025'), 'datum založení nezávisle na časovém pásmu');
  assert.ok(html.includes('href="?tab=zakladni&amp;upravit=1"'), 'tužka bez JS otevře úpravy na téže záložce');
  assert.ok(html.includes('href="?tab=zakladni" class="btn btn-ghost upravit-zrusit"'), 'Zrušit vede zpět bez upravit');

  const identita = await vykresli('identita');
  assert.match(identita, /<span class="barva-vzorek" style="background:#0891b2;"><\/span><code>#0891b2<\/code>/, 'platný hex má vzorek');
  assert.ok(!identita.includes('background:modrá'), 'neplatná hodnota do style nejde');
  assert.ok(identita.includes('>modrá<'), 'ale je vidět jako text');
});

test('Toneráček má přepínač stavu zašedlý, hláška Uloženo se v úpravách skryje', async () => {
  const html = await vykresli('zakladni', { tajemstviZProstredi: true, saved: true });
  assert.match(html, /name="active"[^>]*disabled/, 'přepínač je disabled');
  assert.match(html, /class="alert alert-success jen-zobrazeni"/, 'banner Uloženo je jen pro režim zobrazení');
});

test('marketing: marže a práh PNO v samostatné kartě, platformy mimo dosah tužky', async () => {
  const html = await vykresli('marketing');
  assert.match(html, /<div class="pole-hodnota">33 %<\/div>/, 'marže jako procenta');
  assert.match(html, /<div class="pole-hodnota">Upozornění vypnuté<\/div>/, 'nula má význam, ne pomlčku');
  assert.ok(html.indexOf('Reklamní platformy') > html.indexOf('</form>'), 'formulář marže končí před kartou platforem');
});
