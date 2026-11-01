// CRM proti běžícímu serveru a lokální databázi: seznamy firem a kontaktů se
// stránkováním a filtry, záložky detailů se stránkováním, čísla z SQL.
//
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/seznam-crm.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';
import { overSeznam, projdiStranky } from './pomocnici/seznamy.js';

const pad = (i) => String(i).padStart(3, '0');
const cs = (n, volby) => Number(n).toLocaleString('cs-CZ', volby);
const castka = (n) => cs(n, { minimumFractionDigits: 2 });

describe('CRM: seznamy a záložky', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  const POCET = 61;
  const SHODA = `Shoda${r}`; // dotaz, který najde jen řádky seznamu, ne ostatní fixtury
  // Znaky, které ruční skládání odkazu a neescapované ILIKE rozbíjí.
  const ZVLASTNI = `H&M+100%"č ${SHODA}`;
  const NAVNADA = `H&M+100X"č ${SHODA}`; // % v dotazu ji nesmí najít jako zástupný znak
  const ZDROJ = `zdroj-${r}`;

  let sql; let sid; let req; let uzivatel; let obchod;
  const firmy = []; const kontakty = [];
  const firma = `cf-${r}-detail`; const firmaPrazdna = `cf-${r}-prazdna`;
  const kontakt = `ck-${r}-detail`; const kontaktCizi = `ck-${r}-cizi`;
  const obFirmy = []; const fakFirmy = []; const obKontaktu = []; const fakKontaktu = []; const fakCizi = [];
  const KONTAKTY_FIRMY = [`ck-${r}-kf1`, `ck-${r}-kf2`, `ck-${r}-kf3`];
  const cas = new Date('2026-01-15T10:00:00Z');
  const novejsi = new Date('2026-02-20T10:00:00Z');

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`crm-${r}@example.invalid`}, 'x', TRUE, TRUE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    req = pozadavky(prihlaseni.cookie);
    [obchod] = await sql`
      INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address)
      VALUES (${`test-crm-${r}`}, ${`CRM e-shop ${r}`}, 'https://example.invalid', TRUE, 'Test', 'noreply@example.invalid')
      RETURNING id`;

    // Firmy: shodný název i čas založení, pořadí mezi stranami drží jen id.
    const radkyFirem = Array.from({ length: POCET }, (_, i) => ({
      id: `cf-${r}-${pad(i)}`, name: ZVLASTNI, company_type: i % 4 < 2 ? 'Dodavatel' : 'Zákazník',
      source: i % 2 ? ZDROJ : null, created_at: cas, modified_at: cas,
    }));
    firmy.push(...radkyFirem.map(x => x.id));
    await sql`INSERT INTO crm_companies ${sql(radkyFirem)}`;
    await sql`INSERT INTO crm_companies (id, name, company_type, source) VALUES (${`cf-${r}-navnada`}, ${NAVNADA}, 'Oboje', ${`navnada-${r}`})`;
    await sql`INSERT INTO crm_companies (id, name, company_type) VALUES (${firma}, ${`Detailní firma ${r}`}, 'Zákazník'), (${firmaPrazdna}, ${`Prázdná firma ${r}`}, 'Partner')`;

    // Kontakty: shodné jméno, liší se jen id a e-mail (UNIQUE).
    const radkyKontaktu = Array.from({ length: POCET }, (_, i) => ({
      id: `ck-${r}-${pad(i)}`, first_name: 'Jan', last_name: `Nová&+%"č ${SHODA}`, email: `k-${r}-${i}@example.invalid`,
      company_id: i % 2 ? firmy[0] : null, company_name: i % 4 === 0 ? `Text z účtu ${r}` : '',
      source: i % 2 ? ZDROJ : null, created_at: cas, modified_at: cas,
    }));
    kontakty.push(...radkyKontaktu.map(x => x.id));
    await sql`INSERT INTO crm_contacts ${sql(radkyKontaktu)}`;
    await sql`INSERT INTO crm_contacts (id, first_name, last_name, email) VALUES
      (${`ck-${r}-navnada`}, 'Jan', ${`Nová&+X"č ${SHODA}`}, ${`navnada-${r}@example.invalid`}),
      (${`ck-${r}-beze-jmena`}, '', '', ${`beze-jmena-${r}@example.invalid`})`;

    // Detail firmy: objednávky i faktury se shodným datem, všechny typy dokladů a dvě měny.
    await sql`INSERT INTO crm_contacts ${sql(KONTAKTY_FIRMY.map((id, i) => ({ id, first_name: 'Člen', last_name: `Firmy ${i}`, company_id: firma, email: `${id}@example.invalid` })))}`;
    await sql`INSERT INTO crm_contracts (id, company_id, title) VALUES (${`cs-${r}-1`}, ${firma}, 'První'), (${`cs-${r}-2`}, ${firma}, 'Druhá')`;
    const STAVY_OBJ = ['Přijata', 'Vyřízena', 'Stornována', 'Nová'];
    const objednavkyFirmy = Array.from({ length: POCET }, (_, i) => ({
      id: `of-${r}-${pad(i)}`, shop_id: obchod.id, order_number: `F${r}${i}`, status: STAVY_OBJ[i % 4],
      email: 'o@example.invalid', first_name: 'Oto', last_name: 'Kupec', total_price: 100 + i, crm_company_id: firma, created_at: cas, modified_at: cas,
    }));
    obFirmy.push(...objednavkyFirmy);
    await sql`INSERT INTO shop_orders ${sql(objednavkyFirmy)}`;
    const TYPY = ['issued', 'proforma', 'received'];
    const STAVY_FAK = ['Zaplacena', 'Nezaplacena', 'Storno'];
    const dokladyFirmy = Array.from({ length: POCET }, (_, i) => ({
      id: `df-${r}-${pad(i)}`, type: TYPY[i % 3], number: `DF${r}${i}`, status: STAVY_FAK[i % 3 === 0 ? 0 : i % 2 + 1],
      issue_date: '2026-01-15', total_amount: (100033 + i * 7) / 100, currency: i % 5 === 0 ? 'EUR' : 'CZK', crm_company_id: firma,
    }));
    fakFirmy.push(...dokladyFirmy);
    await sql`INSERT INTO accounting_invoices ${sql(dokladyFirmy)}`;

    // Detail kontaktu: část dokladů visí jen na objednávce (crm_contact_id prázdné), jeden na obojím.
    await sql`INSERT INTO crm_contacts (id, first_name, last_name, email, company_name) VALUES
      (${kontakt}, 'Klára', ${`Kupující ${r}`}, ${`detail-${r}@example.invalid`}, ${`Text z účtu ${r}`}),
      (${kontaktCizi}, 'Cizí', ${`Kontakt ${r}`}, ${`cizi-${r}@example.invalid`}, '')`;
    const objednavkyKontaktu = Array.from({ length: POCET }, (_, i) => ({
      id: `ok-${r}-${pad(i)}`, shop_id: obchod.id, order_number: `K${r}${i}`, status: STAVY_OBJ[i % 4],
      email: 'o@example.invalid', total_price: (20050 + i * 3) / 100, crm_contact_id: kontakt, created_at: i === 7 ? novejsi : cas, modified_at: cas,
    }));
    obKontaktu.push(...objednavkyKontaktu);
    await sql`INSERT INTO shop_orders ${sql(objednavkyKontaktu)}`;
    const dokladyKontaktu = Array.from({ length: POCET }, (_, i) => ({
      id: `dk-${r}-${pad(i)}`, type: TYPY[i % 3], number: `DK${r}${i}`, status: STAVY_FAK[i % 2],
      issue_date: '2026-03-10', total_amount: (50011 + i * 11) / 100, currency: 'CZK',
      crm_contact_id: i % 3 === 0 ? null : kontakt, order_id: i % 3 === 1 ? null : objednavkyKontaktu[i].id,
    }));
    fakKontaktu.push(...dokladyKontaktu);
    await sql`INSERT INTO accounting_invoices ${sql(dokladyKontaktu)}`;
    fakCizi.push(`dx-${r}-1`);
    await sql`INSERT INTO accounting_invoices (id, type, number, status, total_amount, crm_contact_id)
              VALUES (${fakCizi[0]}, 'issued', ${`DX${r}`}, 'Zaplacena', 777.77, ${kontaktCizi})`;
  });

  after(async () => {
    await sql`DELETE FROM accounting_invoices WHERE id = ANY(${[...fakFirmy, ...fakKontaktu].map(x => x.id).concat(fakCizi)})`;
    await sql`DELETE FROM shop_orders WHERE shop_id = ${obchod.id}`;
    await sql`DELETE FROM shops WHERE id = ${obchod.id}`;
    await sql`DELETE FROM crm_contracts WHERE company_id = ${firma}`;
    await sql`DELETE FROM crm_contacts WHERE id = ANY(${[...kontakty, ...KONTAKTY_FIRMY, kontakt, kontaktCizi, `ck-${r}-navnada`, `ck-${r}-beze-jmena`]})`;
    await sql`DELETE FROM crm_companies WHERE id = ANY(${[...firmy, firma, firmaPrazdna, `cf-${r}-navnada`]})`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  const nacti = async (adresa) => {
    const res = await req.get(adresa);
    assert.equal(res.status, 200, `${adresa} vrací ${res.status}`);
    return res.text();
  };
  const tokenFirmy = (id) => `/crm/firmy/${id}"`;
  const tokenKontaktu = (id) => `/crm/kontakty/${id}"`;
  const tokenObjednavky = (o) => `/ucetnictvi/objednavky/${o.id}"`;
  const tokenDokladu = (d) => `/ucetnictvi/${d.type === 'received' ? 'prijate' : 'vydane'}-faktury/${d.id}"`;
  const pocet = (html, popisek) => Number(new RegExp(`>${popisek} <span class="tab-pocet">(\\d+)</span>`).exec(html)?.[1]);

  /** Filtr prochází přes odkazy Další: najde přesně očekávané řádky a má víc stran. */
  async function overFiltr(adresa, ocekavane, vsechny) {
    const stranky = await projdiStranky(req, adresa);
    assert.ok(stranky.length > 1, `${adresa}: fixtura má mít víc stran`);
    assert.deepEqual(vsechny.filter(t => stranky.some(h => h.includes(t))).sort(), [...ocekavane].sort(), adresa);
  }

  // ── Seznam firem ──────────────────────────────────────────

  describe('seznam firem', () => {
    const tokeny = () => firmy.map(tokenFirmy);

    test('shodný název: každý řádek právě jednou, neplatné page nespadne', () => overSeznam({
      req, adresa: `/crm/firmy?q=${SHODA}`, tokeny: [...tokeny(), tokenFirmy(`cf-${r}-navnada`)], filtr: { q: SHODA },
    }));

    test('q se znaky &+%"č přežije přechod mezi stranami a % není zástupný znak', async () => {
      await overSeznam({ req, adresa: `/crm/firmy?q=${encodeURIComponent(ZVLASTNI)}`, tokeny: tokeny(), filtr: { q: ZVLASTNI } });
      const html = await nacti(`/crm/firmy?q=${encodeURIComponent(ZVLASTNI)}`);
      assert.ok(html.includes(`value="H&amp;M+100%&#34;č ${SHODA}"`), 'pole hledání drží dotaz escapovaný');
      assert.ok(!html.includes(tokenFirmy(`cf-${r}-navnada`)), 'X se nenajde přes % v dotazu');
      assert.ok(html.includes('61 firem odpovídá filtru'), 'hlavička s filtrem');
    });

    test('filtry type a source včetně (bez zdroje) drží odkazy', async () => {
      await overFiltr(`/crm/firmy?q=${SHODA}&type=Dodavatel`, firmy.filter((_, i) => i % 4 < 2).map(tokenFirmy), tokeny());
      await overFiltr(`/crm/firmy?q=${SHODA}&type=${encodeURIComponent('Zákazník')}`, firmy.filter((_, i) => i % 4 >= 2).map(tokenFirmy), tokeny());
      await overFiltr(`/crm/firmy?q=${SHODA}&source=${ZDROJ}`, firmy.filter((_, i) => i % 2).map(tokenFirmy), tokeny());
      await overFiltr(`/crm/firmy?q=${SHODA}&source=-`, firmy.filter((_, i) => !(i % 2)).map(tokenFirmy), tokeny());
      const html = await nacti(`/crm/firmy?q=${SHODA}&source=-&type=Dodavatel`);
      assert.match(html, /<option value="-" selected>/, 'volba bez zdroje zůstane vybraná');
      assert.match(html, /<option value="Dodavatel" selected>/);
      assert.ok(html.includes('href="/crm/firmy" class="btn btn-ghost">Zrušit filtr'), 'zrušení filtru jen s aktivním filtrem');
      assert.ok(!/name="page"/.test(html), 'formulář filtru stránku nenese');
    });

    test('prázdný výsledek filtru: colspan přes všechny sloupce, zrušení filtru, bez patičky', async () => {
      const html = await nacti(`/crm/firmy?q=${SHODA}-nic&page=3`);
      const sloupcu = html.match(/<th\b/g).length;
      assert.equal(sloupcu, 8);
      assert.ok(html.includes(`<td colspan="${sloupcu}">`));
      assert.ok(html.includes('Filtru neodpovídá žádná firma'));
      assert.ok(html.includes('0 firem odpovídá filtru'));
      assert.ok(!html.includes('class="strankovani"'));
    });

    test('filtr jen podle zdroje s nulou řádků je také filtr, hlavička má správný tvar', async () => {
      const prazdny = await nacti(`/crm/firmy?source=neni-${r}`);
      assert.ok(prazdny.includes('Filtru neodpovídá žádná firma'));
      const jeden = await nacti(`/crm/firmy?source=navnada-${r}`);
      assert.ok(jeden.includes('1 firma odpovídá filtru'));
      const bez = await nacti('/crm/firmy');
      assert.match(bez, /\d firem celkem|\d firmy celkem|\d firma celkem/);
    });

    test('řádek je odkaz bez onclick, typ jako odznak a skutečná hodnota typu', async () => {
      const html = await nacti(`/crm/firmy?q=${SHODA}&type=Dodavatel`);
      assert.match(html, /<tr data-href="\/crm\/firmy\/cf-[^"]+">/);
      assert.match(html, /<a href="\/crm\/firmy\/cf-[^"]+" class="radek-odkaz radek-text" title="H&amp;M\+100%&#34;č [^"]+">H&amp;M\+100%&#34;č /, 'název je escapovaný a celý v title');
      assert.ok(html.includes('<span class="badge badge-info">Dodavatel</span>'));
      assert.ok(!html.includes('window.location') && !html.includes('stopPropagation'), 'žádný proklik přes onclick');
      const partner = await nacti(`/crm/firmy?q=${encodeURIComponent(`Prázdná firma ${r}`)}`);
      assert.ok(partner.includes('<span class="badge badge-neutral">Partner</span>'), 'Partner z formuláře detailu se neukáže jako Ostatní');
    });

    test('jednorázové parametry a dvojitý q', async () => {
      const html = await nacti(`/crm/firmy?q=${SHODA}&saved=1&velikost=50`);
      assert.ok(html.includes('velikost=50&amp;page=2'), 'velikost drží odkazy');
      assert.ok(!html.includes('saved=1'), 'hláška se při listování neopakuje');
      assert.equal((await req.get(`/crm/firmy?q=${SHODA}&q=jine&type=a&type=b`)).status, 200);
      assert.equal((await req.get(`/crm/kontakty?q=${SHODA}&q=jine&company=a&company=b&source=a&source=b`)).status, 200);
    });
  });

  // ── Seznam kontaktů ───────────────────────────────────────

  describe('seznam kontaktů', () => {
    const tokeny = () => kontakty.map(tokenKontaktu);
    const NAJDI = (i) => `/crm/kontakty?q=${encodeURIComponent(`k-${r}-${i}@`)}`;

    test('šablona má stránkování: shodné jméno, každý řádek právě jednou', () => overSeznam({
      req, adresa: `/crm/kontakty?q=${SHODA}`, tokeny: [...tokeny(), tokenKontaktu(`ck-${r}-navnada`)], filtr: { q: SHODA },
    }));

    test('q se znaky &+%"č přežije přechod a % není zástupný znak', async () => {
      const q = `Nová&+%"č ${SHODA}`;
      await overSeznam({ req, adresa: `/crm/kontakty?q=${encodeURIComponent(q)}`, tokeny: tokeny(), filtr: { q } });
      const html = await nacti(`/crm/kontakty?q=${encodeURIComponent(q)}`);
      assert.ok(!html.includes(tokenKontaktu(`ck-${r}-navnada`)));
      assert.ok(html.includes(`value="Nová&amp;+%&#34;č ${SHODA}"`));
    });

    test('filtry company a source včetně (bez zdroje) drží odkazy', async () => {
      await overFiltr(`/crm/kontakty?q=${SHODA}&company=${firmy[0]}`, kontakty.filter((_, i) => i % 2).map(tokenKontaktu), tokeny());
      await overFiltr(`/crm/kontakty?q=${SHODA}&source=${ZDROJ}`, kontakty.filter((_, i) => i % 2).map(tokenKontaktu), tokeny());
      await overFiltr(`/crm/kontakty?q=${SHODA}&source=-`, kontakty.filter((_, i) => !(i % 2)).map(tokenKontaktu), tokeny());
      const html = await nacti(`/crm/kontakty?q=${SHODA}&company=${firmy[0]}&source=-`);
      assert.ok(html.includes(`<option value="${firmy[0]}" selected>`), 'firma zůstane vybraná');
      assert.ok(html.includes('Filtru neodpovídá žádný kontakt'), 'žádný kontakt s firmou nemá prázdný zdroj');
    });

    test('prázdný stav pozná i filtr jen podle zdroje, colspan přes všechny sloupce', async () => {
      const html = await nacti(`/crm/kontakty?source=neni-${r}`);
      const sloupcu = html.match(/<th\b/g).length;
      assert.equal(sloupcu, 7);
      assert.ok(html.includes(`<td colspan="${sloupcu}">`));
      assert.ok(html.includes('Filtru neodpovídá žádný kontakt') && html.includes('Zrušit filtr'));
      assert.ok(!html.includes('Zatím žádné kontakty'));
      assert.ok(!html.includes('class="strankovani"'));
    });

    test('sloupec Firma: připojená firma odkazem, text z účtu bez odkazu, jinak pomlčka', async () => {
      // i=1 má company_id, i=4 jen company_name, i=2 nic
      let html = await nacti(NAJDI(1));
      assert.match(html, new RegExp(`<a href="/crm/firmy/${firmy[0]}" class="radek-text"[^>]*>H&amp;M\\+100%&#34;č ${SHODA}</a>`), 'kontakt založený v aplikaci ukazuje firmu');
      html = await nacti(NAJDI(4));
      assert.match(html, new RegExp(`<span class="radek-text" title="Text z účtu ${r}">Text z účtu ${r}</span>`));
      assert.ok(!/href="\/crm\/firmy\/"/.test(html), 'bez company_id žádný odkaz na prázdnou firmu');
      html = await nacti(NAJDI(2));
      assert.match(html, /<td>\s*–\s*<\/td>/, 'bez firmy pomlčka');
    });

    test('detail ukazuje firmu stejně jako seznam', async () => {
      let html = await nacti(`/crm/kontakty/${kontakty[1]}`);
      assert.match(html, new RegExp(`<a href="/crm/firmy/${firmy[0]}"[^>]*>H&amp;M\\+100%&#34;č ${SHODA}</a>`));
      html = await nacti(`/crm/kontakty/${kontakt}`);
      assert.ok(html.includes(`Text z účtu ${r}`), 'text z účtu');
      assert.ok(!/href="\/crm\/firmy\/"/.test(html));
    });

    test('řádek je odkaz bez onclick, odkaz firmy a e-mailu zůstává samostatný', async () => {
      const html = await nacti(NAJDI(1));
      assert.ok(html.includes(`<tr data-href="/crm/kontakty/${kontakty[1]}">`));
      assert.ok(html.includes(`<a href="/crm/kontakty/${kontakty[1]}" class="radek-odkaz">Jan Nová&amp;+%&#34;č ${SHODA}</a>`));
      assert.ok(html.includes(`href="mailto:k-${r}-1@example.invalid"`));
      assert.ok(!html.includes('window.location') && !html.includes('stopPropagation'));
    });

    test('kontakt bez jména má v řádku odkaz s e-mailem, ne prázdný', async () => {
      const html = await nacti(`/crm/kontakty?q=${encodeURIComponent(`beze-jmena-${r}@`)}`);
      assert.ok(html.includes(`class="radek-odkaz">beze-jmena-${r}@example.invalid</a>`));
    });
  });

  // ── Detail firmy ──────────────────────────────────────────

  describe('detail firmy', () => {
    const adresa = () => `/crm/firmy/${firma}`;

    test('záložka Objednávky: shodné datum, každý řádek právě jednou, odkazy drží záložku', () => overSeznam({
      req, adresa: `${adresa()}?tab=objednavky`, tokeny: obFirmy.map(tokenObjednavky), filtr: { tab: 'objednavky' },
    }));

    test('záložka Faktury: shodné datum, každý řádek právě jednou, odkazy drží záložku', () => overSeznam({
      req, adresa: `${adresa()}?tab=faktury`, tokeny: fakFirmy.map(tokenDokladu), filtr: { tab: 'faktury' },
    }));

    test('velikost stránky na záložce drží záložku i odkazy', async () => {
      const html = await nacti(`${adresa()}?tab=faktury&velikost=50`);
      assert.equal(fakFirmy.map(tokenDokladu).filter(t => html.includes(t)).length, 50);
      assert.ok(html.includes('tab=faktury&amp;velikost=50&amp;page=2'));
    });

    test('záloha vede na vydané a existuje, přijatá na přijaté, popisek sedí', async () => {
      const html = await nacti(`${adresa()}?tab=faktury&velikost=100`);
      const zaloha = fakFirmy.find(d => d.type === 'proforma');
      const prijata = fakFirmy.find(d => d.type === 'received');
      const vydana = fakFirmy.find(d => d.type === 'issued');
      assert.ok(!html.includes(`/ucetnictvi/prijate-faktury/${zaloha.id}`), 'záloha nesmí vést na přijaté');
      for (const [d, cesta, popisek] of [[zaloha, 'vydane', 'Zálohová faktura'], [vydana, 'vydane', 'Faktura'], [prijata, 'prijate', 'Přijatá faktura']]) {
        const odkaz = `/ucetnictvi/${cesta}-faktury/${d.id}`;
        const radek = new RegExp(`<tr data-href="${odkaz}">[\\s\\S]*?</tr>`).exec(html)?.[0];
        assert.ok(radek, `řádek ${d.type}`);
        assert.ok(radek.includes(`>${popisek}</td>`), `${d.type} má popisek ${popisek}`);
        assert.equal((await req.get(odkaz)).status, 200, `detail ${odkaz} existuje`);
      }
      assert.equal((await req.get(`/ucetnictvi/prijate-faktury/${zaloha.id}`)).status, 404, 'stará adresa zálohy opravdu končí 404');
    });

    test('řádky se načítají jen pro otevřenou záložku', async () => {
      const objednavky = obFirmy.map(tokenObjednavky); const faktury = fakFirmy.map(tokenDokladu); const lide = KONTAKTY_FIRMY.map(tokenKontaktu);
      const naStrance = (html, tokeny) => tokeny.filter(t => html.includes(t)).length;
      for (const [tab, ob, fa, ko] of [['zakladni', 0, 0, 0], ['kontakty', 0, 0, 3], ['objednavky', 25, 0, 0], ['faktury', 0, 25, 0], ['smlouvy', 0, 0, 0], ['poznamky', 0, 0, 0]]) {
        const html = await nacti(`${adresa()}?tab=${tab}`);
        assert.deepEqual([naStrance(html, objednavky), naStrance(html, faktury), naStrance(html, lide)], [ob, fa, ko], tab);
      }
    });

    test('KPI a počty z SQL se rovnají součtu z dat i na druhé stránce', async () => {
      // Výpočet, jakým stránka čísla počítala z úplných řádků.
      const doklady = await sql`SELECT total_amount, status FROM accounting_invoices WHERE crm_company_id = ${firma}`;
      const objednavky = await sql`SELECT status FROM shop_orders WHERE crm_company_id = ${firma}`;
      const totalInvoiced = doklady.reduce((s, i) => s + Number(i.total_amount || 0), 0);
      const paidInvoices = doklady.filter(i => i.status === 'Zaplacena').length;
      const openOrders = objednavky.filter(o => !['Vyřízena', 'Stornována'].includes(o.status)).length;
      assert.ok(openOrders > 0 && openOrders < POCET && paidInvoices > 0 && paidInvoices < POCET, 'fixtura má všechny stavy');
      assert.deepEqual([...new Set(fakFirmy.map(d => d.currency))].sort(), ['CZK', 'EUR'], 'součet jde přes měny');

      for (const q of ['', '?tab=zakladni&page=2&velikost=50']) {
        const html = await nacti(`${adresa()}${q}`);
        const kpi = (popisek) => Number(new RegExp(`>(\\d+)</div>\\s*<div[^>]*>${popisek}</div>`).exec(html)?.[1]);
        assert.equal(kpi('Kontaktů'), KONTAKTY_FIRMY.length, q);
        assert.equal(kpi('Objednávek'), POCET, q);
        assert.equal(kpi('Faktur'), POCET, q);
        assert.equal(kpi('Otevřených obj.'), openOrders, q);
        assert.ok(html.includes(`${castka(totalInvoiced)} CZK`), `fakturováno ${castka(totalInvoiced)}`);
        assert.ok(html.includes(`Celkem fakturováno (${paidInvoices} zaplaceno)`), q);
      }

      for (const q of ['?tab=faktury&page=2', '?tab=objednavky&page=3', '?tab=faktury&velikost=100', '?tab=kontakty', '?tab=smlouvy', '?tab=poznamky']) {
        const html = await nacti(`${adresa()}${q}`);
        assert.deepEqual(['Kontakty', 'Objednávky', 'Faktury', 'Smlouvy'].map(p => pocet(html, p)), [KONTAKTY_FIRMY.length, POCET, POCET, 2], q);
      }
    });

    test('firma bez záznamů: nuly, prázdné záložky bez patičky', async () => {
      const zakladni = await nacti(`/crm/firmy/${firmaPrazdna}`);
      assert.deepEqual(['Kontakty', 'Objednávky', 'Faktury', 'Smlouvy'].map(p => pocet(zakladni, p)), [0, 0, 0, 0]);
      assert.ok(zakladni.includes(`${castka(0)} CZK`));
      for (const [tab, text, sloupcu] of [['objednavky', 'Žádné objednávky', 5], ['faktury', 'Žádné faktury', 6]]) {
        const html = await nacti(`/crm/firmy/${firmaPrazdna}?tab=${tab}&page=2`);
        assert.ok(html.includes(`<td colspan="${sloupcu}"><div class="prazdno"><strong>${text}</strong>`), tab);
        assert.equal(html.match(/<th\b/g).length, sloupcu);
        assert.ok(!html.includes('class="strankovani"'), tab);
      }
    });

    test('neznámá záložka spadne na první, ne na prázdnou stránku', async () => {
      for (const q of ['xyz', 'constructor', '__proto__', 'zakladni&tab=faktury', '']) {
        const html = await nacti(`${adresa()}?tab=${q}`);
        assert.match(html, new RegExp(`href="/crm/firmy/${firma}\\?tab=zakladni" class="tab active" aria-current="page"`), `tab=${q}`);
        assert.ok(html.includes('id="formFirma"'), `tab=${q} ukáže formulář první záložky`);
      }
    });

    test('pruh přes společný include, návrat na seznam, tužka jen na záložkách s formulářem', async () => {
      const html = await nacti(`${adresa()}?tab=objednavky`);
      assert.match(html, /<nav class="tabs" aria-label="Sekce firmy">/);
      assert.match(html, /<a href="\/crm\/firmy"[^>]*\bdata-zpet\b/, 'odkaz zpět se přesměruje na poslední stránku seznamu');
      assert.match(html, new RegExp(`href="/crm/firmy/${firma}\\?tab=objednavky" class="tab active" aria-current="page">Objednávky <span class="tab-pocet">${POCET}</span>`));
      assert.ok(!html.includes('upravit-otevrit'));
      assert.ok((await nacti(`${adresa()}?tab=poznamky`)).includes('upravit-otevrit'));
    });

    test('zápis poznámek ani základních údajů se záložkami nezměnil', async () => {
      const res = await req.post(`${adresa()}/poznamky`, { notes: 'jen poznámka' });
      assert.equal(res.headers.get('location'), `${adresa()}?tab=poznamky&saved=1`);
      const [f] = await sql`SELECT notes, name FROM crm_companies WHERE id = ${firma}`;
      assert.deepEqual([f.notes, f.name], ['jen poznámka', `Detailní firma ${r}`]);
      assert.ok((await nacti(`${adresa()}?tab=zakladni`)).includes('jen poznámka'), 'poznámka je na obou záložkách');
    });
  });

  // ── Detail kontaktu ───────────────────────────────────────

  describe('detail kontaktu', () => {
    const adresa = () => `/crm/kontakty/${kontakt}`;
    const hodnoty = (html) => [...html.matchAll(/<div class="kpi-value">([^<]*)<\/div>/g)].map(m => m[1]);

    test('záložka Objednávky: shodné datum, každý řádek právě jednou, odkazy drží záložku', () => overSeznam({
      req, adresa: `${adresa()}?tab=objednavky`, tokeny: obKontaktu.map(tokenObjednavky), filtr: { tab: 'objednavky' },
    }));

    test('záložka Faktury: doklady přes kontakt i přes objednávku, každý právě jednou', () => overSeznam({
      req, adresa: `${adresa()}?tab=faktury`, tokeny: fakKontaktu.map(tokenDokladu), filtr: { tab: 'faktury' },
    }));

    test('souhrn a počty z SQL se rovnají součtu z dat i na druhé stránce', async () => {
      // Výpočet, jakým stránka souhrn počítala z úplných řádků (i s dokladem přes objednávku).
      const objednavky = await sql`SELECT total_price, created_at FROM shop_orders WHERE crm_contact_id = ${kontakt} ORDER BY created_at DESC`;
      const doklady = await sql`
        SELECT i.status, i.total_amount FROM accounting_invoices i
        WHERE i.crm_contact_id = ${kontakt} OR i.order_id IN (SELECT id FROM shop_orders WHERE crm_contact_id = ${kontakt})`;
      assert.equal(doklady.length, POCET, 'každý doklad jednou, i když visí na kontaktu i na objednávce');
      const utraceno = objednavky.reduce((a, o) => a + Number(o.total_price || 0), 0);
      const zaplaceno = doklady.filter(i => i.status === 'Zaplacena').reduce((a, i) => a + Number(i.total_amount || 0), 0);
      assert.ok(zaplaceno > 0 && doklady.some(i => i.status !== 'Zaplacena'), 'fixtura má zaplacené i nezaplacené');

      const ocekavane = [String(POCET), `${cs(Math.round(utraceno))} Kč`, `${cs(Math.round(zaplaceno))} Kč`, '20. 2. 2026'];
      assert.deepEqual(hodnoty(await nacti(adresa())), ocekavane);
      assert.deepEqual(hodnoty(await nacti(`${adresa()}?tab=prehled&page=2&velikost=50`)), ocekavane, 'parametry stránky souhrn nemění');

      for (const q of ['?tab=objednavky&page=2', '?tab=faktury&page=3', '']) {
        const html = await nacti(`${adresa()}${q}`);
        assert.deepEqual([pocet(html, 'Objednávky'), pocet(html, 'Faktury')], [POCET, POCET], q);
      }
    });

    test('kontakt bez objednávek: svůj doklad v souhrnu má, cizí ne', async () => {
      const html = await nacti(`/crm/kontakty/${kontaktCizi}`);
      assert.deepEqual(hodnoty(html), ['0', '0 Kč', '778 Kč', '–']);
      assert.deepEqual([pocet(html, 'Objednávky'), pocet(html, 'Faktury')], [0, 1]);
    });

    test('řádky jen pro otevřenou záložku', async () => {
      const prehled = await nacti(adresa());
      assert.ok(!obKontaktu.some(o => prehled.includes(tokenObjednavky(o))) && !fakKontaktu.some(d => prehled.includes(tokenDokladu(d))));
      const obj = await nacti(`${adresa()}?tab=objednavky`);
      assert.ok(!fakKontaktu.some(d => obj.includes(tokenDokladu(d))));
      const fak = await nacti(`${adresa()}?tab=faktury`);
      assert.ok(!obKontaktu.some(o => fak.includes(tokenObjednavky(o))));
      assert.ok(fak.includes('class="strankovani"') && !prehled.includes('class="strankovani"'));
    });

    test('neznámá záložka spadne na přehled', async () => {
      for (const q of ['xyz', 'constructor', '__proto__', 'prehled&tab=faktury', '']) {
        const html = await nacti(`${adresa()}?tab=${q}`);
        assert.match(html, new RegExp(`href="/crm/kontakty/${kontakt}\\?tab=prehled" class="tab active" aria-current="page"`), `tab=${q}`);
        assert.equal(hodnoty(html).length, 4, `tab=${q} ukáže souhrn`);
      }
    });

    test('jen ke čtení: bez formuláře a tužky, návrat na seznam', async () => {
      const html = await nacti(adresa());
      const obsah = html.slice(html.indexOf('class="page-header"'));
      assert.ok(!obsah.includes('upravit-otevrit') && !obsah.includes('data-rezim'));
      assert.ok(!/<form[^>]*method="post"[^>]*action="\/crm\/kontakty/.test(obsah));
      assert.match(obsah, /<a href="\/crm\/kontakty"[^>]*\bdata-zpet\b/);
    });
  });
});
