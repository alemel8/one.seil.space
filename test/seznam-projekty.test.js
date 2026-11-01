// Seznam projektů a záložky detailu projektu proti běžícímu serveru a lokální
// databázi: stránkování pod mřížkou, počet se stejnými JOINy jako výpis, neznámá
// záložka a hodnota tab z formuláře.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/seznam-projekty.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';
import { overSeznam, odkazStrany } from './pomocnici/seznamy.js';

const adresaDetailu = (id) => `/projekty/${id}`;
const pocetNa = (html, ids) => ids.filter(id => html.includes(`${adresaDetailu(id)}"`)).length;

describe('seznam projektů', { skip: PRESKOCIT }, () => {
  const r = 'sp' + Math.random().toString(36).slice(2, 9);
  const jinyTag = 'sq' + Math.random().toString(36).slice(2, 9);
  const POCET = 122;
  const firma = `sp-f-${r}`; const firma2 = `sp-g-${r}`; const firma3 = `sp-h-${jinyTag}`;
  const projekt = `sp-${jinyTag}`; const podprojekty = [`spi-${jinyTag}-a`, `spi-${jinyTag}-b`];
  const ids = []; const ciziIds = [];
  let sql; let req; let sid; let uzivatel;

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`sp-${r}@example.invalid`}, 'x', TRUE, TRUE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    req = pozadavky(prihlaseni.cookie);
    await sql`INSERT INTO crm_companies ${sql([
      { id: firma, name: `Firma ${r}`, company_type: 'Zákazník' },
      { id: firma2, name: `Hledaná ${r}`, company_type: 'Zákazník' },
      { id: firma3, name: `Třetí ${jinyTag}`, company_type: 'Zákazník' },
    ])}`;
    // Shodné modified_at: pořadí mezi stranami drží jen p.id.
    const cas = new Date('2026-01-15T10:00:00Z');
    const radky = Array.from({ length: POCET }, (_, i) => {
      const id = `sp-${r}-${String(i).padStart(3, '0')}`;
      ids.push(id);
      return { id, company_id: firma, name: `Projekt ${r} ${i}`, status: i % 2 ? 'Pozastaveno' : 'Aktivní', created_at: cas, modified_at: cas };
    });
    for (let i = 0; i < 3; i++) {
      const id = `sp-${r}-g${i}`;
      ciziIds.push(id);
      radky.push({ id, company_id: firma2, name: `Bez značky ${i}`, status: 'Dokončeno', created_at: cas, modified_at: cas });
    }
    radky.push({ id: projekt, company_id: firma3, name: `Detail ${jinyTag}`, status: 'Aktivní', created_at: cas, modified_at: cas });
    await sql`INSERT INTO projects ${sql(radky)}`;
    await sql`INSERT INTO project_items ${sql(podprojekty.map(id => ({ id, project_id: projekt, type: 'web', name: `Web ${id}`, status: 'V přípravě' })))}`;
  });

  after(async () => {
    await sql`DELETE FROM project_items WHERE id = ANY(${podprojekty})`;
    await sql`DELETE FROM projects WHERE id = ANY(${[...ids, ...ciziIds, projekt]})`;
    await sql`DELETE FROM crm_companies WHERE id = ANY(${[firma, firma2, firma3]})`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  const html = async (adresa) => {
    const res = await req.get(adresa);
    assert.equal(res.status, 200, adresa);
    return res.text();
  };

  test('stránkování se shodným modified_at: každý projekt právě jednou, neplatné page nespadne', () => overSeznam({
    req, adresa: `/projekty?q=${r}`, tokeny: [...ids, ...ciziIds].map(id => `${adresaDetailu(id)}"`), filtr: { q: r },
  }));

  test('hledání i stav drží odkazy a platí na každé stránce', () => overSeznam({
    req, adresa: `/projekty?q=${r}&status=Pozastaveno`,
    tokeny: ids.filter((_, i) => i % 2).map(id => `${adresaDetailu(id)}"`),
    filtr: { q: r, status: 'Pozastaveno' },
  }));

  test('počet má stejné JOINy jako výpis: hledání podle jména klienta', async () => {
    const stranka = await html(`/projekty?q=${encodeURIComponent(`Hledaná ${r}`)}`);
    assert.ok(stranka.includes('3 projekty odpovídají filtru'), 'hlavička z COUNT');
    assert.equal(pocetNa(stranka, ciziIds), 3);
    assert.match(stranka, /<strong>1–3<\/strong> z <strong>3<\/strong>/);
  });

  test('hlavička česky a z COUNT, ne počet karet na stránce', async () => {
    assert.ok((await html(`/projekty?q=${r}`)).includes(`${POCET + 3} projektů odpovídá filtru`));
    assert.ok((await html(`/projekty?q=${encodeURIComponent(`Bez značky 1`)}`)).includes('1 projekt odpovídá filtru'));
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM projects`;
    assert.ok((await html('/projekty')).includes(`${n.toLocaleString('cs-CZ')} projektů celkem`));
  });

  test('prázdný výsledek: nabídne zrušení filtru a nemá patičku', async () => {
    const stranka = await html(`/projekty?q=${r}-nic&page=3`);
    assert.ok(stranka.includes('Filtru neodpovídá žádný projekt'));
    assert.ok(stranka.includes('Zrušit filtr'));
    assert.ok(!stranka.includes('class="strankovani"'));
  });

  test('dvojitý parametr nespadne a jednorázové se nepřenáší', async () => {
    await html(`/projekty?q=${r}&q=jine`);
    await html('/projekty?status=a&status=b');
    const dalsi = odkazStrany(await html(`/projekty?q=${r}&saved=1`), 'next');
    assert.ok(!dalsi.includes('saved'), dalsi);
  });

  test('karta je skutečný odkaz a stav má tón', async () => {
    const stranka = await html(`/projekty?q=${r}`);
    assert.match(stranka, /<a href="\/projekty\/sp-[^"]+" class="card"/);
    assert.ok(!/class="card[^"]*"[^>]*onclick/.test(stranka), 'žádné onclick na kartě');
    assert.match(stranka, /class="badge badge-ok"[^>]*>Aktivní</);
    assert.match(stranka, /class="badge badge-varovani"[^>]*>Pozastaveno</);
    assert.ok(!stranka.includes('var(--success-bg)'), 'barvy stavů jdou z tónů');
  });

  describe('záložky detailu', () => {
    const aktivni = (popisek) => new RegExp(`class="tab active" aria-current="page">${popisek}`);

    test('neznámý klíč i pole otevřou Přehled, ne prázdnou stránku', async () => {
      for (const q of ['?tab=xyz', '?tab=constructor', '?tab=__proto__', '?tab=a&tab=b', '?tab=']) {
        const stranka = await html(`${adresaDetailu(projekt)}${q}`);
        assert.match(stranka, aktivni('Přehled'), q);
        assert.ok(stranka.includes('id="formProjekt"'), `${q}: obsah Přehledu`);
        assert.ok(stranka.includes('href="?tab=prehled&amp;upravit=1"'), `${q}: tužka vede na platnou záložku`);
      }
    });

    test('pruh jde přes společný include s počtem v odznaku a detail má návrat na seznam', async () => {
      const stranka = await html(`${adresaDetailu(projekt)}?tab=podprojekty`);
      assert.match(stranka, /<nav class="tabs" aria-label="Sekce projektu">/);
      assert.match(stranka, /class="tab active" aria-current="page">Podprojekty <span class="tab-pocet">2<\/span>/);
      assert.ok(stranka.includes(`/projekty/podprojekty/${podprojekty[0]}`), 'karta podprojektu');
      assert.match(stranka, /<a href="\/projekty" class="btn btn-ghost btn-sm" data-zpet>/);
    });

    test('tab z formuláře jde do přesměrování jen jako platný klíč', async () => {
      const teloProjektu = { name: `Detail ${jinyTag}`, status: 'Aktivní', billing_currency: 'CZK' };
      for (const [tab, ocekavano] of [
        ['podprojekty', 'podprojekty'], ['prehled', 'prehled'], [undefined, 'prehled'], ['xyz', 'prehled'],
        ['prehled&x=1', 'prehled'], ['https://evil.example', 'prehled'],
      ]) {
        const res = await req.post(adresaDetailu(projekt), tab === undefined ? teloProjektu : { ...teloProjektu, tab });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), `${adresaDetailu(projekt)}?tab=${ocekavano}&saved=1`, String(tab));
      }
    });
  });
});
