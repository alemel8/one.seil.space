// Seznamy a záložky sekce Marketing: stránkování ručních nákladů a běhů syncu,
// návrat po smazání v řádku, záložky přehledu a odkazy v hlavičce podle práv.
// Čísla přehledu hlídá test/marketing-route.test.js.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/seznam-marketing.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';
import { overSeznam, odkazStrany } from './pomocnici/seznamy.js';
import { vykresliStranku } from './pomocnici/render.js';
import { rozsahCesky } from '../src/marketing/obdobi.js';
import { strankovani } from '../src/strankovani.js';

const ZALOZKY = [['prehled', 'Přehled'], ['kanaly', 'Kanály'], ['vyhledavani', 'Vyhledávání a e-shop']];

const dekoduj = (a) => a.replace(/&amp;/g, '&');
const hrefy = (blok) => [...blok.matchAll(/href="([^"]*)"/g)].map(m => dekoduj(m[1]));
const parametry = (adresa) => new URL(adresa, 'http://x').searchParams;
const pruhZalozek = (html) => /<nav class="tabs"[^]*?<\/nav>/.exec(html)?.[0] ?? '';
const prepinacEshopu = (html) => /<nav aria-label="E-shop"[^]*?<\/nav>/.exec(html)?.[0] ?? '';
const paticka = (html) => /<div class="strankovani"[^]*?<\/nav>/.exec(html)?.[0] ?? '';
const aktivniZalozka = (html) => /class="tab active" aria-current="page">([^<]+)</.exec(pruhZalozek(html))?.[1];

describe('Marketing bez aktivního e-shopu', () => {
  const spolecne = { eshopy: [], shop: null, vychoziEshop: 'toneracek', saved: false, error: null, dotaz: () => '' };

  test('přehled nespadne a záložky neukazuje', async () => {
    const html = await vykresliStranku('marketing/prehled', {
      ...spolecne, prehled: null, dotazPrehledu: () => '', zalozky: ZALOZKY, tab: 'prehled',
      obdobi: { preset: 'tento-mesic', od: '2026-11-01', do: '2026-11-30', popis: 'listopad 2026' },
    });
    assert.ok(html.includes('Žádný aktivní e-shop'));
    assert.ok(!html.includes('class="tabs"'));
    assert.ok(!html.includes('page-header-akce'), 'odkazy v hlavičce potřebují e-shop');
  });

  test('ruční náklady nespadnou', async () => {
    const html = await vykresliStranku('marketing/naklady', {
      ...spolecne, naklady: [], strany: null, smazano: false, platformy: [], platformaPopis: {}, rozsahCesky, dnes: '2026-11-01',
    });
    assert.ok(html.includes('Žádný aktivní e-shop'));
    assert.ok(!html.includes('class="strankovani"'));
  });

  const stranaSync = (locals) => vykresliStranku('marketing/sync', {
    ...spolecne, zdroje: [], behy: [], strany: null, rozsahCesky, zadnyBeh: false, behSChybou: false,
    maGoogleSa: true, maSecretsKey: true, jeAdmin: false, ...locals,
  });

  test('synchronizace nespadne', async () => {
    const html = await stranaSync();
    assert.ok(html.includes('Žádný aktivní e-shop'));
    assert.ok(!html.includes('class="strankovani"'));
  });

  test('čas běhu je pražský i na serveru v UTC', async () => {
    const puvodni = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      const html = await stranaSync({
        shop: { id: 1, slug: 'toneracek', name: 'Toneráček' },
        strany: strankovani({ cesta: '/marketing/sync', query: {}, celkem: 1, naStranku: 50 }),
        behy: [{ started_at: new Date('2026-01-15T10:00:00Z'), platform: 'ga4', kind: 'auto', status: 'hotovo', from_date: new Date('2026-01-01T00:00:00Z'), to_date: new Date('2026-01-14T00:00:00Z'), rows_saved: 1234, attempt: 1, error: '' }],
      });
      assert.ok(html.replace(/\u00a0/g, ' ').includes('15. 1. 2026 11:00'), 'v zimě je Praha UTC+1');
      assert.ok(html.includes('1. 1. – 14. 1. 2026'), 'okno běhu česky');
    } finally {
      if (puvodni === undefined) delete process.env.TZ; else process.env.TZ = puvodni;
    }
  });
});

describe('seznamy a záložky Marketingu', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  // Víc než dřívější tiché stropy: 200 u nákladů, 50 u běhů.
  const POCET_NAKLADU = 205;
  const POCET_BEHU = 111;
  const POCET_MAZANI = 26;
  const OBDOBI = 'obdobi=vlastni&od=2026-01-01&do=2026-01-31';
  const sids = [];
  const uzivatele = [];
  const eshopy = [];
  let sql;
  let req;
  let bezny;
  let beznyId;
  let spravce;
  let shop;
  let shopMazani;
  let shopPrazdny;
  let idsNakladu;
  let idsMazani;
  let behy;

  const zalozUzivatele = async (jmeno, jeAdmin) => {
    const [u] = await sql`INSERT INTO users (email, password_hash, first_name, last_name, is_active, is_admin)
      VALUES (${`${jmeno}-${r}@example.invalid`}, 'x', 'Test', ${jmeno}, TRUE, ${jeAdmin}) RETURNING id`;
    uzivatele.push(u.id);
    const { sid, cookie } = await prihlas(sql, u.id);
    sids.push(sid);
    return { id: u.id, req: pozadavky(cookie) };
  };

  const zalozEshop = async (pripona) => {
    const [s] = await sql`INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address)
      VALUES (${`mkt-${pripona}-${r}`}, ${`Marketing ${pripona} ${r}`}, 'https://example.invalid', TRUE, 'Test', 'noreply@example.invalid') RETURNING *`;
    eshopy.push(s.id);
    return s;
  };

  const zalozNaklady = async (shopId, pocet, datum = '2026-01-15') => {
    const radky = Array.from({ length: pocet }, (_, i) => ({
      shop_id: shopId, platform: 'heureka', date_from: datum, date_to: datum, amount: 100, note: `naklad-${r}-${i}`, created_by: spravce.id,
    }));
    return (await sql`INSERT INTO marketing_manual_costs ${sql(radky)} RETURNING id`).map(x => x.id);
  };

  const odeberPrava = async (userId, klice) => {
    for (const klic of klice) await sql`INSERT INTO user_access (user_id, access_key, allowed) VALUES (${userId}, ${klic}, FALSE)`;
  };
  const vratPrava = (userId) => sql`DELETE FROM user_access WHERE user_id = ${userId}`;

  const nacti = async (klient, adresa) => {
    const res = await klient.get(adresa);
    assert.equal(res.status, 200, `${adresa} vrací ${res.status}`);
    return (await res.text()).replace(/ /g, ' ');
  };

  const prehled = (dalsi = '') => `/marketing?eshop=${shop.slug}&${OBDOBI}${dalsi}`;

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    spravce = await zalozUzivatele('spravce', true);
    req = spravce.req;
    ({ id: beznyId, req: bezny } = await zalozUzivatele('bezny', false));
    shop = await zalozEshop('seznam');
    shopMazani = await zalozEshop('mazani');
    shopPrazdny = await zalozEshop('prazdny');

    // Shodný klíč řazení: pořadí mezi stranami drží jen id.
    idsNakladu = await zalozNaklady(shop.id, POCET_NAKLADU);
    idsMazani = await zalozNaklady(shopMazani.id, POCET_MAZANI);

    // Vypnutý zdroj: server má workery a aktivní zdroj by mu mohl přidat běh.
    const [zdroj] = await sql`INSERT INTO marketing_sources (shop_id, platform, active, external_id) VALUES (${shop.id}, 'ga4', FALSE, 'test') RETURNING id`;
    const cas = new Date('2026-01-15T10:00:00Z');
    const radky = Array.from({ length: POCET_BEHU }, (_, i) => ({
      source_id: zdroj.id, shop_id: shop.id, platform: 'ga4', kind: 'rucni', run_date: '2026-01-15', status: 'hotovo',
      error: `beh-${r}-${String(i).padStart(3, '0')}`, started_at: cas, finished_at: cas,
    }));
    behy = await sql`INSERT INTO marketing_sync_runs ${sql(radky)} RETURNING id, error`;

    // Řádky pro záložky přehledu.
    const den = '2026-01-15';
    await sql`INSERT INTO marketing_daily_stats ${sql([
      { shop_id: shop.id, platform: 'ga4', date: den, sessions: 1000, purchase: 10, purchase_revenue: 5000 },
      { shop_id: shop.id, platform: 'ga4', date: den, segment_kind: 'channel', segment: 'Organic Search', sessions: 1000, purchase: 10, purchase_revenue: 5000 },
      { shop_id: shop.id, platform: 'search_console', date: den, clicks: 500, impressions: 9000, position_sum: 27000 },
      { shop_id: shop.id, platform: 'merchant', date: den, clicks: 40, impressions: 800, approved_items: 100, disapproved_items: 2 },
      { shop_id: shop.id, platform: 'eshop', date: den, searches_no_result: 7, carts_abandoned: 3, carts_value: 900 },
      ...Array.from({ length: 12 }, (_, i) => ({
        shop_id: shop.id, platform: 'search_console', date: den, segment_kind: 'query', segment: `dotaz-${r}-${String(i).padStart(2, '0')}`,
        clicks: 100 - i, impressions: 1000, position_sum: 3000,
      })),
    ].map(x => ({ segment_kind: '', segment: '', sessions: 0, purchase: 0, purchase_revenue: 0, clicks: 0, impressions: 0, position_sum: 0, approved_items: 0, disapproved_items: 0, searches_no_result: 0, carts_abandoned: 0, carts_value: 0, ...x })))}`;
  });

  after(async () => {
    if (!sql) return;
    if (eshopy.length) await sql`DELETE FROM shops WHERE id = ANY(${eshopy})`;
    if (uzivatele.length) await sql`DELETE FROM user_access WHERE user_id = ANY(${uzivatele})`;
    if (sids.length) await sql`DELETE FROM session WHERE sid = ANY(${sids})`;
    if (uzivatele.length) await sql`DELETE FROM users WHERE id = ANY(${uzivatele})`;
    await sql.end();
  });

  // ── Ruční náklady ──────────────────────────────────────────

  const tokenNakladu = (id) => `/marketing/naklady/${id}/smazat`;

  test('ruční náklady: shodné date_from, každý řádek právě jednou, nad dřívějším limitem 200', () => overSeznam({
    req, adresa: `/marketing/naklady?eshop=${shop.slug}`, tokeny: idsNakladu.map(tokenNakladu), filtr: { eshop: shop.slug },
  }));

  test('ruční náklady: shodné datum řadí id sestupně, novější období je první', async () => {
    const nejnovejsi = [...idsNakladu].reverse().slice(0, 25);
    const html = await nacti(req, `/marketing/naklady?eshop=${shop.slug}`);
    const poradi = [...html.matchAll(/\/marketing\/naklady\/(\d+)\/smazat/g)].map(m => Number(m[1]));
    assert.deepEqual(poradi, nejnovejsi);

    const shopRazeni = await zalozEshop('razeni');
    const [starsi] = await zalozNaklady(shopRazeni.id, 1, '2026-01-01');
    const [novejsi] = await zalozNaklady(shopRazeni.id, 1, '2026-03-01');
    const obe = await nacti(req, `/marketing/naklady?eshop=${shopRazeni.slug}`);
    assert.ok(obe.indexOf(tokenNakladu(novejsi)) < obe.indexOf(tokenNakladu(starsi)));
  });

  test('ruční náklady: e-shop v odkazech je ten, na kterém seznam je, ne hodnota z adresy', async () => {
    for (const adresa of [`/marketing/naklady?eshop=${shop.slug.toUpperCase()}`, `/marketing/naklady?eshop=${shop.slug}&eshop=toneracek`]) {
      const html = await nacti(req, adresa);
      assert.equal(odkazStrany(html, 'next'), `/marketing/naklady?eshop=${shop.slug}&page=2`, adresa);
    }
  });

  test('ruční náklady: založení vrací na první stránku a podtitulek má správný tvar', async () => {
    const res = await req.post('/marketing/naklady/vytvorit', { eshop: shopPrazdny.slug, platform: 'meta', date_from: '2026-01-01', date_to: '2026-01-31', amount: '10' });
    assert.equal(res.headers.get('location'), `/marketing/naklady?eshop=${shopPrazdny.slug}&saved=1`);
    assert.ok((await nacti(req, res.headers.get('location'))).includes('· 1 náklad bez DPH'));
    await sql`DELETE FROM marketing_manual_costs WHERE shop_id = ${shopPrazdny.id}`;
    assert.ok((await nacti(req, `/marketing/naklady?eshop=${shop.slug}`)).includes(`· ${POCET_NAKLADU} nákladů bez DPH`));
  });

  test('smazání v řádku vrací na tutéž stránku, hláška se v odkazech nedrží', async () => {
    const adresa = `/marketing/naklady?eshop=${shopMazani.slug}&page=2`;
    const html = await nacti(req, adresa);
    assert.equal(dekoduj(/name="redirect_to" value="([^"]+)"/.exec(html)[1]), adresa);

    const id = Number(/\/marketing\/naklady\/(\d+)\/smazat/.exec(html)[1]);
    const res = await req.post(tokenNakladu(id), { eshop: shopMazani.slug, redirect_to: adresa });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${adresa}&smazano=1`);
    assert.equal((await sql`SELECT 1 FROM marketing_manual_costs WHERE id = ${id}`).length, 0, 'řádek je pryč');

    // Byl to jediný řádek druhé stránky: ta zanikla a server ukáže poslední platnou.
    const po = await nacti(req, res.headers.get('location'));
    assert.ok(po.includes('Náklad smazán'));
    assert.ok(po.includes('<strong>1–25</strong> z <strong>25</strong>'), 'poslední platná stránka, ne prázdná tabulka');
    assert.ok(!po.includes('Zatím žádný ruční náklad'));
    assert.ok(po.includes(`data-seznam="/marketing/naklady?eshop=${shopMazani.slug}"`), 'jednorázová hláška se do adresy seznamu nedostane');
    assert.equal(dekoduj(/name="redirect_to" value="([^"]+)"/.exec(po)[1]), `/marketing/naklady?eshop=${shopMazani.slug}`);
    idsMazani = idsMazani.filter(x => x !== id);
  });

  test('smazání bez návratové adresy a s cizí adresou vrací na seznam e-shopu', async () => {
    const vychozi = `/marketing/naklady?eshop=${shopMazani.slug}&smazano=1`;
    for (const cil of [undefined, 'https://evil.example/x', '//evil.example/x', '/\\evil.example']) {
      const id = idsMazani.pop();
      const res = await req.post(tokenNakladu(id), { eshop: shopMazani.slug, ...(cil ? { redirect_to: cil } : {}) });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), vychozi, String(cil));
    }
  });

  test('smazání z adresy bez dotazu dostane hlášku správným oddělovačem', async () => {
    const res = await req.post(tokenNakladu(idsMazani.pop()), { eshop: shopMazani.slug, redirect_to: '/marketing/naklady' });
    assert.equal(res.headers.get('location'), '/marketing/naklady?smazano=1');
  });

  test('co se nesmazalo, to se jako smazané nehlásí, a id mimo rozsah nespadne', async () => {
    const adresa = `/marketing/naklady?eshop=${shopMazani.slug}`;
    const cizi = idsNakladu[0];
    let res = await req.post(tokenNakladu(cizi), { eshop: shopMazani.slug, redirect_to: adresa });
    assert.equal(res.headers.get('location'), adresa, 'náklad jiného e-shopu');
    assert.equal((await sql`SELECT 1 FROM marketing_manual_costs WHERE id = ${cizi}`).length, 1, 'cizí e-shop nesmaže');
    for (const id of ['99999999999', '2147483648', 'abc', '-1', '0', '1e5']) {
      res = await req.post(`/marketing/naklady/${id}/smazat`, { eshop: shopMazani.slug, redirect_to: adresa });
      assert.equal(res.status, 302, id);
      assert.equal(res.headers.get('location'), adresa, id);
    }
  });

  // ── Běhy synchronizace ─────────────────────────────────────

  test('běhy: shodný started_at, 50 na stránku, každý řádek právě jednou, nad dřívějším limitem', () => overSeznam({
    req, adresa: `/marketing/sync?eshop=${shop.slug}`, tokeny: behy.map(b => b.error), naStranku: 50, filtr: { eshop: shop.slug },
  }));

  test('běhy: shodný čas řadí id sestupně, tabulka platforem je nad nimi na každé stránce', async () => {
    const html = await nacti(req, `/marketing/sync?eshop=${shop.slug}`);
    const poradi = behy.map(b => [html.indexOf(b.error), b.id]).filter(([i]) => i >= 0).sort((a, b) => a[0] - b[0]).map(([, id]) => id);
    assert.deepEqual(poradi, behy.map(b => b.id).sort((a, b) => b - a).slice(0, 50));

    for (const adresa of [`/marketing/sync?eshop=${shop.slug}`, `/marketing/sync?eshop=${shop.slug}&page=3`]) {
      const stranka = await nacti(req, adresa);
      assert.ok(stranka.includes('Napojené platformy'), adresa);
      assert.ok(stranka.indexOf('Napojené platformy') < stranka.indexOf('Poslední běhy'), adresa);
      assert.ok(stranka.includes('Google Analytics 4'), 'pevných osm řádků platforem se nestránkuje');
    }
  });

  test('běhy: novější started_at je první', async () => {
    const shopRazeni = await zalozEshop('behy');
    const [zdroj] = await sql`INSERT INTO marketing_sources (shop_id, platform, active, external_id) VALUES (${shopRazeni.id}, 'ga4', FALSE, 'test') RETURNING id`;
    const zaznam = (popis, cas) => ({ source_id: zdroj.id, shop_id: shopRazeni.id, platform: 'ga4', kind: 'rucni', run_date: '2026-01-15', status: 'hotovo', error: `${popis}-${r}`, started_at: new Date(cas) });
    await sql`INSERT INTO marketing_sync_runs ${sql([zaznam('novejsi', '2026-03-01T10:00:00Z'), zaznam('starsi', '2026-01-01T10:00:00Z')])}`;
    const html = await nacti(req, `/marketing/sync?eshop=${shopRazeni.slug}`);
    assert.ok(html.indexOf(`novejsi-${r}`) < html.indexOf(`starsi-${r}`));
  });

  test('běhy: velikost 25 odkazy drží, výchozí 50 se do adresy nepíše', async () => {
    const html = await nacti(req, `/marketing/sync?eshop=${shop.slug}&velikost=25`);
    assert.equal(behy.filter(b => html.includes(b.error)).length, 25);
    assert.equal(odkazStrany(html, 'next'), `/marketing/sync?eshop=${shop.slug}&velikost=25&page=2`);
    const vychozi = await nacti(req, `/marketing/sync?eshop=${shop.slug}`);
    assert.equal(odkazStrany(vychozi, 'next'), `/marketing/sync?eshop=${shop.slug}&page=2`);
  });

  test('hláška po Spustit teď se v odkazech stran nepřenáší', async () => {
    const html = await nacti(req, `/marketing/sync?eshop=${shop.slug}&saved=1&behu=2&chyb=1&error=sync-bezi&page=2`);
    assert.ok(html.includes('nepovedlo'), 'hláška je vidět');
    assert.ok(html.includes('právě probíhá'), 'hláška je vidět');
    const blok = paticka(html);
    assert.ok(blok, 'patička je na stránce');
    const adresy = [...hrefy(blok), dekoduj(/data-seznam="([^"]*)"/.exec(blok)[1])];
    assert.ok(adresy.length >= 3);
    for (const adresa of adresy) {
      const p = parametry(adresa);
      for (const k of ['saved', 'behu', 'chyb', 'error']) assert.ok(!p.has(k), `${adresa} nese ${k}`);
      assert.equal(p.get('eshop'), shop.slug);
    }
  });

  test('Spustit bez aktivní platformy řekne, že se nic nestáhlo', async () => {
    const res = await req.post('/marketing/sync/spustit', { eshop: shopPrazdny.slug, platform: 'vse' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/marketing/sync?eshop=${shopPrazdny.slug}&saved=1&behu=0`);
    const html = await nacti(req, res.headers.get('location'));
    assert.ok(html.includes('Nic se nestáhlo'));
    assert.ok(!html.includes('Stažení proběhlo'));
  });

  test('běh bez chyby hlásí úspěch, běh s chybou ne', async () => {
    const ok = await nacti(req, `/marketing/sync?eshop=${shop.slug}&saved=1&behu=1`);
    assert.ok(ok.includes('Stažení proběhlo'));
    const chyba = await nacti(req, `/marketing/sync?eshop=${shop.slug}&saved=1&behu=2&chyb=1`);
    assert.ok(chyba.includes('nepovedlo'));
    assert.ok(!chyba.includes('Stažení proběhlo'));
  });

  test('detail e-shopu dál ukazuje jen posledních 5 běhů a odkaz na všechny', async () => {
    const html = await nacti(req, `/nastaveni/eshopy/${shop.id}?tab=marketing`);
    const pet = behy.map(b => b.id).sort((a, b) => b - a).slice(0, 5);
    assert.deepEqual(behy.filter(b => html.includes(b.error)).map(b => b.id).sort((a, b) => b - a), pet);
    assert.ok(html.includes('Všechny běhy'));
  });

  test('prázdný e-shop: prázdné stavy bez patičky', async () => {
    const naklady = await nacti(req, `/marketing/naklady?eshop=${shopPrazdny.slug}&page=3`);
    assert.ok(naklady.includes('Zatím žádný ruční náklad'));
    assert.ok(!naklady.includes('class="strankovani"'));
    const sync = await nacti(req, `/marketing/sync?eshop=${shopPrazdny.slug}&page=3`);
    assert.ok(sync.includes('Zatím žádný běh'));
    assert.ok(!sync.includes('class="strankovani"'));
  });

  // ── Záložky přehledu ───────────────────────────────────────

  const SEKCE = {
    prehled: ['class="kpi-card"', 'Tržby a náklady po dnech', 'Náklady po platformách'],
    kanaly: ['zdroj objednávky zná', 'Cesta zákazníka (GA4)', 'Kanály podle GA4'],
    vyhledavani: ['Organické vyhledávání (Search Console)', 'Merchant Center', 'Z e-shopu'],
  };

  for (const [tab, popisek] of ZALOZKY) {
    test(`záložka ${popisek}: jen její sekce, období a varování zůstávají nad pruhem`, async () => {
      const html = await nacti(req, prehled(tab === 'prehled' ? '' : `&tab=${tab}`));
      assert.equal(aktivniZalozka(html), popisek);
      assert.equal(pruhZalozek(html).match(/aria-current="page"/g).length, 1);
      for (const [klic, sekce] of Object.entries(SEKCE)) {
        for (const text of sekce) assert.equal(html.includes(text), klic === tab, `${text} na záložce ${tab}`);
      }
      const pruh = html.indexOf('class="tabs"');
      assert.ok(html.indexOf('name="obdobi"') < pruh, 'období je nad pruhem');
      assert.ok(html.indexOf('Žádná platforma není napojená') < pruh, 'varování je nad pruhem');
      assert.ok(html.indexOf('Žádná platforma není napojená') >= 0);
      assert.ok(prepinacEshopu(html) && html.indexOf('aria-label="E-shop"') < html.indexOf('name="obdobi"'), 'přepínač e-shopů je nad obdobím');
      assert.ok(pruh < html.indexOf(SEKCE[tab][0]), 'obsah záložky je pod pruhem');
    });
  }

  test('neznámý klíč záložky ukáže první záložku, ne prázdnou stránku', async () => {
    for (const tab of ['tab=xyz', 'tab=', 'tab=__proto__', 'tab=constructor', 'tab=kanaly&tab=vyhledavani', 'tab=KANALY']) {
      const html = await nacti(req, prehled(`&${tab}`));
      assert.equal(aktivniZalozka(html), 'Přehled', tab);
      assert.ok(html.includes('class="kpi-card"'), tab);
      assert.ok(!html.includes('name="tab"'), `${tab}: výchozí záložka se do formuláře nepíše`);
      for (const a of hrefy(prepinacEshopu(html))) assert.ok(!parametry(a).has('tab'), `${tab}: ${a}`);
    }
  });

  test('záložka přežije přepnutí e-shopu: drží i období', async () => {
    const html = await nacti(req, `/marketing?eshop=${shop.slug}&obdobi=30-dni&tab=kanaly`);
    const odkazy = hrefy(prepinacEshopu(html));
    assert.ok(odkazy.length >= 2, 'test potřebuje aspoň dva aktivní e-shopy');
    for (const a of odkazy) {
      assert.equal(parametry(a).get('tab'), 'kanaly', a);
      assert.equal(parametry(a).get('obdobi'), '30-dni', a);
      assert.ok(a.startsWith('/marketing?'), a);
    }
    assert.ok(odkazy.some(a => parametry(a).get('eshop') === shop.slug), 'odkaz na tento e-shop');
    assert.ok(odkazy.some(a => !parametry(a).has('eshop')), 'výchozí e-shop bez parametru');

    const jiny = odkazy.find(a => parametry(a).get('eshop') === shopPrazdny.slug);
    assert.ok(jiny, 'odkaz na druhý e-shop');
    const poPrepnuti = await nacti(req, jiny);
    assert.equal(aktivniZalozka(poPrepnuti), 'Kanály', 'po kliknutí je otevřená tatáž záložka');
    assert.ok(poPrepnuti.includes(shopPrazdny.name));
  });

  test('záložka přežije změnu období: skrytá pole formuláře', async () => {
    const html = await nacti(req, `/marketing?eshop=${shop.slug}&obdobi=30-dni&tab=vyhledavani`);
    const formular = /<form method="get" action="\/marketing"[^]*?<\/form>/.exec(html)[0];
    assert.ok(formular.includes('<input type="hidden" name="tab" value="vyhledavani">'));
    assert.ok(formular.includes(`<input type="hidden" name="eshop" value="${shop.slug}">`));

    // Co formulář odešle: skrytá pole a zvolené období.
    const poZmene = await nacti(req, `/marketing?eshop=${shop.slug}&tab=vyhledavani&obdobi=minuly-mesic`);
    assert.equal(aktivniZalozka(poZmene), 'Vyhledávání a e-shop');
    assert.match(poZmene, /<option value="minuly-mesic" selected>/);
  });

  test('přepnutí záložky drží e-shop i období, vlastní rozsah včetně mezí', async () => {
    const html = await nacti(req, `/marketing?eshop=${shop.slug}&${OBDOBI}&tab=kanaly`);
    const odkazy = hrefy(pruhZalozek(html));
    assert.equal(odkazy.length, 3);
    for (const a of odkazy) {
      const p = parametry(a);
      assert.equal(p.get('eshop'), shop.slug, a);
      assert.equal(p.get('obdobi'), 'vlastni', a);
      assert.equal(p.get('od'), '2026-01-01', a);
      assert.equal(p.get('do'), '2026-01-31', a);
    }
    assert.deepEqual(odkazy.map(a => parametry(a).get('tab')), [null, 'kanaly', 'vyhledavani'], 'výchozí záložka se do adresy nepíše');
    for (const a of hrefy(prepinacEshopu(html))) {
      const p = parametry(a);
      assert.deepEqual([p.get('obdobi'), p.get('od'), p.get('do'), p.get('tab')], ['vlastni', '2026-01-01', '2026-01-31', 'kanaly'], a);
    }
  });

  test('výchozí záložka se nikam nepřipisuje', async () => {
    const html = await nacti(req, `/marketing?eshop=${shop.slug}&obdobi=30-dni`);
    assert.ok(!html.includes('name="tab"'));
    for (const a of hrefy(prepinacEshopu(html))) assert.ok(!parametry(a).has('tab'), a);
    assert.ok(!parametry(hrefy(pruhZalozek(html))[0]).has('tab'));
  });

  test('odkazy na ruční náklady a synchronizaci záložku ani období nenesou', async () => {
    const html = await nacti(req, prehled('&tab=kanaly'));
    assert.ok(html.includes(`href="/marketing/naklady?eshop=${shop.slug}"`));
    assert.ok(html.includes(`href="/marketing/sync?eshop=${shop.slug}"`));
  });

  test('graf a jeho skript jen na záložce s grafem', async () => {
    const html = await nacti(req, prehled());
    for (const text of ['id="marketing-graf"', 'id="marketing-data"', '/static/js/marketing.js']) assert.ok(html.includes(text), text);
    for (const tab of ['kanaly', 'vyhledavani']) {
      const jina = await nacti(req, prehled(`&tab=${tab}`));
      for (const text of ['id="marketing-graf"', 'id="marketing-data"', '/static/js/marketing.js', 'chart.umd.min.js']) assert.ok(!jina.includes(text), `${tab}: ${text}`);
    }
  });

  test('tabulka dotazů má popisek Top 10 a ukazuje deset nejsilnějších', async () => {
    const html = await nacti(req, prehled('&tab=vyhledavani'));
    assert.ok(html.includes('Top 10'));
    const dotazy = Array.from({ length: 12 }, (_, i) => `dotaz-${r}-${String(i).padStart(2, '0')}`);
    assert.deepEqual(dotazy.filter(d => html.includes(d)), dotazy.slice(0, 10));
  });

  // ── Odkazy v hlavičce podle práv ───────────────────────────

  const odkazNaklady = () => `href="/marketing/naklady?eshop=${shop.slug}"`;
  const odkazSync = () => `href="/marketing/sync?eshop=${shop.slug}"`;
  const odkazNastaveni = () => `href="/nastaveni/eshopy/${shop.id}?tab=marketing"`;

  test('správce vidí v hlavičce všechny tři odkazy', async () => {
    const html = await nacti(req, prehled());
    for (const o of [odkazNaklady(), odkazSync(), odkazNastaveni()]) assert.ok(html.includes(o), o);
  });

  test('nesprávce bez nastavení: nastavení nevidí ani v hlavičce, ani ve varování', async () => {
    const html = await nacti(bezny, prehled());
    assert.ok(html.includes(odkazNaklady()));
    assert.ok(html.includes(odkazSync()));
    assert.ok(!html.includes(odkazNastaveni()));
    assert.ok(!html.includes('Nastavení napojení'));
    assert.ok(html.includes('Žádná platforma není napojená'), 'varování zůstává, jen bez odkazu');
  });

  test('odebrané právo schová odkaz, který by skončil na 403', async () => {
    try {
      await odeberPrava(beznyId, ['marketing.naklady']);
      let html = await nacti(bezny, prehled());
      assert.ok(!html.includes(odkazNaklady()));
      assert.ok(html.includes(odkazSync()));
      assert.equal((await bezny.get(`/marketing/naklady?eshop=${shop.slug}`)).status, 403, 'strážce platí dál');

      const prazdny = await nacti(bezny, `/marketing?eshop=${shopPrazdny.slug}`);
      assert.ok(prazdny.includes('Žádné náklady'));
      assert.ok(!prazdny.includes('zadat ručně'), 'ani odkaz v prázdném stavu');

      await odeberPrava(beznyId, ['marketing.sync']);
      html = await nacti(bezny, prehled());
      assert.ok(!html.includes(odkazSync()));
      assert.ok(!html.includes('page-header-akce'), 'prázdný blok akcí se nevykreslí');
    } finally {
      await vratPrava(beznyId);
    }
    const prazdny = await nacti(bezny, `/marketing?eshop=${shopPrazdny.slug}`);
    assert.ok(prazdny.includes('zadat ručně'));
  });

  test('správce s odebraným nastavením e-shopů odkaz nevidí', async () => {
    try {
      await odeberPrava(spravce.id, ['nastaveni.eshopy']);
      const html = await nacti(req, prehled());
      assert.ok(!html.includes(odkazNastaveni()));
      const sync = await nacti(req, `/marketing/sync?eshop=${shop.slug}`);
      assert.ok(!sync.includes(odkazNastaveni()));
      assert.ok(sync.includes('Nastavení → Eshopy (správce)'));
    } finally {
      await vratPrava(spravce.id);
    }
  });

  test('bez práva na přehled vede drobečková navigace jen textem', async () => {
    assert.match(await nacti(bezny, `/marketing/naklady?eshop=${shop.slug}`), /<h1><a href="\/marketing\?eshop=/);
    try {
      await odeberPrava(beznyId, ['marketing.prehled']);
      for (const [adresa, nadpis] of [[`/marketing/naklady?eshop=${shop.slug}`, 'Ruční náklady'], [`/marketing/sync?eshop=${shop.slug}`, 'Synchronizace']]) {
        const html = await nacti(bezny, adresa);
        assert.ok(!/<h1><a /.test(html), adresa);
        assert.match(html, new RegExp(`<h1><span[^>]*>Marketing</span> / ${nadpis}</h1>`), adresa);
      }
    } finally {
      await vratPrava(beznyId);
    }
  });
});
