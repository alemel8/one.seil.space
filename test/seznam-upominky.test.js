// Seznam upomínek: záložky se stavem a počty, stránkování každé z nich včetně Vše,
// návrat na tutéž záložku a stránku po Odeslat a Zrušit.
//
//   node --test test/seznam-upominky.test.js        (jen šablona bez serveru)
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/seznam-upominky.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';
import { overSeznam, odkazStrany } from './pomocnici/seznamy.js';
import { vykresliStranku } from './pomocnici/render.js';
import { strankovani } from '../src/strankovani.js';

const SEZNAM = '/ucetnictvi/upominky';
const detail = (id) => `/ucetnictvi/vydane-faktury/${id}`;

describe('šablona upomínek bez serveru', () => {
  const zalozky = ['ceka', 'odeslana', 'zrusena', 'vse'].map(klic => ({ klic, popisek: klic, pocet: 0 }));
  const vykresli = (prepis = {}) => vykresliStranku('invoices/reminders', {
    reminders: [], tab: 'ceka', strany: strankovani({ cesta: SEZNAM, query: {}, celkem: 0 }), zalozky,
    adresaZalozky: (k) => `${SEZNAM}?status=${k}`, sent: false, error: false, ...prepis,
  });
  const sloupcu = (html) => html.slice(html.indexOf('<thead>'), html.indexOf('</thead>')).match(/<th\b/g).length;

  test('vzhled seznamu: hlavička, záložky, tabulka, žádná tlačítka místo záložek', async () => {
    const html = await vykresli();
    assert.ok(html.includes('class="page-header"'));
    assert.ok(html.includes('<nav class="tabs" aria-label="Stav upomínek">'));
    assert.ok(html.includes('class="table-wrapper"'));
    assert.ok(html.includes('class="data-table"'));
    assert.ok(!html.includes('class="table"'));
  });

  for (const [tab, text] of [['ceka', 'Žádné upomínky k odeslání'], ['odeslana', 'Zatím žádné odeslané upomínky'], ['zrusena', 'Žádné zrušené upomínky'], ['vse', 'Zatím žádné upomínky']]) {
    test(`prázdná záložka ${tab}: vlastní text, colspan podle sloupců, bez patičky`, async () => {
      const html = await vykresli({ tab });
      assert.ok(html.includes(text));
      assert.equal(Number(/<td colspan="(\d+)">/.exec(html)[1]), sloupcu(html));
      assert.ok(!html.includes('class="strankovani"'));
    });
  }

  test('hlášky přes tóny, text z adresy se nevypisuje', async () => {
    assert.ok((await vykresli({ sent: true })).includes('class="hlaska hlaska-ok"'));
    assert.ok((await vykresli({ error: true })).includes('class="hlaska hlaska-chyba"'));
    assert.ok(!(await vykresli()).includes('class="hlaska'));
  });

  test('řádek: stavy přes tón, chybějící e-mail zablokuje Odeslat, útočný text se escapuje', async () => {
    const radek = {
      id: 7, invoice_id: 'inv1', number: 'F<1>', level: 2, days_overdue: 1, status: 'ceka', client_name: '<img src=x onerror=alert(1)>',
      total_amount: '121.00', currency: 'CZK', due_date: new Date('2026-01-01T00:00:00Z'), email: '', sent_at: null, sent_to: '',
    };
    let html = await vykresli({ reminders: [radek] });
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('1 den'));
    assert.match(html, /class="btn btn-primary btn-sm" disabled/);
    assert.ok(html.includes('chybí e-mail'));
    html = await vykresli({ reminders: [{ ...radek, status: 'odeslana', sent_at: new Date('2026-03-02T10:00:00Z'), sent_to: 'komu@example.invalid', days_overdue: 3 }] });
    assert.ok(html.includes('class="badge badge-ok">odesláno 2. 3. 2026'));
    assert.ok(html.includes('komu@example.invalid'));
    assert.ok(html.includes('3 dny'));
    assert.ok(!html.includes('/odeslat"'));
    html = await vykresli({ reminders: [{ ...radek, status: 'zrusena', days_overdue: 12 }] });
    assert.ok(html.includes('class="badge badge-neutral">zrušena'));
    assert.ok(html.includes('12 dní'));
  });

  test('dotazy na e-mail běží až po LIMIT, ne pro všechny upomínky', () => {
    const zdroj = readFileSync(fileURLToPath(new URL('../src/routes/invoices.js', import.meta.url)), 'utf8');
    const routa = zdroj.slice(zdroj.indexOf(`fastify.get('/ucetnictvi/upominky'`), zdroj.indexOf(`fastify.post('/ucetnictvi/upominky/:id/odeslat'`));
    const limit = routa.indexOf('LIMIT ${strany.naStranku}');
    assert.ok(limit > 0);
    assert.ok(limit < routa.indexOf('resolveClientEmail'));
    assert.match(routa, /ORDER BY r\.level DESC, r\.days_overdue DESC, r\.id DESC/);
  });
});

describe('seznam upomínek', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  const NA_STAV = 61;
  const STAVY = ['ceka', 'odeslana', 'zrusena'];
  let sql; let sid; let req; let uzivatel;
  const faktury = [];
  const upominky = {};

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`su-${r}@example.invalid`}, 'x', TRUE, TRUE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    req = pozadavky(prihlaseni.cookie);

    // Zaplacené faktury: worker je nepřepne a upomínky k nim nepřidá. Shodný stupeň
    // i dny po splatnosti, pořadí mezi stranami drží jen id; level 9 a tolik dní
    // je dá nahoru bez ohledu na cizí data.
    const cas = new Date('2026-01-15T10:00:00Z');
    const radky = STAVY.flatMap(stav => Array.from({ length: NA_STAV }, (_, i) => ({
      id: `su-${r}-${stav}-${String(i).padStart(3, '0')}`, type: 'issued', number: `SU${r}${stav}${i}`, status: 'Zaplacena',
      client_name: `Klient ${r}`, client_email: `klient-${r}@example.invalid`, issue_date: '2026-01-01', due_date: '2026-01-10',
      amount: 100, vat_amount: 21, total_amount: 121, currency: 'CZK', created_at: cas, modified_at: cas,
    })));
    faktury.push(...radky.map(x => x.id));
    await sql`INSERT INTO accounting_invoices ${sql(radky)}`;
    for (const stav of STAVY) {
      const zaznamy = radky.filter(x => x.id.includes(`-${stav}-`)).map(x => ({
        invoice_id: x.id, level: 9, days_overdue: 99999, status: stav,
        sent_at: stav === 'odeslana' ? cas : null, sent_to: stav === 'odeslana' ? x.client_email : '',
      }));
      upominky[stav] = await sql`INSERT INTO invoice_reminders ${sql(zaznamy)} RETURNING id, invoice_id`;
    }
  });

  after(async () => {
    await sql`DELETE FROM accounting_invoices WHERE id = ANY(${faktury})`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  const html = async (adresa) => {
    const res = await req.get(adresa);
    assert.equal(res.status, 200, adresa);
    return res.text();
  };
  // Všechny řádky záložky včetně cizích, overSeznam kontroluje i celkový počet.
  const tokenyStavu = async (stav) => {
    const radky = stav === 'vse'
      ? await sql`SELECT invoice_id FROM invoice_reminders`
      : await sql`SELECT invoice_id FROM invoice_reminders WHERE status = ${stav}`;
    return radky.map(x => detail(x.invoice_id));
  };
  const pocetZalozky = (stranka, popisek) => new RegExp(`${popisek} <span class="tab-pocet">([^<]*)</span>`).exec(stranka)?.[1];
  const aktivni = (stranka) => /class="tab active" aria-current="page">([^<]*?) </.exec(stranka)?.[1];

  test('Čeká na odeslání je výchozí záložka: stránkování bez parametru v odkazech', async () => overSeznam({
    req, adresa: SEZNAM, tokeny: await tokenyStavu('ceka'),
  }));

  test('Odeslané: stránkování a odkazy drží záložku', async () => overSeznam({
    req, adresa: `${SEZNAM}?status=odeslana`, tokeny: await tokenyStavu('odeslana'), filtr: { status: 'odeslana' },
  }));

  test('Zrušené: stránkování a odkazy drží záložku', async () => overSeznam({
    req, adresa: `${SEZNAM}?status=zrusena`, tokeny: await tokenyStavu('zrusena'), filtr: { status: 'zrusena' },
  }));

  test('Vše: všechny stavy, stránkování a odkazy drží záložku', async () => overSeznam({
    req, adresa: `${SEZNAM}?status=vse`, tokeny: await tokenyStavu('vse'), filtr: { status: 'vse' },
  }));

  test('záložka ukazuje jen svůj stav', async () => {
    const stranka = await html(`${SEZNAM}?status=odeslana&velikost=100`);
    assert.equal(upominky.odeslana.filter(u => stranka.includes(detail(u.invoice_id))).length, NA_STAV);
    assert.equal(upominky.zrusena.filter(u => stranka.includes(detail(u.invoice_id))).length, 0);
    assert.equal(upominky.ceka.filter(u => stranka.includes(detail(u.invoice_id))).length, 0);
    assert.ok(stranka.includes('class="badge badge-ok">odesláno 15. 1. 2026'));
    assert.ok(!stranka.includes('/odeslat"'));
  });

  test('výchozí adresa i ?status=ceka jsou tatáž záložka, tlačítka jsou jen tady', async () => {
    for (const adresa of [SEZNAM, `${SEZNAM}?status=ceka`, `${SEZNAM}?status=nesmysl`, `${SEZNAM}?status=__proto__`]) {
      const stranka = await html(adresa);
      assert.equal(aktivni(stranka), 'Čeká na odeslání', adresa);
      assert.ok(stranka.includes('/odeslat"'), adresa);
      assert.equal(new URL(odkazStrany(stranka, 'next'), 'http://x').searchParams.get('status'), null, adresa);
    }
  });

  test('staré ?status= (prázdné) je Vše, i na další stránce', async () => {
    for (const adresa of [`${SEZNAM}?status=`, `${SEZNAM}?status=&page=2`, `${SEZNAM}?status=vse&page=2`]) {
      const stranka = await html(adresa);
      assert.equal(aktivni(stranka), 'Vše', adresa);
      assert.equal(new URL(odkazStrany(stranka, 'next'), 'http://x').searchParams.get('status'), 'vse', adresa);
    }
    const druha = await html(`${SEZNAM}?status=&page=2`);
    assert.ok(druha.includes('aria-current="page">2</span>'));
  });

  test('počty v odznacích sedí s databází, Vše je součet', async () => {
    const skupiny = await sql`SELECT status, COUNT(*)::int AS n FROM invoice_reminders GROUP BY status`;
    const pocet = (s) => skupiny.find(x => x.status === s)?.n ?? 0;
    for (const adresa of [SEZNAM, `${SEZNAM}?status=vse&page=2`]) {
      const stranka = await html(adresa);
      assert.equal(pocetZalozky(stranka, 'Čeká na odeslání'), String(pocet('ceka')));
      assert.equal(pocetZalozky(stranka, 'Odeslané'), String(pocet('odeslana')));
      assert.equal(pocetZalozky(stranka, 'Zrušené'), String(pocet('zrusena')));
      assert.equal(pocetZalozky(stranka, 'Vše'), String(skupiny.reduce((s, x) => s + x.n, 0)));
    }
    assert.ok((await html(SEZNAM)).includes(`href="${SEZNAM}?status=zrusena" class="tab"`));
  });

  test('sent a error se ukážou jednou a v odkazech ani návratu nejsou', async () => {
    const stranka = await html(`${SEZNAM}?status=vse&page=2&sent=1&error=1`);
    assert.ok(stranka.includes('Upomínka byla odeslána.'));
    assert.ok(stranka.includes('Upomínku se nepodařilo odeslat'));
    for (const rel of ['next', 'prev']) {
      const odkaz = odkazStrany(stranka, rel);
      assert.ok(!/sent|error/.test(odkaz), odkaz);
    }
    assert.ok(!/name="redirect_to" value="[^"]*(sent|error)/.test(stranka));
    assert.ok(!/data-seznam="[^"]*(sent|error)/.test(stranka));
    assert.ok(!(await html(SEZNAM)).includes('Upomínka byla odeslána.'));
  });

  test('velikost stránky platí a odkazy ji drží', async () => {
    const stranka = await html(`${SEZNAM}?status=odeslana&velikost=50`);
    assert.equal(upominky.odeslana.filter(u => stranka.includes(detail(u.invoice_id))).length, 50);
    assert.ok(odkazStrany(stranka, 'next').includes('velikost=50'));
  });

  test('řádek je odkaz na fakturu a akce ho nepřebírají', async () => {
    const stranka = await html(`${SEZNAM}?status=vse`);
    assert.match(stranka, /<tr data-href="\/ucetnictvi\/vydane-faktury\/su-/);
    assert.match(stranka, /<a href="\/ucetnictvi\/vydane-faktury\/su-[^"]+" class="radek-odkaz">/);
    assert.ok(stranka.includes('data-bez-prokliku'));
    assert.ok(!stranka.includes('class="table"'));
  });

  describe('návrat po akci', () => {
    const navratZeStranky = async (adresa) => {
      const stranka = await html(adresa);
      return /name="redirect_to" value="([^"]+)"/.exec(stranka)[1].replace(/&amp;/g, '&');
    };

    test('Zrušit vrátí na tutéž záložku a stránku a změní stav', async () => {
      // Řazení podle id: na stránce 6 záložky Vše jsou čekající, ty mají tlačítka.
      const navrat = await navratZeStranky(`${SEZNAM}?status=vse&page=6`);
      assert.equal(navrat, `${SEZNAM}?status=vse&page=6`);
      const u = upominky.ceka[0];
      const res = await req.post(`${SEZNAM}/${u.id}/zrusit`, { redirect_to: navrat });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), navrat);
      const [radek] = await sql`SELECT status FROM invoice_reminders WHERE id = ${u.id}`;
      assert.equal(radek.status, 'zrusena');
    });

    test('Zrušit na výchozí záložce drží stránku', async () => {
      const navrat = await navratZeStranky(`${SEZNAM}?page=2`);
      assert.equal(navrat, `${SEZNAM}?page=2`);
      const res = await req.post(`${SEZNAM}/${upominky.ceka[1].id}/zrusit`, { redirect_to: navrat });
      assert.equal(res.headers.get('location'), navrat);
    });

    test('Odeslat bez e-mailu: chyba na téže záložce a stránce, hláška se ukáže', async () => {
      const [faktura] = await sql`INSERT INTO accounting_invoices
        (id, type, number, status, client_name, issue_date, amount, vat_amount, total_amount, currency)
        VALUES (${`su-${r}-bez`}, 'issued', ${`SU${r}bez`}, 'Zaplacena', 'Bez e-mailu', '2026-01-01', 100, 21, 121, 'CZK') RETURNING id`;
      faktury.push(faktura.id);
      const [u] = await sql`INSERT INTO invoice_reminders (invoice_id, level, days_overdue, status) VALUES (${faktura.id}, 9, 99999, 'ceka') RETURNING id`;

      const res = await req.post(`${SEZNAM}/${u.id}/odeslat`, { email: '', redirect_to: `${SEZNAM}?status=vse&page=2` });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), `${SEZNAM}?status=vse&page=2&error=1`);
      const stranka = await html(res.headers.get('location'));
      assert.ok(stranka.includes('class="hlaska hlaska-chyba"'));
      assert.ok(!odkazStrany(stranka, 'next').includes('error'));

      const vychozi = await req.post(`${SEZNAM}/${u.id}/odeslat`, { email: '', redirect_to: SEZNAM });
      assert.equal(vychozi.headers.get('location'), `${SEZNAM}?error=1`);
    });

    test('Odeslat s neexistující adresou: výsledek do adresy, pokus do historie', async () => {
      const u = upominky.ceka[2];
      const res = await req.post(`${SEZNAM}/${u.id}/odeslat`, { email: 'nikdo@example.invalid', redirect_to: `${SEZNAM}?page=2` });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), `${SEZNAM}?page=2&error=1`);
      const [log] = await sql`SELECT kind, status FROM invoice_emails WHERE invoice_id = ${u.invoice_id}`;
      assert.deepEqual({ ...log }, { kind: 'upominka', status: 'chyba' });
    });

    test('cizí návratová adresa se nepoužije', async () => {
      for (const cil of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'evil.example', '']) {
        const zrusit = await req.post(`${SEZNAM}/${upominky.ceka[3].id}/zrusit`, { redirect_to: cil });
        assert.equal(zrusit.headers.get('location'), SEZNAM, `zrušit ${cil}`);
        const odeslat = await req.post(`${SEZNAM}/${upominky.ceka[4].id}/odeslat`, { email: 'nikdo@example.invalid', redirect_to: cil });
        assert.equal(odeslat.headers.get('location'), `${SEZNAM}?error=1`, `odeslat ${cil}`);
      }
    });

    test('bez návratové adresy výchozí seznam', async () => {
      const res = await req.post(`${SEZNAM}/${upominky.ceka[5].id}/zrusit`, {});
      assert.equal(res.headers.get('location'), SEZNAM);
    });

    test('stránka za koncem po akci ukáže poslední řádky', async () => {
      const stranka = await html(`${SEZNAM}?status=zrusena&page=9999`);
      assert.ok(!stranka.includes('Žádné zrušené upomínky'));
      assert.match(stranka, /aria-current="page">\d+<\/span>/);
    });
  });
});
