// Přístup k přílohám — kdo smí otevřít výplatní pásku a kdo ne.
//
// Testy jedou proti běžícímu serveru a databázi z .env; přihlášení obchází
// vložením session přímo do DB, stejně jako test/invoices.test.js.
// Všechna vytvořená data se na konci mažou.
//
//   TEST_BASE_URL=http://127.0.0.1:3999 node --test test/prilohy.test.js

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MEDIA_DIR } from '../src/attachments.js';

const BASE   = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.SESSION_SECRET || 'one-seil-space-secret-change-in-production-32chars';

let sql;
// Úklid musí být adresný: testy běží souběžně a mazání „všeho, co začíná
// na test" by odhlásilo jiný test uprostřed běhu.
const uklid = { users: [], soubory: [], sids: [], tasks: [] };
const ctx = {};   // { spravce, vlastnik, cizi } → { id, cookie }

function prihlas(userId) {
  const sid = 'test' + crypto.randomBytes(12).toString('hex');
  const sig = crypto.createHmac('sha256', SECRET).update(sid).digest('base64').replace(/=/g, '');
  return { sid, cookie: `sessionId=${sid}.${sig}`, userId };
}

async function zalozSession(s) {
  uklid.sids.push(s.sid);
  await sql`
    INSERT INTO session (sid, sess, expire) VALUES (
      ${s.sid},
      ${{ cookie: { originalMaxAge: 28800000, httpOnly: true, path: '/', sameSite: 'lax', secure: false }, userId: s.userId }},
      ${new Date(Date.now() + 3600_000)}
    )
  `;
}

async function zalozUzivatele(email, isAdmin) {
  const [u] = await sql`
    INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
    VALUES (${email}, 'x', 'Test', ${isAdmin ? 'Správce' : 'Uživatel'}, ${isAdmin})
    RETURNING id
  `;
  uklid.users.push(u.id);
  const s = prihlas(u.id);
  await zalozSession(s);
  return { id: u.id, cookie: s.cookie };
}

const get = (p, cookie) => fetch(BASE + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

before(async () => {
  sql = postgres(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === 'true', max: 3 });
  const health = await fetch(BASE + '/health').catch(() => null);
  assert.ok(health?.ok, `server neběží na ${BASE} — spusť npm start`);

  const r = crypto.randomBytes(4).toString('hex');
  ctx.spravce  = await zalozUzivatele(`test-admin-${r}@example.invalid`, true);
  ctx.vlastnik = await zalozUzivatele(`test-owner-${r}@example.invalid`, false);
  ctx.cizi     = await zalozUzivatele(`test-other-${r}@example.invalid`, false);

  // Mzdový list vlastníka s výplatní páskou
  const runId = 'test_run_' + r;
  await sql`
    INSERT INTO hr_payroll_runs (id, user_id, period, gross, net)
    VALUES (${runId}, ${ctx.vlastnik.id}, DATE '2026-01-01', 35000, 18822)
  `;
  const nazev = `test_paska_${r}.pdf`;
  await writeFile(path.join(MEDIA_DIR, nazev), '%PDF-1.4 TAJNA PASKA');
  uklid.soubory.push(nazev);
  const [pas] = await sql`
    INSERT INTO attachments (path, original_name, mime, size, category, payroll_run_id)
    VALUES (${nazev}, 'Výplatnice_mezd 01.pdf', 'application/pdf', 20, 'vyplatni_paska', ${runId})
    RETURNING id
  `;
  ctx.paskaId = pas.id;

  // Příloha úkolu — pracovní materiál, ne osobní údaj
  const taskId = 'test_task_' + r;
  uklid.tasks.push(taskId);
  await sql`INSERT INTO tasks (id, summary) VALUES (${taskId}, 'Testovací úkol')`;
  const nazevU = `test_ukol_${r}.xml`;
  await writeFile(path.join(MEDIA_DIR, nazevU), '<?xml version="1.0"?><x/>');
  uklid.soubory.push(nazevU);
  const [pu] = await sql`
    INSERT INTO attachments (path, original_name, mime, size, category, task_id)
    VALUES (${nazevU}, 'export.xml', 'text/xml', 25, 'priloha_ukolu', ${taskId})
    RETURNING id
  `;
  ctx.ukolId = pu.id;
});

after(async () => {
  if (!sql) return;
  if (uklid.sids.length)  await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
  if (uklid.tasks.length) await sql`DELETE FROM tasks WHERE id = ANY(${uklid.tasks})`;
  if (uklid.users.length) {
    // attachments a hr_payroll_runs padají kaskádou přes vlastníka
    await sql`DELETE FROM hr_payroll_runs WHERE user_id = ANY(${uklid.users})`;
    await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
  }
  for (const f of uklid.soubory) await unlink(path.join(MEDIA_DIR, f)).catch(() => {});
  await sql.end();
});

describe('přístup k přílohám', () => {
  test('odhlášený se k dokladům nedostane ani přímo, ani přes přílohu', async () => {
    // data/media bývalo na veřejné cestě a stačilo uhodnout název souboru.
    // Odhlášeného teď odchytí globální guard a pošle ho na přihlášení —
    // proto 302, ne 401 (na 401 v routě se dostane leda API klient).
    const primo = await fetch(`${BASE}/media/${uklid.soubory[0]}`, { redirect: 'manual' });
    assert.equal(primo.status, 302, '/media musí přesměrovat na přihlášení');
    assert.ok(!(await primo.text()).includes('PASKA'), 'obsah se nesmí prozradit');

    const chranena = await get(`/doklady/priloha/${ctx.paskaId}`, null);
    assert.equal(chranena.status, 302);
    assert.ok(!(await chranena.text()).includes('PASKA'));
  });

  test('vlastník svoji výplatní pásku otevře', async () => {
    const res = await get(`/doklady/priloha/${ctx.paskaId}`, ctx.vlastnik.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    // stahuje se pod původním názvem, ne pod tím na disku
    assert.match(res.headers.get('content-disposition'), /Výplatnice_mezd 01\.pdf/);
  });

  test('správce vidí i cizí výplatní pásku', async () => {
    const res = await get(`/doklady/priloha/${ctx.paskaId}`, ctx.spravce.cookie);
    assert.equal(res.status, 200);
  });

  test('cizí zaměstnanec na výplatní pásku nedosáhne', async () => {
    const res = await get(`/doklady/priloha/${ctx.paskaId}`, ctx.cizi.cookie);
    assert.equal(res.status, 403);
    assert.ok(!(await res.text()).includes('PASKA'), 'obsah se nesmí prozradit');
  });

  test('příloha úkolu je pracovní materiál — vidí ji každý přihlášený', async () => {
    const res = await get(`/doklady/priloha/${ctx.ukolId}`, ctx.cizi.cookie);
    assert.equal(res.status, 200);
    // XML se nabídne ke stažení, ne k zobrazení v prohlížeči
    assert.match(res.headers.get('content-disposition'), /^attachment/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('neexistující nebo nesmyslné id nespadne', async () => {
    assert.equal((await get('/doklady/priloha/99999999', ctx.spravce.cookie)).status, 404);
    assert.equal((await get('/doklady/priloha/abc', ctx.spravce.cookie)).status, 400);
    assert.equal((await get('/doklady/priloha/-1', ctx.spravce.cookie)).status, 400);
  });
});
