// Stopky a měření času.
//
// Testy jedou proti běžícímu serveru a databázi z .env; přihlášení obchází
// vložením session přímo do DB. Všechna vytvořená data se na konci mažou.
//
//   TEST_BASE_URL=http://127.0.0.1:3999 node --test test/prace.test.js

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { hodinyMinuty } from '../src/prace.js';

const BASE   = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.SESSION_SECRET || 'one-seil-space-secret-change-in-production-32chars';

let sql;
const r = crypto.randomBytes(4).toString('hex');
const uklid = { users: [], sids: [], tasks: [] };
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

const post = (p, body, cookie) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});
const get = (p, cookie) => fetch(BASE + p, { headers: { cookie }, redirect: 'manual' });

before(async () => {
  sql = postgres(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === 'true', max: 3 });
  const health = await fetch(BASE + '/health').catch(() => null);
  assert.ok(health?.ok, `server neběží na ${BASE}`);

  const [u] = await sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${`prace-${r}@example.invalid`}, 'x', 'Test', 'Stopky') RETURNING id
  `;
  uklid.users.push(u.id);
  ctx.userId = u.id;
  ctx.cookie = await prihlas(u.id);

  for (const [klic, nazev] of [['a', 'První úkol'], ['b', 'Druhý úkol']]) {
    const id = `test_task_${r}_${klic}`;
    uklid.tasks.push(id);
    await sql`INSERT INTO tasks (id, code, summary) VALUES (${id}, ${'T-' + r + klic}, ${nazev})`;
    ctx[klic] = id;
  }
});

after(async () => {
  if (!sql) return;
  if (uklid.sids.length)  await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
  if (uklid.users.length) await sql`DELETE FROM time_entries WHERE user_id = ANY(${uklid.users})`;
  if (uklid.tasks.length) await sql`DELETE FROM tasks WHERE id = ANY(${uklid.tasks})`;
  if (uklid.users.length) await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
  await sql.end();
});

const bezicich = async () =>
  (await sql`SELECT COUNT(*)::int n FROM time_entries WHERE user_id = ${ctx.userId} AND ended_at IS NULL`)[0].n;

describe('stopky', () => {
  test('start a stop', async () => {
    assert.equal((await post('/prace/stopky/start', { ukol_id: ctx.a }, ctx.cookie)).status, 302);
    assert.equal(await bezicich(), 1);
    assert.equal((await post('/prace/stopky/stop', {}, ctx.cookie)).status, 302);
    assert.equal(await bezicich(), 0);
  });

  test('spuštění jiného úkolu zastaví to předchozí', async () => {
    // Jinak by uživatel skončil se dvěma otevřenými měřeními a nikdo by
    // nepoznal, které je to pravé.
    await post('/prace/stopky/start', { ukol_id: ctx.a }, ctx.cookie);
    await post('/prace/stopky/start', { ukol_id: ctx.b }, ctx.cookie);
    assert.equal(await bezicich(), 1, 'běžet smí právě jedno měření');
    const [b] = await sql`SELECT task_id FROM time_entries WHERE user_id = ${ctx.userId} AND ended_at IS NULL`;
    assert.equal(b.task_id, ctx.b, 'běžet má ten nově spuštěný');
    await post('/prace/stopky/stop', {}, ctx.cookie);
  });

  test('databáze nedovolí dvoje běžící stopky ani napřímo', async () => {
    await sql`INSERT INTO time_entries (user_id, started_at) VALUES (${ctx.userId}, NOW())`;
    await assert.rejects(
      () => sql`INSERT INTO time_entries (user_id, started_at) VALUES (${ctx.userId}, NOW())`,
      /time_entries_running_idx|duplicate key/,
    );
    await sql`DELETE FROM time_entries WHERE user_id = ${ctx.userId} AND ended_at IS NULL`;
  });

  test('běžící měření je vidět v topbaru na každé stránce', async () => {
    await post('/prace/stopky/start', { ukol_id: ctx.a }, ctx.cookie);
    for (const cesta of ['/', '/prace/ukoly']) {
      const html = await (await get(cesta, ctx.cookie)).text();
      assert.match(html, /stopky-pilulka/, `pilulka chybí na ${cesta}`);
      assert.match(html, /stopky-cas" data-start=/, 'čas se musí tikat z data-start');
    }
    await post('/prace/stopky/stop', {}, ctx.cookie);
    assert.doesNotMatch(await (await get('/', ctx.cookie)).text(), /stopky-pilulka/);
  });

  test('ruční zápis spočítá délku ze zadaných časů', async () => {
    const den = '2031-05-14';
    await post('/prace/zaznamy/vytvorit',
      { den, od: '09:00', do: '11:30', ukol_id: ctx.a, poznamka: 'test' }, ctx.cookie);
    const [z] = await sql`
      SELECT duration_seconds FROM time_entries
       WHERE user_id = ${ctx.userId} AND started_at::date = ${den}
    `;
    assert.equal(z.duration_seconds, 2.5 * 3600);
    assert.equal(hodinyMinuty(z.duration_seconds), '2:30');
  });

  test('nulové měření je legitimní, ne chyba', async () => {
    // V datech z Airtable jsou desítky omylem spuštěných stopek se
    // shodným startem i koncem. Import je musí unést.
    const [z] = await sql`
      INSERT INTO time_entries (user_id, started_at, ended_at, source)
      VALUES (${ctx.userId}, NOW(), NOW(), 'import') RETURNING duration_seconds
    `;
    assert.equal(z.duration_seconds, 0);
  });

  test('cizí měření nejde smazat podvrženým ID', async () => {
    const [cizi] = await sql`
      INSERT INTO time_entries (user_id, started_at, ended_at)
      VALUES (${ctx.userId}, NOW() - interval '2 hours', NOW() - interval '1 hour') RETURNING id
    `;
    const [jiny] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name)
      VALUES (${`cizi-${r}@example.invalid`}, 'x', 'Cizí', 'Uživatel') RETURNING id
    `;
    uklid.users.push(jiny.id);
    const cookieJiny = await prihlas(jiny.id);

    await post(`/prace/zaznamy/${cizi.id}/smazat`, {}, cookieJiny);
    const [zbylo] = await sql`SELECT COUNT(*)::int n FROM time_entries WHERE id = ${cizi.id}`;
    assert.equal(zbylo.n, 1, 'záznam musí zůstat — patří někomu jinému');
  });

  test('sekundy se zobrazují jako hodiny a minuty', () => {
    assert.equal(hodinyMinuty(0), '0:00');
    assert.equal(hodinyMinuty(3600), '1:00');
    assert.equal(hodinyMinuty(4980), '1:23');
    assert.equal(hodinyMinuty(null), '0:00');
  });
});
