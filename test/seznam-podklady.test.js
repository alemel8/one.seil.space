// Fakturační podklady a osobní účet proti běžícímu serveru a lokální databázi:
// počet a částka v SQL bez storna, záložky člena se stránkováním, značka druhého
// listu napříč stránkami a klíče měsíců v mřížce mezd.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/seznam-podklady.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';
import { overSeznam, odkazStrany } from './pomocnici/seznamy.js';
import { mzdyPrehled, osobniUcet } from '../src/hr.js';

const kc = (n) => n.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const detailPodkladu = (id) => `/lide/podklady/${id}`;
const pocetNa = (html, ids) => ids.filter(id => html.includes(`${detailPodkladu(id)}"`)).length;

// Průchod stránkami shodu v klíči řazení odhalí jen náhodou, proto i kontrola zdrojů.
test('stránkované dotazy této části řadí až po jednoznačný sloupec', async () => {
  let nalezu = 0;
  for (const soubor of ['src/prace.js', 'src/hr.js', 'src/routes/work.js', 'src/routes/projects.js']) {
    const zdroj = await readFile(new URL(`../${soubor}`, import.meta.url), 'utf8');
    for (const m of zdroj.matchAll(/ORDER BY ([^`]*?)\s+LIMIT \$\{[^}]+\} OFFSET/g)) {
      nalezu++;
      assert.match(m[1], /\.id( DESC)?$/, `${soubor}: ${m[1]}`);
    }
  }
  assert.ok(nalezu >= 6, `nalezeno ${nalezu} dotazů`);
});

describe('fakturační podklady a osobní účet', { skip: PRESKOCIT }, () => {
  const r = 'sk' + Math.random().toString(36).slice(2, 9);
  const POCET = 61;
  const STORNO = 7; // i % 10 === 0 z 61 řádků
  let sql; let req; let sid; let admin; let jana; let petr; let karel; let dana; let eva;
  const podkladyJany = []; const podkladyPetra = []; const platbyJany = []; const mzdyKarla = []; const mzdyDany = [];

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const clen = async (jmeno, is_admin = false) => (await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_active, is_admin)
      VALUES (${`${jmeno}-${r}@example.invalid`}, 'x', ${jmeno}, ${`Test ${r}`}, TRUE, ${is_admin})
      RETURNING id, public_id`)[0];
    admin = await clen('admin', true);
    [jana, petr, karel, dana, eva] = await Promise.all(['jana', 'petr', 'karel', 'dana', 'eva'].map(j => clen(j)));
    await sql`INSERT INTO user_access (user_id, access_key, allowed) VALUES (${admin.id}, 'lide.mzdy', TRUE)`;
    const prihlaseni = await prihlas(sql, admin.id);
    sid = prihlaseni.sid;
    req = pozadavky(prihlaseni.cookie);

    // Shodné datum: pořadí mezi stranami drží jen w.id.
    const radky = Array.from({ length: POCET }, (_, i) => {
      const id = `sk-${r}-${String(i).padStart(3, '0')}`;
      podkladyJany.push(id);
      return { id, user_id: jana.id, report_date: '2026-03-15', title: `Zakázka ${r} ${i}`, total_amount: 100, status: i % 10 === 0 ? 'storno' : 'k_fakturaci' };
    });
    for (let i = 0; i < 3; i++) {
      const id = `sk-${r}-p${i}`;
      podkladyPetra.push(id);
      radky.push({ id, user_id: petr.id, report_date: '2026-03-15', title: `Cizí ${r} ${i}`, total_amount: 1000, status: 'fakturovano' });
    }
    await sql`INSERT INTO hr_work_reports ${sql(radky)}`;

    await sql`INSERT INTO hr_payroll_items ${sql(Array.from({ length: POCET }, (_, i) => {
      const id = `sk-${r}-pl${String(i).padStart(3, '0')}`;
      platbyJany.push(id);
      return { id, user_id: jana.id, kind: 'zaloha', paid_on: '2026-03-15', amount: 50, description: `Platba ${r} ${i}` };
    }))}`;

    // Karel: 61 listů v jednom měsíci, pořadí drží jen r.id.
    await sql`INSERT INTO hr_payroll_runs ${sql(Array.from({ length: POCET }, (_, i) => {
      const id = `sk-${r}-k${String(i).padStart(3, '0')}`;
      mzdyKarla.push(id);
      return { id, user_id: karel.id, period: '2031-05-01', net: 1000, gross: 1200 };
    }))}`;

    // Dana: 24 různých měsíců, pak dvojice téhož měsíce přes hranici stránek a dvě
    // listopadové neděle (2026 a 2020), které měly se starým klíčem „Sun Nov“ shodu.
    const obdobi = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2031, 11 - i, 1)).toISOString().slice(0, 10));
    obdobi.push('2029-12-01', '2029-12-01', '2026-11-01', '2020-11-01');
    await sql`INSERT INTO hr_payroll_runs ${sql(obdobi.map((period, i) => {
      const id = `sk-${r}-d${String(i).padStart(3, '0')}`;
      mzdyDany.push(id);
      return { id, user_id: dana.id, period, net: 1000, gross: 1200 };
    }))}`;

    // Eva: mřížka mezd v roce, kde nikdo jiný nic nemá.
    await sql`INSERT INTO hr_payroll_runs ${sql(['2037-01-01', '2037-03-01', '2037-11-01'].map((period, i) => (
      { id: `sk-${r}-e${i}`, user_id: eva.id, period, net: 1000, gross: 1200, company_cost: 1500 + i, paid: true }
    )))}`;
  });

  after(async () => {
    const lide = [admin, jana, petr, karel, dana, eva].map(u => u.id);
    await sql`DELETE FROM hr_payroll_items WHERE user_id = ANY(${lide})`;
    await sql`DELETE FROM hr_payroll_runs WHERE user_id = ANY(${lide})`;
    await sql`DELETE FROM hr_work_reports WHERE user_id = ANY(${lide})`;
    await sql`DELETE FROM user_access WHERE user_id = ANY(${lide})`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ANY(${lide})`;
    await sql.end();
  });

  const html = async (adresa) => {
    const res = await req.get(adresa);
    assert.equal(res.status, 200, adresa);
    return res.text();
  };

  describe('přehled /lide/podklady', () => {
    test('stránkování se shodným datem: každý podklad právě jednou', () => overSeznam({
      req, adresa: `/lide/podklady?osoba=${jana.public_id}`, tokeny: podkladyJany.map(id => `${detailPodkladu(id)}"`),
      filtr: { osoba: jana.public_id },
    }));

    test('hledání, stav i člověk drží odkazy a platí na každé stránce', () => overSeznam({
      req, adresa: `/lide/podklady?q=${r}&stav=k_fakturaci&osoba=${jana.public_id}`,
      tokeny: podkladyJany.filter((_, i) => i % 10).map(id => `${detailPodkladu(id)}"`),
      filtr: { q: r, stav: 'k_fakturaci', osoba: jana.public_id },
    }));

    test('počet a částka za celý filtr v SQL, storno je v počtu a ne v částce', async () => {
      const ocekavano = kc((POCET - STORNO) * 100);
      const prvni = await html(`/lide/podklady?osoba=${jana.public_id}`);
      assert.ok(prvni.includes(`${POCET} podkladů odpovídá filtru · ${ocekavano} Kč bez storna`), 'hlavička');
      const posledni = await html(`/lide/podklady?osoba=${jana.public_id}&page=3`);
      assert.ok(posledni.includes(`${POCET} podkladů odpovídá filtru · ${ocekavano} Kč bez storna`), 'na poslední stránce stejné číslo');

      const ucet = await osobniUcet(sql, jana.id);
      assert.equal(ucet.prijmy, (POCET - STORNO) * 100, 'stejně jako osobní účet');

      const storna = await html(`/lide/podklady?osoba=${jana.public_id}&stav=storno`);
      assert.ok(storna.includes(`${STORNO} podkladů odpovídá filtru · ${kc(0)} Kč bez storna`));
      const petrovy = await html(`/lide/podklady?q=${encodeURIComponent(`Cizí ${r}`)}`);
      assert.ok(petrovy.includes(`3 podklady odpovídají filtru · ${kc(3000)} Kč bez storna`));
      assert.equal(pocetNa(petrovy, podkladyPetra), 3);
      const [{ pocet, castka }] = await sql`SELECT COUNT(*)::int AS pocet, COALESCE(SUM(total_amount) FILTER (WHERE status <> 'storno'), 0)::float8 AS castka FROM hr_work_reports`;
      assert.ok((await html('/lide/podklady')).includes(`${pocet.toLocaleString('cs-CZ')} podkladů celkem · ${kc(castka)} Kč bez storna`), 'bez filtru');
    });

    test('prázdný výsledek: nabídne zrušení, colspan sedí a patička není', async () => {
      const stranka = await html(`/lide/podklady?q=${r}-nic&page=3`);
      assert.ok(stranka.includes('Filtru neodpovídá žádný podklad'));
      assert.ok(!stranka.includes('class="strankovani"'));
      const sloupcu = /<thead>[\s\S]*?<\/thead>/.exec(stranka)[0].match(/<th\b/g).length;
      assert.ok(stranka.includes(`colspan="${sloupcu}"`));
    });

    test('dvojitý parametr nespadne a jednorázové se nepřenáší', async () => {
      for (const k of ['q', 'stav', 'osoba']) await html(`/lide/podklady?${k}=a&${k}=b`);
      const dalsi = odkazStrany(await html(`/lide/podklady?osoba=${jana.public_id}&saved=1`), 'next');
      assert.ok(!dalsi.includes('saved'), dalsi);
    });

    test('řádek je skutečný odkaz a detail má návrat na seznam a stav česky', async () => {
      const stranka = await html(`/lide/podklady?osoba=${jana.public_id}`);
      assert.match(stranka, /<a href="\/lide\/podklady\/sk-[^"]+" class="radek-odkaz">/);
      assert.match(stranka, /<tr data-href="\/lide\/podklady\/sk-/);
      assert.ok(!/<tr[^>]*onclick/.test(stranka) && !stranka.includes('event.stopPropagation'), 'bez inline obsluhy');
      const detail = await html(detailPodkladu(podkladyJany[1]));
      assert.match(detail, /<a href="\/lide\/podklady" class="btn btn-outline" data-zpet>/);
      assert.ok(detail.includes('>K fakturaci</span>'), 'stav česky, ne k_fakturaci');
    });
  });

  describe('záložky člena', () => {
    const clen = (kdo, q) => `/lide/tym/${kdo.public_id}${q}`;

    test('podklady: stránkují, pruh drží počet a součet je za všechny', async () => {
      await overSeznam({
        req, adresa: clen(jana, '?tab=podklady'), tokeny: podkladyJany.map(id => `${detailPodkladu(id)}"`), filtr: { tab: 'podklady' },
      });
      const druha = await html(clen(jana, '?tab=podklady&page=2'));
      assert.match(druha, /<nav class="tabs" aria-label="Sekce člena týmu">/);
      assert.match(druha, /class="tab active" aria-current="page">Podklady <span class="tab-pocet">61<\/span>/);
      assert.ok(druha.includes(`celkem ${kc((POCET - STORNO) * 100)} Kč bez storna`), 'součet z osobního účtu');
      assert.ok(!druha.includes('(61)'), 'počet není text v závorce');
    });

    test('mzdy: stránkují i se shodným měsícem', () => overSeznam({
      req, adresa: clen(karel, '?tab=mzdy'), tokeny: mzdyKarla.map(id => `/lide/mzdy/${id}"`), filtr: { tab: 'mzdy' },
    }));

    test('značka druhého listu se počítá před LIMIT a rozlišuje rok', async () => {
      const prvni = await html(clen(dana, '?tab=mzdy'));
      const druha = await html(clen(dana, '?tab=mzdy&page=2'));
      const znacek = (h) => (h.match(/>2×<\/span>/g) ?? []).length;
      assert.ok(prvni.includes(`/lide/mzdy/${mzdyDany[24]}"`), 'první list dvojice je na první stránce');
      assert.ok(druha.includes(`/lide/mzdy/${mzdyDany[25]}"`), 'druhý list dvojice je na druhé stránce');
      assert.equal(znacek(prvni), 1, 'značka u listu na první stránce');
      assert.equal(znacek(druha), 1, 'značka i na druhé stránce, kde dvojice není celá; listopady 2026 a 2020 se neshodují');
    });

    test('platby: stránkují a součty na ekonomice je nesledují', async () => {
      await overSeznam({
        req, adresa: clen(jana, '?tab=vydaje'), tokeny: platbyJany.map(id => `/platby/${id}/smazat"`), filtr: { tab: 'vydaje' },
      });
      const ekonomika = await html(clen(jana, '?tab=ekonomika'));
      assert.ok(ekonomika.includes(kc(POCET * 50)), 'platby mimo mzdu za všech 61 řádků');
    });

    test('smazání platby vrátí na tutéž stránku, cizí adresu nepoužije', async () => {
      const stranka = await html(clen(jana, '?tab=vydaje&page=2'));
      const navrat = /name="redirect_to" value="([^"]+)"/.exec(stranka)[1].replace(/&amp;/g, '&');
      assert.equal(navrat, clen(jana, '?tab=vydaje&page=2'));
      const smazana = platbyJany.pop();
      let res = await req.post(`/lide/tym/${jana.public_id}/platby/${smazana}/smazat`, { redirect_to: navrat });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), `${navrat}&saved=1`);
      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM hr_payroll_items WHERE id = ${smazana}`;
      assert.equal(n, 0);

      for (const cil of ['https://evil.example/x', '//evil.example/x', '/\\evil.example']) {
        const dalsi = platbyJany.pop();
        res = await req.post(`/lide/tym/${jana.public_id}/platby/${dalsi}/smazat`, { redirect_to: cil });
        assert.equal(res.headers.get('location'), `/lide/tym/${jana.public_id}?tab=vydaje&saved=1`, cil);
      }
    });

    test('hlášky se v odkazech nepřenáší a záložky bez seznamu patičku nemají', async () => {
      const dalsi = odkazStrany(await html(clen(jana, '?tab=podklady&saved=1&error=castka')), 'next');
      assert.ok(!dalsi.includes('saved') && !dalsi.includes('error'), dalsi);
      assert.ok(!(await html(clen(jana, '?tab=dokumenty'))).includes('class="strankovani"'));
      assert.ok(!(await html(clen(jana, '?tab=xyz'))).includes('class="strankovani"'));
    });

    test('člen bez záznamů: záložka se otevře i se stránkou za koncem a nemá patičku', async () => {
      for (const tab of ['podklady', 'vydaje']) {
        const stranka = await html(clen(eva, `?tab=${tab}&page=9`));
        assert.ok(!stranka.includes('class="strankovani"'), tab);
      }
      assert.ok((await html(clen(eva, '?tab=vydaje'))).includes('Zatím žádné platby mimo mzdu'));
      assert.ok((await html(clen(eva, '?tab=podklady'))).includes('Zatím žádné podklady'));
    });
  });

  describe('mřížka /lide/mzdy', () => {
    test('klíče měsíců jsou rok a měsíc, řazené chronologicky', async () => {
      const { mesice, bunky } = await mzdyPrehled(sql, 2037);
      assert.deepEqual(mesice, ['2037-11', '2037-03', '2037-01']);
      assert.equal(bunky.get(`2037-03|${eva.id}`).id, `sk-${r}-e1`);
    });

    test('stránka ukáže skutečné měsíce a rok, ne 2001, a buňka vede na svůj list', async () => {
      const stranka = await html('/lide/mzdy?rok=2037');
      const mesice = [...stranka.matchAll(/<td style="white-space:nowrap;font-weight:500;">([^<]+)<\/td>/g)].map(m => m[1]);
      assert.deepEqual(mesice, ['listopad 2037', 'březen 2037', 'leden 2037']);
      assert.ok(!stranka.includes('2001'));
      const radek = stranka.slice(stranka.indexOf('březen 2037'), stranka.indexOf('leden 2037'));
      assert.ok(radek.includes(`/lide/mzdy/sk-${r}-e1"`), 'březnová buňka vede na březnový list');
    });
  });

  test('matice přístupů vede na záložku Přístupy, ne na kotvu', async () => {
    const stranka = await html('/lide/pristupy');
    assert.ok(stranka.includes(`/lide/tym/${jana.public_id}?tab=pristupy`));
    assert.ok(!stranka.includes('#pristupy'));
  });

  test('seznam týmu unese dvojitý parametr', () => html('/lide/tym?q=a&q=b'));
});
