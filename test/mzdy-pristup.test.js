// Mzdy, ekonomika a podklady člena týmu: záložka ?tab= a příloha musí poslechnout
// přístupovou matici stejně jako stránka /lide/mzdy. Strážce vidí jen cestu, ne tab.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/mzdy-pristup.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';

describe('přístup k osobním záložkám člena', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  let sql; let clen; let bezPrava; let sPravem; let req; let reqPravo; let reqClen; const sid = [];
  const MZDA = `mz-${r}`;
  const PLATBA = `pl-${r}`;
  let priloha;

  const uzivatel = async (jmeno, prepis = {}) => (await sql`
    INSERT INTO users (email, password_hash, is_active, is_admin, first_name, last_name, public_id)
    VALUES (${`${jmeno}-${r}@example.invalid`}, 'x', TRUE, ${prepis.admin ?? true}, ${jmeno}, ${r}, ${`${jmeno}${r}`})
    RETURNING id, public_id`)[0];
  const session = async (u) => { const p = await prihlas(sql, u.id); sid.push(p.sid); return pozadavky(p.cookie); };
  const html = async (k, adresa) => (await k.get(adresa)).text();

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    clen = await uzivatel('clen', { admin: false });
    bezPrava = await uzivatel('bez');
    sPravem = await uzivatel('spravem');
    for (const klic of ['lide.mzdy', 'lide.ekonomika']) {
      await sql`INSERT INTO user_access (user_id, access_key, allowed) VALUES (${sPravem.id}, ${klic}, TRUE)`;
    }
    await sql`INSERT INTO hr_payroll_runs (id, user_id, period, net, gross) VALUES (${MZDA}, ${clen.id}, '2026-01-01', 31234, 40000)`;
    await sql`INSERT INTO hr_payroll_items (id, user_id, kind, paid_on, amount, description) VALUES (${PLATBA}, ${clen.id}, 'odmena', '2026-01-15', 777, ${`Platba ${r}`})`;
    [priloha] = await sql`INSERT INTO attachments (payroll_run_id, path, mime, original_name) VALUES (${MZDA}, ${`neexistuje-${r}.pdf`}, 'application/pdf', 'paska.pdf') RETURNING id`;
    req = await session(bezPrava);
    reqPravo = await session(sPravem);
    reqClen = await session(clen);
  });

  after(async () => {
    await sql`DELETE FROM attachments WHERE id = ${priloha.id}`;
    await sql`DELETE FROM hr_payroll_items WHERE id = ${PLATBA}`;
    await sql`DELETE FROM hr_payroll_runs WHERE id = ${MZDA}`;
    await sql`DELETE FROM session WHERE sid = ANY(${sid})`;
    await sql`DELETE FROM user_access WHERE user_id = ${sPravem.id}`;
    await sql`DELETE FROM users WHERE id = ANY(${[clen.id, bezPrava.id, sPravem.id]})`;
    await sql.end();
  });

  const detail = () => `/lide/tym/${clen.public_id}`;

  test('správce bez práva: záložky nejsou v pruhu a ?tab= otevře Detail bez čísel', async () => {
    for (const tab of ['mzdy', 'hodiny', 'ekonomika', 'vydaje']) {
      const stranka = await html(req, `${detail()}?tab=${tab}`);
      assert.match(stranka, /class="tab active"[^>]*>Detail/, tab);
      assert.ok(!stranka.includes(`?tab=${tab}"`), `${tab} není v pruhu`);
      assert.ok(!stranka.includes('31 234') && !stranka.includes(`Platba ${r}`), `${tab} neukáže čísla`);
    }
  });

  test('správce s právem záložky vidí a čísla jsou tam', async () => {
    const mzdy = await html(reqPravo, `${detail()}?tab=mzdy`);
    assert.match(mzdy, /class="tab active"[^>]*>Mzdy/);
    assert.ok(mzdy.includes('31') , 'mzda je vidět');
    assert.ok((await html(reqPravo, `${detail()}?tab=vydaje`)).includes(`Platba ${r}`));
  });

  test('platby bez práva nejde založit ani smazat', async () => {
    let res = await req.post(`${detail()}/platby/vytvorit`, { kind: 'odmena', amount: '5', paid_on: '2026-01-01' });
    assert.equal(res.status, 403);
    res = await req.post(`${detail()}/platby/${PLATBA}/smazat`, {});
    assert.equal(res.status, 403);
    assert.equal((await sql`SELECT count(*)::int n FROM hr_payroll_items WHERE id = ${PLATBA}`)[0].n, 1);
  });

  test('výplatní páska: správce bez práva 403, s právem a vlastník projdou kontrolou', async () => {
    assert.equal((await req.get(`/doklady/priloha/${priloha.id}`)).status, 403);
    // Soubor na disku není: 404 znamená, že kontrola přístupu prošla.
    assert.equal((await reqPravo.get(`/doklady/priloha/${priloha.id}`)).status, 404);
    assert.equal((await reqClen.get(`/doklady/priloha/${priloha.id}`)).status, 404);
  });
});
