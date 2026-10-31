// Globální hledání (src/hledani.js, GET /hledat).
//
// Část A jde bez serveru i databáze: escapování, normalizace, práva skupin
// a falešný `sql`, který jen počítá dotazy. Část B jede proti běžícímu
// serveru a lokální testovací databázi (vzor test/eshop-nastaveni.test.js)
// a bez DATABASE_URL se přeskočí.
//
//   node --test test/hledani.test.js
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   node --test test/hledani.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { ACCESS_KEYS } from '../src/access.js';
import { SKUPINY, escapujLike, normalizujDotaz, hledej, hledejStranky } from '../src/hledani.js';

// ── A) bez serveru ──────────────────────────────────────────

test('escapujLike zneškodní zástupné znaky LIKE', () => {
  assert.equal(escapujLike('50%_x\\'), '50\\%\\_x\\\\');
  assert.equal(escapujLike('bez'), 'bez');
});

test('normalizujDotaz bere jen řetězec, bez NUL a nadbytečných mezer', () => {
  assert.equal(normalizujDotaz(['a', 'b']), '');
  assert.equal(normalizujDotaz(undefined), '');
  assert.equal(normalizujDotaz('  ab\0c   d  '), 'abc d');
  assert.equal(normalizujDotaz('x'.repeat(200)).length, 100);
});

test('každá skupina má právo z katalogu matice', () => {
  for (const s of SKUPINY) assert.ok(ACCESS_KEYS.includes(s.pravo), `${s.klic}: ${s.pravo}`);
});

function falesnySql() {
  const zachyceno = [];
  const sql = (strings) => { zachyceno.push(strings.join('?')); return Promise.resolve([]); };
  return { sql, zachyceno };
}

test('krátký dotaz nejde do databáze', async () => {
  const { sql, zachyceno } = falesnySql();
  assert.deepEqual(await hledej(sql, { is_admin: true, access: {} }, 'a'), []);
  assert.deepEqual(await hledej(sql, { is_admin: true, access: {} }, ['ab', 'cd']), []);
  assert.equal(zachyceno.length, 0);
});

test('skupiny se ptají jen tam, kam uživatel smí', async () => {
  const { sql, zachyceno } = falesnySql();
  await hledej(sql, { is_admin: false, access: { 'crm.firmy': false } }, 'ab');
  const vse = zachyceno.join('\n');
  assert.ok(!vse.includes('FROM crm_companies'), 'firmy bez práva se nedotazují');
  assert.ok(!vse.includes('FROM users'), 'tým je jen pro správce');
  assert.ok(vse.includes('FROM crm_contacts'), 'kontakty jsou povolené');

  const spravce = falesnySql();
  await hledej(spravce.sql, { is_admin: true, access: {} }, 'ab');
  assert.equal(spravce.zachyceno.length, SKUPINY.length, 'správce se ptá všech skupin');
});

test('stránky menu se hledají bez diakritiky a podle práv', () => {
  const polozky = hledejStranky({ is_admin: true, access: {} }, 'ucetnictvi');
  assert.ok(polozky.some((p) => p.url === '/ucetnictvi/prehled'), 'Finanční přehled pod Účetnictvím');
  assert.ok(polozky.every((p) => p.popis === 'Účetnictví'));
  const bez = hledejStranky({ is_admin: false, access: { 'ucetnictvi.prehled': false } }, 'financni prehled');
  assert.equal(bez.length, 0, 'zakázaná stránka se nenabízí');
});

// ── B) proti serveru a lokální databázi ─────────────────────

const BASE   = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.SESSION_SECRET || 'one-seil-space-secret-change-in-production-32chars';
const r = crypto.randomBytes(4).toString('hex');
const T = `hledtest${r}`;

function lokalniDatabaze() {
  const url = process.env.DATABASE_URL || '';
  const host = url ? new URL(url).hostname : '';
  if (!['127.0.0.1', 'localhost'].includes(host) && process.env.TEST_DB_ALLOW_REMOTE !== '1') {
    throw new Error(`Test zakládá firmy a objednávky — DATABASE_URL musí mířit na 127.0.0.1/localhost, ne na "${host}"`);
  }
  return url;
}

describe('hledání proti serveru', { skip: !process.env.DATABASE_URL && 'bez DATABASE_URL se integrační část přeskakuje' }, () => {
  let sql;
  const uklid = { users: [], sids: [], shops: [] };
  const ctx = {};

  async function prihlas(userId) {
    const sid = 'test' + crypto.randomBytes(12).toString('hex');
    const sig = crypto.createHmac('sha256', SECRET).update(sid).digest('base64').replace(/=/g, '');
    uklid.sids.push(sid);
    await sql`
      INSERT INTO session (sid, sess, expire) VALUES (${sid},
        ${{ cookie: { originalMaxAge: 28800000, httpOnly: true, path: '/', sameSite: 'lax', secure: false }, userId }},
        ${new Date(Date.now() + 3600_000)})
    `;
    return `sessionId=${sid}.${sig}`;
  }
  const get = (p, cookie = ctx.cookie) => fetch(BASE + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 3, onnotice: () => {} });
    const health = await fetch(BASE + '/health').catch(() => null);
    assert.ok(health?.ok, `server neběží na ${BASE}`);

    const [admin] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`hled-admin-${r}@example.invalid`}, 'x', 'Test', 'Správce', TRUE) RETURNING id`;
    const [bezny] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`hled-bezny-${r}@example.invalid`}, 'x', 'Test', 'Běžný', FALSE) RETURNING id`;
    uklid.users.push(admin.id, bezny.id);
    await sql`INSERT INTO user_access (user_id, access_key, allowed) VALUES (${bezny.id}, 'crm.firmy', FALSE)`;
    ctx.cookie = await prihlas(admin.id);
    ctx.beznyCookie = await prihlas(bezny.id);

    const [shop] = await sql`
      INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address)
      VALUES (${`test-hled-${r}`}, ${`Hledací e-shop ${r}`}, 'https://example.invalid', TRUE, 'Test', 'noreply@example.invalid')
      RETURNING id, slug`;
    uklid.shops.push(shop.id);
    ctx.shop = shop;
    ctx.firma = `test_hled_f_${r}`; ctx.kontakt = `test_hled_k_${r}`; ctx.objednavka = `test_hled_o_${r}`;
    await sql`INSERT INTO crm_companies (id, name, company_type) VALUES (${ctx.firma}, ${`Firma ${T}`}, 'Zákazník')`;
    await sql`INSERT INTO crm_contacts (id, first_name, last_name, email, company_id)
              VALUES (${ctx.kontakt}, 'Kontakt', ${T}, ${`k-${r}@example.invalid`}, ${ctx.firma})`;
    await sql`INSERT INTO shop_orders (id, shop_id, order_number, status, email, first_name, last_name, total_price)
              VALUES (${ctx.objednavka}, ${shop.id}, ${T}, 'Přijata', ${`o-${r}@example.invalid`}, 'Objednávka', 'Test', 100)`;
  });

  after(async () => {
    if (!sql) return;
    await sql`DELETE FROM shop_orders WHERE id = ${ctx.objednavka ?? ''}`;
    await sql`DELETE FROM crm_contacts WHERE id = ${ctx.kontakt ?? ''}`;
    await sql`DELETE FROM crm_companies WHERE id = ${ctx.firma ?? ''}`;
    if (uklid.shops.length) await sql`DELETE FROM shops WHERE id = ANY(${uklid.shops})`;
    if (uklid.sids.length)  await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
    if (uklid.users.length) await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
    await sql.end();
  });

  test('správce najde firmu, kontakt i objednávku a odkaz do seznamu', async () => {
    const res = await get(`/hledat?q=${encodeURIComponent(T)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    assert.ok(html.includes('Výsledky pro'));
    assert.ok(html.includes(`/crm/firmy/${ctx.firma}`), 'firma');
    assert.ok(html.includes(`/crm/kontakty/${ctx.kontakt}`), 'kontakt');
    assert.ok(html.includes(`/ucetnictvi/objednavky/${ctx.objednavka}`), 'objednávka');
    assert.ok(html.includes(`/crm/firmy?q=${encodeURIComponent(T)}`), 'odkaz na seznam firem');
    assert.ok(html.includes(`eshop=${encodeURIComponent(ctx.shop.slug)}`), 'seznam objednávek dostane e-shop, když jsou všechny z jednoho');
  });

  test('běžný uživatel bez práva na firmy firmu nedostane, ostatní ano', async () => {
    const html = await (await get(`/hledat?q=${encodeURIComponent(T)}`, ctx.beznyCookie)).text();
    assert.ok(!html.includes(`/crm/firmy/${ctx.firma}`), 'firma bez práva');
    assert.ok(html.includes(`/crm/kontakty/${ctx.kontakt}`), 'kontakt ano');
    assert.ok(html.includes(`/ucetnictvi/objednavky/${ctx.objednavka}`), 'objednávka ano');
    assert.ok(!html.includes('/lide/tym/'), 'tým jen správce');
    assert.equal((await get('/crm/firmy', ctx.beznyCookie)).status, 403, 'matice a hledání říkají totéž');
  });

  test('krátký dotaz, zástupné znaky a NUL nic nerozbijí', async () => {
    const kratky = await get('/hledat?q=h');
    assert.equal(kratky.status, 200);
    assert.ok((await kratky.text()).includes('alespoň 2 znaky'));

    const procento = await get(`/hledat?q=${encodeURIComponent('%' + T.slice(2))}`);
    assert.equal(procento.status, 200);
    assert.ok(!(await procento.text()).includes(`/crm/firmy/${ctx.firma}`), '% je doslovný znak, ne zástupný');

    for (const q of ['%25%25', '__', '%00ab', '%5C']) {
      assert.equal((await get(`/hledat?q=${q}`)).status, 200, q);
    }
  });

  test('bez přihlášení se jde na login', async () => {
    const res = await get('/hledat?q=ab', null);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/prihlasit');
  });
});
