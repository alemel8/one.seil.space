// Seznam úkolů a naměřený čas na detailu úkolu proti běžícímu serveru a lokální
// databázi: stránkování místo tichého limitu 300, součet přes všechna měření,
// filtry v odkazech a návrat po akci v řádku.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/seznam-ukoly.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';
import { overSeznam, odkazStrany } from './pomocnici/seznamy.js';

const adresaDetailu = (id) => `/prace/ukoly/${id}`;
const pocetNa = (html, ids) => ids.filter(id => html.includes(`${adresaDetailu(id)}"`)).length;
const navrat = (html) => /name="back" value="([^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');

describe('seznam úkolů', { skip: PRESKOCIT }, () => {
  const r = 'su' + Math.random().toString(36).slice(2, 9);
  // Přes starý LIMIT 300: 61 u jedné firmy, zbytek bez klienta, první tři s vlastním slovem v souhrnu.
  const NEHOTOVYCH = 305;
  const HOTOVYCH = 30;
  const firma = `su-f-${r}`;
  const nehotove = []; const hotove = [];
  let sql; let req; let sid; let uzivatel;

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`su-${r}@example.invalid`}, 'x', TRUE, FALSE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    req = pozadavky(prihlaseni.cookie);
    await sql`INSERT INTO crm_companies (id, name, company_type) VALUES (${firma}, ${`Firma ${r}`}, 'Zákazník')`;
    // Shodný stav, termín, seq i čas založení: pořadí mezi stranami drží jen t.id.
    const cas = new Date('2026-01-15T10:00:00Z');
    const radek = (id, i, status, company_id = null) => ({
      id, code: id, summary: `Úkol ${r} ${i < 3 ? `trojice-${r} ` : ''}${i}`, status, company_id, created_at: cas, modified_at: cas,
    });
    const radky = [];
    for (let i = 0; i < NEHOTOVYCH; i++) {
      const id = `su-${r}-${String(i).padStart(3, '0')}`;
      nehotove.push(id);
      radky.push(radek(id, i, 'todo', i < 61 ? firma : null));
    }
    for (let i = 0; i < HOTOVYCH; i++) {
      const id = `su-${r}-d${String(i).padStart(2, '0')}`;
      hotove.push(id);
      radky.push(radek(id, 1000 + i, 'done'));
    }
    await sql`INSERT INTO tasks ${sql(radky)}`;
  });

  after(async () => {
    await sql`DELETE FROM time_entries WHERE user_id = ${uzivatel.id}`;
    await sql`DELETE FROM tasks WHERE id = ANY(${[...nehotove, ...hotove]})`;
    await sql`DELETE FROM crm_companies WHERE id = ${firma}`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  const html = async (adresa) => {
    const res = await req.get(adresa);
    assert.equal(res.status, 200, adresa);
    return res.text();
  };

  test('přes 300 úkolů: každý právě jednou, neplatné page nespadne', () => overSeznam({
    req, adresa: `/prace/ukoly?q=${r}`, tokeny: nehotove.map(id => `${adresaDetailu(id)}"`), filtr: { q: r },
  }));

  test('všechny čtyři filtry drží odkazy a platí na každé stránce', () => overSeznam({
    req, adresa: `/prace/ukoly?q=${r}&stav=todo&klient=${firma}&vse=1`,
    tokeny: nehotove.slice(0, 61).map(id => `${adresaDetailu(id)}"`),
    filtr: { q: r, stav: 'todo', klient: firma, vse: 1 },
  }));

  test('hlavička hlásí počet z COUNT česky, ne počet řádků na stránce', async () => {
    assert.ok((await html(`/prace/ukoly?q=${r}`)).includes(`${NEHOTOVYCH} nehotových úkolů odpovídá filtru`));
    assert.ok((await html(`/prace/ukoly?q=${r}&vse=1`)).includes(`${NEHOTOVYCH + HOTOVYCH} úkolů odpovídá filtru`));
    assert.ok((await html(`/prace/ukoly?q=trojice-${r}`)).includes('3 nehotové úkoly odpovídají filtru'));
    assert.ok((await html(`/prace/ukoly?q=${nehotove[7]}`)).includes('1 nehotový úkol odpovídá filtru'));
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM tasks`;
    assert.ok((await html('/prace/ukoly?vse=1')).includes(`${n.toLocaleString('cs-CZ')} úkolů celkem`));
    const [{ m }] = await sql`SELECT COUNT(*)::int AS m FROM tasks WHERE status <> 'done'`;
    assert.ok((await html('/prace/ukoly')).includes(`${m.toLocaleString('cs-CZ')} nehotových úkolů`));
  });

  test('stav=done bez vse=1 ukáže hotové a přepínač „i hotové“ se sám nezapne', async () => {
    const prvni = await html(`/prace/ukoly?q=${r}&stav=done`);
    assert.equal(pocetNa(prvni, hotove), 25, 'plná první stránka hotových');
    assert.equal(pocetNa(prvni, nehotove), 0);
    assert.ok(prvni.includes(`${HOTOVYCH} úkolů odpovídá filtru`), 'hlavička neříká nehotových');
    assert.match(prvni, /name="vse" value="1" class="toggle-input" >/, 'přepínač drží vse z adresy');
    assert.equal(pocetNa(await html(odkazStrany(prvni, 'next')), hotove), 5, 'další stránka drží stav');
    assert.equal(pocetNa(await html(`/prace/ukoly?q=${r}&stav=done&vse=1`), hotove), 25);
  });

  test('výchozí pohled hotové skrývá, vse=1 je řadí na konec', async () => {
    assert.ok(!(await html(`/prace/ukoly?q=${r}&velikost=100&page=4`)).includes(hotove[0]));
    const posledni = await html(`/prace/ukoly?q=${r}&vse=1&velikost=100&page=4`);
    assert.equal(pocetNa(posledni, hotove), HOTOVYCH);
    assert.equal(pocetNa(posledni, nehotove), 5);
    assert.equal(pocetNa(await html(`/prace/ukoly?q=${r}&vse=1`), hotove), 0);
    assert.match(posledni, /name="vse" value="1" class="toggle-input" checked>/);
  });

  test('stopky a stav v řádku vrací na tutéž stránku a filtr, i s diakritikou v dotazu', async () => {
    const q = `Úkol ${r}`;
    const stranka = await html(`/prace/ukoly?q=${encodeURIComponent(q)}&page=2`);
    const back = navrat(stranka);
    assert.equal(back, `/prace/ukoly?${new URLSearchParams({ q, page: 2 })}`);
    const ukol = nehotove.find(id => stranka.includes(`${adresaDetailu(id)}"`));

    let res = await req.post(`${adresaDetailu(ukol)}/stav`, { status: 'in_progress', back });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), back);
    const [{ status }] = await sql`SELECT status FROM tasks WHERE id = ${ukol}`;
    assert.equal(status, 'in_progress');

    res = await req.post('/prace/stopky/start', { ukol_id: ukol, back });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), back);

    const bezi = await html(back);
    assert.match(bezi, /<form method="post" action="\/prace\/stopky\/stop">\s*<input type="hidden" name="back" value="[^"]*q=/, 'Zastavit v řádku nese návrat');
    assert.ok(bezi.includes('title="Měření běží"'), 'běžící úkol je označený');

    res = await req.post('/prace/stopky/stop', { back });
    assert.equal(res.headers.get('location'), back);

    await sql`UPDATE tasks SET status = 'todo', done_at = NULL WHERE id = ${ukol}`;
    await sql`DELETE FROM time_entries WHERE user_id = ${uzivatel.id}`;
  });

  test('cizí návratová adresa se nepoužije', async () => {
    for (const cil of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)']) {
      let res = await req.post(`${adresaDetailu(nehotove[0])}/stav`, { status: 'todo', back: cil });
      assert.equal(res.headers.get('location'), '/prace/ukoly', cil);
      res = await req.post('/prace/stopky/stop', { back: cil });
      assert.equal(res.headers.get('location'), '/prace', cil);
    }
  });

  test('prázdný výsledek filtru: nabídne zrušení, colspan sedí a patička není', async () => {
    const prazdno = await html(`/prace/ukoly?q=${r}-nic&page=3`);
    assert.ok(prazdno.includes('Filtru neodpovídá žádný úkol'));
    assert.ok(prazdno.includes('0 nehotových úkolů odpovídá filtru'));
    assert.ok(!prazdno.includes('class="strankovani"'));
    const sloupcu = /<thead>[\s\S]*?<\/thead>/.exec(prazdno)[0].match(/<th\b/g).length;
    assert.ok(prazdno.includes(`colspan="${sloupcu}"`), `colspan odpovídá ${sloupcu} sloupcům`);
  });

  test('dvojitý parametr nespadne a jednorázové parametry se v odkazech nepřenáší', async () => {
    for (const k of ['q', 'stav', 'klient', 'vse']) await html(`/prace/ukoly?${k}=1&${k}=2`);
    const stranka = await html(`/prace/ukoly?q=${r}&error=souhrn&saved=1`);
    const dalsi = odkazStrany(stranka, 'next');
    assert.ok(!dalsi.includes('error') && !dalsi.includes('saved'), dalsi);
    assert.ok(!/<form method="get"[^>]*>[\s\S]*?name="page"[\s\S]*?<\/form>/.test(stranka), 'filtr nenese page');
  });

  test('velikost stránky a návrat ji drží', async () => {
    const stranka = await html(`/prace/ukoly?q=${r}&velikost=50&page=2`);
    assert.equal(pocetNa(stranka, nehotove), 50);
    assert.equal(navrat(stranka), `/prace/ukoly?q=${r}&velikost=50&page=2`);
  });

  test('řádek: skutečný odkaz, proklik a odznak stavu přes tón', async () => {
    const stranka = await html(`/prace/ukoly?q=${r}`);
    assert.match(stranka, /<a href="\/prace\/ukoly\/su-[^"]+" class="radek-odkaz">/);
    assert.match(stranka, /<tr data-href="\/prace\/ukoly\/su-/);
    assert.ok(!/<tr[^>]*onclick/.test(stranka), 'žádné onclick na řádku');
    assert.match(stranka, /<select name="status" class="stav-vyber badge-varovani" aria-label="Stav úkolu su-/);
  });

  describe('naměřený čas na detailu', () => {
    const POCET = 130; // přes starý LIMIT 100, který kazil součet
    const ukol = () => nehotove[10];
    const poznamky = [];

    before(async () => {
      const zacatek = new Date('2026-02-01T08:00:00Z');
      const konec = new Date('2026-02-01T09:00:00Z');
      const radky = Array.from({ length: POCET }, (_, i) => {
        const note = `mereni-${r}-${String(i).padStart(3, '0')}`;
        poznamky.push(note);
        return { user_id: uzivatel.id, task_id: ukol(), started_at: zacatek, ended_at: konec, note, source: 'rucne' };
      });
      await sql`INSERT INTO time_entries ${sql(radky)}`;
    });

    after(() => sql`DELETE FROM time_entries WHERE task_id = ${ukol()}`);

    test('tabulka stránkuje se shodným začátkem, každé měření právě jednou', () => overSeznam({
      req, adresa: adresaDetailu(ukol()), tokeny: poznamky,
    }));

    test('součet je přes všechna měření a sedí se seznamem úkolů', async () => {
      const detail = await html(adresaDetailu(ukol()));
      assert.match(detail, /celkem <strong>130:00<\/strong>/, 'hlavička sečte i měření za stránkou');
      assert.ok(detail.includes(`${POCET} měření · celkem 130:00`), 'počet v kartě');
      assert.match(await html(`${adresaDetailu(ukol())}?page=4&velikost=25`), /celkem <strong>130:00<\/strong>/, 'součet nezávisí na stránce');
      const seznam = await html(`/prace/ukoly?q=${ukol()}`);
      assert.match(seznam, /<td class="num">130:00<\/td>/);
    });

    test('stopky a stav z detailu vrací na tutéž stránku měření', async () => {
      const detail = await html(`${adresaDetailu(ukol())}?page=2`);
      const back = navrat(detail);
      assert.equal(back, `${adresaDetailu(ukol())}?page=2`);
      const res = await req.post(`${adresaDetailu(ukol())}/stav`, { status: 'todo', back });
      assert.equal(res.headers.get('location'), back);
    });

    test('odkaz zpět nese data-zpet a úkol bez měření nemá patičku', async () => {
      assert.match(await html(adresaDetailu(ukol())), /<a href="\/prace\/ukoly" class="btn btn-outline" data-zpet>/);
      const prazdny = await html(adresaDetailu(nehotove[11]));
      assert.ok(prazdny.includes('Zatím nic naměřeno'));
      assert.ok(prazdny.includes('colspan="4"'));
      assert.ok(!prazdny.includes('class="strankovani"'));
      assert.match(prazdny, /celkem <strong>0:00<\/strong>/);
    });
  });
});
