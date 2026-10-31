// Můj profil (views/pages/profil.ejs) vykreslený bez serveru a databáze:
// režim úprav nese karta Osobní údaje, ne stránka — fotka a heslo vedle mají
// vlastní formuláře, které režim neznají a musí zůstat vidět. Serverová část
// (jen s DATABASE_URL) ověří, že GET režim bere jen z ?upravit=1 a POST uloží.
//
//   node --test test/render-profil.test.js
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/render-profil.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { vykresliStranku, zkontrolujDetail, uzivatel } from './pomocnici/render.js';
import { PRESKOCIT, lokalniDatabaze, serverBezi, prihlas, pozadavky } from './pomocnici/server.js';

const user = uzivatel({ first_name: 'Alena <b>', last_name: 'Nováková', email: 'alena@example.invalid', is_admin: true });

function vykresli(prepis = {}) {
  return vykresliStranku('profil', {
    pageTitle: 'Můj profil', currentPath: '/profil', user, saved: false, error: null, rezimUprav: false, ...prepis,
  });
}

// POST /profil (src/routes/auth.js) čte z těla jen tahle dvě pole; heslo posílá vlastní formulář.
const SLOUPCE = ['first_name', 'last_name'];

/** Vnitřek formuláře záznamu — co leží mimo něj, režim úprav nezná. */
function formularZaznamu(html) {
  const m = html.match(/<form\b[^>]*class="upravitelne"[^>]*>[\s\S]*?<\/form>/);
  assert.ok(m, 'formulář záznamu je na stránce');
  return m[0];
}

test('karta Osobní údaje: tužka, formulář profilu a obě pole v obou režimech', async () => {
  const zobrazeni = await vykresli();
  zkontrolujDetail(zobrazeni, { formular: 'formProfil', sloupce: SLOUPCE, rezim: 'zobrazeni' });
  const upravy = await vykresli({ rezimUprav: true });
  zkontrolujDetail(upravy, { formular: 'formProfil', sloupce: SLOUPCE, rezim: 'upravy' });
});

test('režim nese karta, ne stránka; heslo a fotka zůstávají mimo dosah tužky', async () => {
  const html = await vykresli({ rezimUprav: true });
  assert.ok(!html.includes('class="detail"'), 'stránka nemá obal .detail');
  assert.match(html, /<div class="card" data-rezim="upravy">/, 'data-rezim je na kartě Osobní údaje');
  assert.equal((html.match(/data-rezim=/g) || []).length, 1, 'režim má jediný obal');
  assert.ok(html.includes('class="card-header" style="display:flex;align-items:center;justify-content:space-between'), 'ovládání je v hlavičce karty');

  const form = formularZaznamu(html);
  assert.ok(!form.includes('name="current_password"'), 'formulář hesla není součástí formuláře profilu');
  assert.ok(html.includes('name="current_password"'), 'formulář hesla je dál na stránce');
  assert.ok(html.includes('>Změnit heslo</button>'), 'heslo má dál své tlačítko');
  assert.ok(!form.includes('name="file"'), 'formulář fotky je mimo');
  assert.ok(html.includes('id="fotoSaveBtn"'), 'formulář fotky zůstal');
});

test('jméno jako escapovaný text, e-mail a role jen pro čtení, bez zašedlých vstupů a patičky Uložit', async () => {
  const html = await vykresli();
  assert.ok(html.includes('Alena &lt;b&gt;'), 'jméno se escapuje');
  assert.ok(!html.includes('Alena <b>'), 'surové HTML z hodnoty v stránce není');
  assert.match(html, /<input type="text" class="form-control" value="Alena &lt;b&gt;" id="pole-first_name" name="first_name">/, 'vstup jména');
  assert.match(html, /<div class="form-group pole pole-stale">\s*<span class="form-label">E-mail<\/span>\s*<div class="pole-hodnota">alena@example\.invalid<\/div>/, 'e-mail zůstává vidět i v úpravách');
  assert.match(html, /<small class="form-hint jen-upravy">E-mail nelze změnit<\/small>/, 'nápověda k e-mailu jen v úpravách');
  assert.match(html, /<span class="form-label">Role<\/span>\s*<div class="pole-hodnota">Správce<\/div>/, 'role jako text');
  assert.ok(!/<input[^>]*\sdisabled/.test(html), 'žádný zašedlý (disabled) vstup');
  assert.equal((html.match(/class="modal-footer"/g) || []).length, 1, 'patička zůstala jen formuláři hesla');
  assert.ok(html.includes('href="/profil?upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"'), 'tužka bez JS otevře /profil?upravit=1');
  assert.ok(html.includes('href="/profil" class="btn btn-ghost upravit-zrusit"'), 'Zrušit vede na /profil bez upravit');

  const bezny = await vykresli({ user: uzivatel({ is_admin: false, email: 'b@example.invalid' }) });
  assert.match(bezny, /<span class="form-label">Role<\/span>\s*<div class="pole-hodnota">Uživatel<\/div>/, 'nesprávce je Uživatel');
});

test('banner Uloženo leží mimo kartu a nemá jen-zobrazeni; chyba hesla úpravy neotevře', async () => {
  const html = await vykresli({ saved: true, rezimUprav: true });
  assert.ok(html.includes('✅ Změny uloženy'));
  assert.ok(html.indexOf('Změny uloženy') < html.indexOf('data-rezim='), 'banner je před kartou, ne v ní');
  const banner = html.match(/<div[^>]*>\s*✅ Změny uloženy/)?.[0];
  assert.ok(banner && !banner.includes('jen-zobrazeni'), 'banner bez třídy jen-zobrazeni — mimo kartu by ji nic nepřepnulo');

  // Chybu hlásí formulář hesla — vykresluje se se zobrazením, ne s otevřenými osobními údaji.
  const chyba = await vykresli({ error: 'wrongpwd' });
  assert.ok(chyba.includes('Nesprávné stávající heslo'));
  assert.ok(chyba.includes('data-rezim="zobrazeni"'));
});

// ── Proti běžícímu serveru a lokální databázi ──────────────────

describe('proti serveru', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(4).toString('hex');
  let sql, req, sid, userId;

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const [u] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`profil-${r}@example.invalid`}, 'x', 'Profil', ${`Test ${r}`}, FALSE) RETURNING id`;
    userId = u.id;
    const prihlaseni = await prihlas(sql, userId);
    sid = prihlaseni.sid;
    req = pozadavky(prihlaseni.cookie);
  });

  after(async () => {
    if (!sql) return;
    if (sid) await sql`DELETE FROM session WHERE sid = ${sid}`;
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.end();
  });

  test('GET /profil: zobrazení, ?upravit=1 otevře úpravy, chyba hesla ne', async () => {
    const res = await req.get('/profil');
    assert.equal(res.status, 200);
    let html = await res.text();
    assert.ok(html.includes('data-rezim="zobrazeni"'), 'výchozí je zobrazení');
    assert.ok(html.includes('id="formProfil" class="upravitelne"'), 'formulář záznamu je označený');
    assert.ok(html.includes('href="/profil?upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"'), 'tužka vede bez JS na ?upravit=1');
    assert.ok(html.includes(`Test ${r}`), 'příjmení je vidět');

    html = await (await req.get('/profil?upravit=1')).text();
    assert.ok(html.includes('data-rezim="upravy"'), '?upravit=1 otevře úpravy i bez JavaScriptu');

    // Chyba formuláře hesla nesmí otevřít osobní údaje — režim se bere jen z upravit=1.
    html = await (await req.get('/profil?error=wrongpwd')).text();
    assert.ok(html.includes('data-rezim="zobrazeni"'), 'chyba cizího formuláře úpravy neotevře');
    assert.ok(html.includes('Nesprávné stávající heslo'));
  });

  test('POST /profil uloží jméno a vrátí na profil bez upravit', async () => {
    const res = await req.post('/profil', { first_name: `Jana ${r}`, last_name: `Nová ${r}` });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/profil?saved=1');
    const [u] = await sql`SELECT first_name, last_name FROM users WHERE id = ${userId}`;
    assert.deepEqual([u.first_name, u.last_name], [`Jana ${r}`, `Nová ${r}`]);

    const html = await (await req.get('/profil?saved=1')).text();
    assert.ok(html.includes('Změny uloženy'));
    assert.ok(html.includes('data-rezim="zobrazeni"'), 'po uložení je zpět zobrazení');
    assert.ok(html.includes(`Jana ${r}`), 'nové jméno je vidět jako text');
  });
});
