// Můj profil (views/pages/profil.ejs) po záložkách: Osobní údaje (fotka a údaje s režimem
// úprav na kartě), Heslo a Notifikace (dřív stránka /nastaveni). Serverová část (jen
// s DATABASE_URL) ověří návraty na správnou záložku a že POST hesla nesahá na jméno.
//
//   node --test test/render-profil.test.js
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/render-profil.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcryptjs from 'bcryptjs';
import postgres from 'postgres';
import { vykresliStranku, zkontrolujDetail, uzivatel } from './pomocnici/render.js';
import { BASE, PRESKOCIT, lokalniDatabaze, serverBezi, prihlas, pozadavky } from './pomocnici/server.js';

const user = uzivatel({ first_name: 'Alena <b>', last_name: 'Nováková', email: 'alena@example.invalid', is_admin: true });
const ZALOZKY = [['udaje', 'Osobní údaje', 'formProfil'], ['heslo', 'Heslo', null], ['notifikace', 'Notifikace', null]];

function vykresli(prepis = {}) {
  return vykresliStranku('profil', {
    pageTitle: 'Můj profil', currentPath: '/profil', user, tab: 'udaje', zalozky: ZALOZKY, prefs: { notify_new_order: true },
    saved: false, error: null, rezimUprav: false, ...prepis,
  });
}

// POST /profil (src/routes/auth.js) čte z těla jen tahle dvě pole; heslo posílá vlastní formulář.
const SLOUPCE = ['first_name', 'last_name'];

function formularZaznamu(html) {
  const m = html.match(/<form\b[^>]*class="upravitelne"[^>]*>[\s\S]*?<\/form>/);
  assert.ok(m, 'formulář záznamu je na stránce');
  return m[0];
}

test('záložka Osobní údaje: tužka, formulář profilu a obě pole v obou režimech', async () => {
  zkontrolujDetail(await vykresli(), { formular: 'formProfil', sloupce: SLOUPCE, rezim: 'zobrazeni' });
  zkontrolujDetail(await vykresli({ rezimUprav: true }), { formular: 'formProfil', sloupce: SLOUPCE, rezim: 'upravy' });
});

test('režim nese karta, ne stránka; fotka zůstává mimo dosah tužky', async () => {
  const html = await vykresli({ rezimUprav: true });
  assert.ok(!html.includes('class="detail"'));
  assert.match(html, /<div class="card" data-rezim="upravy">/);
  assert.equal((html.match(/data-rezim=/g) || []).length, 1);
  const form = formularZaznamu(html);
  assert.ok(!form.includes('name="file"'), 'formulář fotky je mimo');
  assert.ok(html.includes('id="fotoSaveBtn"'), 'formulář fotky zůstal');
  assert.ok(html.includes('function previewFoto'), 'skript náhledu fotky je u fotky');
  assert.ok(!html.includes('name="current_password"'), 'heslo je na vlastní záložce');
  assert.ok(!html.includes('pushLabel'), 'notifikace jsou na vlastní záložce');
});

test('jméno jako escapovaný text, e-mail a role jen pro čtení; tužka a Zrušit nesou záložku', async () => {
  const html = await vykresli();
  assert.ok(html.includes('Alena &lt;b&gt;'));
  assert.ok(!html.includes('Alena <b>'));
  assert.match(html, /<input type="text" class="form-control" value="Alena &lt;b&gt;" id="pole-first_name" name="first_name">/);
  assert.match(html, /<div class="form-group pole pole-stale">\s*<span class="form-label">E-mail<\/span>\s*<div class="pole-hodnota">alena@example\.invalid<\/div>/);
  assert.match(html, /<small class="form-hint jen-upravy">E-mail nelze změnit<\/small>/);
  assert.match(html, /<span class="form-label">Role<\/span>\s*<div class="pole-hodnota">Správce<\/div>/);
  assert.ok(html.includes('href="/profil?tab=udaje&amp;upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"'));
  assert.ok(html.includes('href="/profil?tab=udaje" class="btn btn-ghost upravit-zrusit"'));
  const bezny = await vykresli({ user: uzivatel({ is_admin: false, email: 'b@example.invalid' }) });
  assert.match(bezny, /<span class="form-label">Role<\/span>\s*<div class="pole-hodnota">Uživatel<\/div>/);
});

test('záložka Heslo: formulář hesla bez tužky a bez polí jména', async () => {
  const html = await vykresli({ tab: 'heslo' });
  assert.ok(html.includes('name="current_password"'));
  assert.ok(html.includes('>Změnit heslo</button>'));
  assert.ok(!html.includes('upravit-otevrit'));
  assert.ok(!html.includes('name="first_name"'));
  assert.ok(!html.includes('id="fotoInput"'));
  assert.match(html, /href="\/profil\?tab=heslo" class="tab active" aria-current="page"/);
});

test('záložka Notifikace: přepínač podle předvoleb, stav push a skript jen tady', async () => {
  let html = await vykresli({ tab: 'notifikace' });
  assert.ok(html.includes('id="pushLabel"'));
  assert.ok(html.includes('id="prefNewOrder" class="toggle-input" checked'));
  assert.ok(html.includes('initPush'));
  assert.ok(!html.includes('upravit-otevrit'));
  html = await vykresli({ tab: 'notifikace', prefs: { notify_new_order: false } });
  assert.ok(!html.includes('id="prefNewOrder" class="toggle-input" checked'));
});

test('hlášky jsou nad záložkami a text chyby se escapuje; chyba hesla úpravy neotevře', async () => {
  const html = await vykresli({ saved: true, rezimUprav: true });
  assert.ok(html.indexOf('Změny uloženy') < html.indexOf('class="tabs"'));
  const chyba = await vykresli({ tab: 'heslo', error: 'Text <i>' });
  assert.ok(chyba.includes('Text &lt;i&gt;'));
  assert.ok(!chyba.includes('data-rezim="upravy"'));
});

// ── Proti běžícímu serveru a lokální databázi ──────────────────

describe('proti serveru', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(4).toString('hex');
  const HESLO = `heslo-${r}`;
  let sql, req, sid, userId, cookie;

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const [u] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`profil-${r}@example.invalid`}, ${bcryptjs.hashSync(HESLO, 4)}, 'Profil', ${`Test ${r}`}, FALSE) RETURNING id`;
    userId = u.id;
    const prihlaseni = await prihlas(sql, userId);
    sid = prihlaseni.sid;
    cookie = prihlaseni.cookie;
    req = pozadavky(cookie);
  });

  after(async () => {
    if (!sql) return;
    if (sid) await sql`DELETE FROM session WHERE sid = ${sid}`;
    if (userId) await sql`DELETE FROM user_notification_prefs WHERE user_id = ${userId}`;
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.end();
  });

  test('GET /profil: výchozí Osobní údaje, ?upravit=1 otevře úpravy, neznámý tab i pole padají na první', async () => {
    let html = await (await req.get('/profil')).text();
    assert.ok(html.includes('data-rezim="zobrazeni"'));
    assert.ok(html.includes('id="formProfil" class="upravitelne"'));
    assert.ok(html.includes(`Test ${r}`));
    html = await (await req.get('/profil?tab=udaje&upravit=1')).text();
    assert.ok(html.includes('data-rezim="upravy"'));
    for (const q of ['?tab=xyz', '?tab=heslo&tab=udaje', '?tab=__proto__', '?error=__proto__']) {
      const res = await req.get(`/profil${q}`);
      assert.equal(res.status, 200, q);
      assert.ok((await res.text()).includes('id="formProfil"'), q);
    }
  });

  test('POST jména se vrátí na Osobní údaje a nesáhne na heslo', async () => {
    const [pred] = await sql`SELECT password_hash FROM users WHERE id = ${userId}`;
    const res = await req.post('/profil', { first_name: `Jana ${r}`, last_name: `Nová ${r}` });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/profil?tab=udaje&saved=1');
    const [u] = await sql`SELECT first_name, last_name, password_hash FROM users WHERE id = ${userId}`;
    assert.deepEqual([u.first_name, u.last_name], [`Jana ${r}`, `Nová ${r}`]);
    assert.equal(u.password_hash, pred.password_hash);
    const html = await (await req.get(res.headers.get('location'))).text();
    assert.ok(html.includes('Změny uloženy'));
    assert.ok(html.includes(`Jana ${r}`));
  });

  test('POST hesla: chyby se vrací na záložku Heslo a mají text, úspěch nesáhne na jméno', async () => {
    const [pred] = await sql`SELECT first_name, last_name, password_hash FROM users WHERE id = ${userId}`;
    const pripady = [
      [{ current_password: HESLO, new_password: 'a1', new_password_confirm: 'a2' }, 'mismatch', 'Nová hesla se neshodují'],
      [{ current_password: 'spatne', new_password: 'a1', new_password_confirm: 'a1' }, 'wrongpwd', 'Nesprávné stávající heslo'],
      [{ current_password: HESLO, new_password: '', new_password_confirm: '' }, 'prazdne', 'Zadejte nové heslo'],
    ];
    for (const [telo, kod, text] of pripady) {
      const res = await req.post('/profil', telo);
      assert.equal(res.headers.get('location'), `/profil?tab=heslo&error=${kod}`);
      const html = await (await req.get(res.headers.get('location'))).text();
      assert.ok(html.includes(text), kod);
      assert.ok(html.includes('name="current_password"'), 'formulář hesla je vidět');
    }
    const [beze] = await sql`SELECT password_hash FROM users WHERE id = ${userId}`;
    assert.equal(beze.password_hash, pred.password_hash, 'neúspěšné pokusy heslo nezměnily');

    const res = await req.post('/profil', { current_password: HESLO, new_password: `nove-${r}`, new_password_confirm: `nove-${r}` });
    assert.equal(res.headers.get('location'), '/profil?tab=heslo&saved=1');
    const [po] = await sql`SELECT first_name, last_name, password_hash FROM users WHERE id = ${userId}`;
    assert.ok(bcryptjs.compareSync(`nove-${r}`, po.password_hash));
    assert.deepEqual([po.first_name, po.last_name], [pred.first_name, pred.last_name]);
  });

  test('chyby fotky mají text a vrací na Osobní údaje', async () => {
    const hranice = '----seil' + r;
    const telo = `--${hranice}\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nx\r\n--${hranice}--\r\n`;
    const res = await fetch(`${BASE}/profil/foto`, {
      method: 'POST', redirect: 'manual', body: telo,
      headers: { 'content-type': `multipart/form-data; boundary=${hranice}`, cookie },
    });
    assert.equal(res.headers.get('location'), '/profil?tab=udaje&error=notimage');
    for (const [kod, text] of [['notimage', 'Fotka musí být obrázek'], ['nofile', 'Vyberte soubor s fotkou']]) {
      assert.ok((await (await req.get(`/profil?tab=udaje&error=${kod}`)).text()).includes(text), kod);
    }
  });

  test('záložka Notifikace načte předvolby; stará adresa /nastaveni přesměruje', async () => {
    await sql`INSERT INTO user_notification_prefs (user_id, notify_new_order) VALUES (${userId}, FALSE)
      ON CONFLICT (user_id) DO UPDATE SET notify_new_order = FALSE`;
    const html = await (await req.get('/profil?tab=notifikace')).text();
    assert.ok(html.includes('id="pushLabel"'));
    assert.ok(!html.includes('id="prefNewOrder" class="toggle-input" checked'));
    const res = await req.get('/nastaveni');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/profil?tab=notifikace');
    assert.ok(html.includes('href="/profil?tab=notifikace" class="dropdown-item"'), 'odkaz v menu účtu');
  });
});
