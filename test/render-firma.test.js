// Detail firmy (views/pages/crm/company-detail.ejs) vykreslený bez serveru
// a databáze: režim úprav na záložkách Základní informace a Poznámky, tužka
// jen tam, a každý sloupec, který POST /crm/firmy/:id zapisuje, má ve
// formuláři pole. Druhá část jede proti serveru a lokální databázi: detail
// v obou režimech a POST /crm/firmy/:id/poznamky, který mění jen poznámku –
// dřív šly poznámky přes formulář s hidden poli, kde chyběl web, a každé
// uložení poznámek ho firmě smazalo.
//
//   node --test test/render-firma.test.js
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/render-firma.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { vykresliStranku, zkontrolujDetail } from './pomocnici/render.js';
import { lokalniDatabaze, serverBezi, prihlas, pozadavky, PRESKOCIT } from './pomocnici/server.js';
import { strankovani } from '../src/strankovani.js';

// ── A) bez serveru ──────────────────────────────────────────

const company = {
  id: 'firmatest01', name: 'Vlněnka <s.r.o.>', company_type: 'Zákazník', company_status: 'Aktivní',
  ico: '12345678', dic: 'CZ12345678', legal_form: 'Společnost s ručením omezeným (s.r.o.)',
  registration_info: 'C 12345 vedená u KS v Brně', founded_date: new Date('2020-01-15T00:00:00Z'),
  address: 'Nádražní 1', city: 'Brno', zip: '602 00', country: '',
  email: 'info@vlnenka.example.invalid', phone: '+420 777 123 456', website: 'https://vlnenka.example.invalid',
  notes: 'Dobrý klient <b>neescapovat</b>', source: null, ares_synced_at: null,
  created_at: new Date('2025-03-05T10:00:00Z'), modified_at: new Date('2026-10-01T10:00:00Z'), created_by: null, modified_by: null,
};

const ZALOZKY = ['zakladni', 'kontakty', 'objednavky', 'faktury', 'smlouvy', 'poznamky'];
const FORMULARE = { zakladni: 'formFirma', poznamky: 'formPoznamky' };

// Sloupce z UPDATE v src/routes/crm.js: POST /crm/firmy/:id a POST /crm/firmy/:id/poznamky
const SLOUPCE = {
  zakladni: ['name', 'company_type', 'ico', 'dic', 'country', 'city', 'zip', 'address', 'email', 'phone', 'website',
             'notes', 'legal_form', 'founded_date', 'registration_info', 'company_status'],
  poznamky: ['notes'],
};

function vykresli(tab, prepis = {}) {
  return vykresliStranku('crm/company-detail', {
    pageTitle: company.name, currentPath: '/crm/firmy', company,
    contacts: [], orders: [], invoices: [], contracts: [],
    stats: { totalInvoiced: 0, paidInvoices: 0, openOrders: 0, totalOrders: 0, totalInvoices: 0, totalContacts: 0 },
    creator: null, editor: null, aresUpdated: false, saved: false, tab, rezimUprav: false,
    zalozky: ZALOZKY.map(klic => ({ klic, popisek: klic })),
    strany: strankovani({ cesta: `/crm/firmy/${company.id}`, celkem: 0, pevne: { tab } }),
    ...prepis,
  });
}

for (const tab of ZALOZKY) {
  const formular = FORMULARE[tab] || null;
  test(`záložka ${tab}: ${formular ? 'tužka, formulář a všechny sloupce' : 'bez tužky'} v obou režimech`, async () => {
    const zobrazeni = await vykresli(tab);
    zkontrolujDetail(zobrazeni, { formular, sloupce: SLOUPCE[tab] || [], rezim: 'zobrazeni' });
    const upravy = await vykresli(tab, { rezimUprav: true });
    zkontrolujDetail(upravy, { formular, sloupce: SLOUPCE[tab] || [], rezim: formular ? 'upravy' : 'zobrazeni' });
  });
}

test('základní informace: hodnoty jako text a odkaz, datum nezávisle na pásmu, tužka bez JS, modal pryč', async () => {
  const html = await vykresli('zakladni');
  assert.ok(html.includes('Dobrý klient &lt;b&gt;neescapovat&lt;/b&gt;'), 'poznámka se escapuje');
  assert.ok(!html.includes('<b>neescapovat</b>'), 'surové HTML z poznámky ve stránce není');
  assert.match(html, /<a href="https:\/\/vlnenka\.example\.invalid" target="_blank" rel="noopener noreferrer">https:\/\/vlnenka\.example\.invalid<\/a>/, 'web jako odkaz');
  assert.match(html, /<a href="mailto:info@vlnenka\.example\.invalid">info@vlnenka\.example\.invalid<\/a>/, 'e-mail jako odkaz');
  assert.match(html, /<div class="pole-hodnota">15\. 1\. 2020<\/div>/, 'datum vzniku česky');
  assert.match(html, /<input type="date"[^>]*value="2020-01-15"[^>]*name="founded_date"/, 'vstup data ve tvaru YYYY-MM-DD');
  assert.match(html, /<input type="text"[^>]*value="Česká republika"[^>]*name="country"/, 'prázdný stát má ve vstupu výchozí Českou republiku');
  assert.match(html, /<div class="form-group pole jen-upravy" style="grid-column:1\/-1">\s*<label class="form-label required" for="pole-name">Název<\/label>/, 'název je povinný a jen v úpravách – v zobrazení je v hlavičce');
  assert.match(html, /<div class="form-group pole jen-upravy">\s*<label class="form-label" for="pole-company_type">Typ<\/label>/, 'typ jen v úpravách');
  assert.match(html, /<option value="Zákazník" selected>Zákazník<\/option>/, 'typ má předvybranou hodnotu');
  assert.ok(html.includes('href="?tab=zakladni&amp;upravit=1"'), 'tužka bez JS otevře úpravy na téže záložce');
  assert.ok(html.includes('href="?tab=zakladni" class="btn btn-ghost upravit-zrusit"'), 'Zrušit vede zpět bez upravit');
  assert.match(html, /<button type="button" class="btn btn-outline jen-zobrazeni" onclick="syncAres\(\)">/, 'Sync ARES v plné velikosti vedle tužky');
  assert.ok(!html.includes('modalEdit') && !html.includes('✏️ Upravit'), 'modal úprav i jeho tlačítko jsou pryč');
  assert.ok(html.includes('<div class="upravit-paticka jen-upravy">'), 'dlouhý formulář má patičku');
  // první </form> patří skrytému aresForm v hlavičce – hledá se až od formuláře záznamu
  const zacatekFormulare = html.indexOf('id="formFirma"');
  assert.ok(zacatekFormulare > -1 && html.indexOf('</form>', zacatekFormulare) > html.indexOf('Ověřit v ARES'), 'formulář obaluje celý grid záložky včetně pravého sloupce');
});

test('karta Poznámky je vidět i bez poznámky, hláška Uloženo se v úpravách skryje', async () => {
  const html = await vykresli('zakladni', { company: { ...company, notes: '', ares_synced_at: new Date('2026-09-09T08:00:00Z') }, saved: true });
  assert.match(html, /<strong>Poznámky<\/strong>/, 'karta je vždy – jinak by poznámka nešla poprvé vyplnit');
  assert.match(html, /<div class="pole-hodnota pole-hodnota-blok"><span class="pole-prazdne">–/, 'prázdná poznámka ukáže pomlčku');
  assert.match(html, /class="jen-zobrazeni"[^>]*>✓ Uloženo</, 'banner Uloženo je jen pro režim zobrazení');
  assert.ok(html.includes('ARES naposledy synchronizován:'), 'řádek o synchronizaci zůstal');
});

test('záložka poznámky: vlastní routa, jen textarea, žádná hidden pole', async () => {
  const html = await vykresli('poznamky');
  const form = html.match(/<form method="post" action="\/crm\/firmy\/firmatest01\/poznamky" id="formPoznamky" class="upravitelne" autocomplete="off">([\s\S]*?)<\/form>/);
  assert.ok(form, 'formulář poznámek míří na /crm/firmy/:id/poznamky');
  assert.ok(!form[1].includes('type="hidden"'), 'bez hidden polí – routa přepisuje jen poznámku');
  assert.match(form[1], /<textarea class="form-control" rows="10"[^>]*name="notes"/, 'textarea má 10 řádků');
  assert.ok(!html.includes('name="website"'), 'web se z poznámek neposílá');
  assert.ok(html.includes('href="?tab=poznamky&amp;upravit=1"'), 'tužka vede na záložku poznámek');
  assert.ok(!html.includes('Uložit poznámky'), 'staré tlačítko v patičce je pryč');
});

test('neznámá záložka z URL nenajde formulář ani v prototypu objektu', async () => {
  for (const tab of ['constructor', '__proto__', 'toString']) {
    const html = await vykresli(tab, { rezimUprav: true });
    zkontrolujDetail(html, { formular: null, rezim: 'zobrazeni' });
  }
});

test('bez IČO a bez formuláře záznamu nejsou v hlavičce žádné akce', async () => {
  const html = await vykresli('kontakty', { company: { ...company, ico: '' } });
  assert.ok(!html.includes('page-header-akce') && !html.includes('syncAres()"'), 'prázdný obal akcí se nevykreslí');
  const sAres = await vykresli('kontakty');
  assert.ok(sAres.includes('class="page-header-akce"') && sAres.includes('Sync ARES'), 'Sync ARES je i na záložce bez tužky');
});

// ── B) proti serveru a lokální databázi ─────────────────────

test('Sync ARES: jen v zobrazení, před přepisem se zeptá a IČO z formuláře skript nerozbije', async () => {
  const html = await vykresli('zakladni', { company: { ...company, ico: "12\\34'</script>" }, aresUpdated: true });
  assert.match(html, /<button type="button" class="btn btn-outline jen-zobrazeni" onclick="syncAres\(\)">/);
  assert.ok(html.includes("if (!confirm('Přepsat název"), 'přepis údajů nejde spustit bez dotazu');
  assert.ok(html.includes(`var ico = "12\\\\34'\\u003c/script>";`), 'IČO je v inline skriptu jako bezpečný řetězec');
  assert.match(html, /<div data-hlaska style="[^"]*">✓ Data aktualizována z ARES/, 'hláška zmizí po přepnutí režimu');
});

describe('proti serveru', { skip: PRESKOCIT }, () => {
  let sql;
  const r = crypto.randomBytes(4).toString('hex');
  const uklid = { users: [], sids: [], firmy: [] };
  const ctx = {};

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 3, onnotice: () => {} });
    await serverBezi();
    const [u] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`firma-${r}@example.invalid`}, 'x', 'Test', 'Správce', TRUE) RETURNING id`;
    uklid.users.push(u.id);
    ctx.userId = u.id;
    const { sid, cookie } = await prihlas(sql, u.id);
    uklid.sids.push(sid);
    ctx.api = pozadavky(cookie);

    ctx.firmaId = `firmatest${r}`;
    await sql`
      INSERT INTO crm_companies (id, name, company_type, website)
      VALUES (${ctx.firmaId}, ${`Firma test ${r}`}, 'Zákazník', 'https://firma.example.invalid')`;
    uklid.firmy.push(ctx.firmaId);
  });

  after(async () => {
    if (!sql) return;
    if (uklid.firmy.length) await sql`DELETE FROM crm_companies WHERE id = ANY(${uklid.firmy})`;
    if (uklid.sids.length)  await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
    if (uklid.users.length) await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
    await sql.end();
  });

  const detail = async (q = '') => {
    const res = await ctx.api.get(`/crm/firmy/${ctx.firmaId}${q}`);
    assert.equal(res.status, 200, q);
    return res.text();
  };

  test('detail: výchozí zobrazení, ?upravit=1 otevře úpravy, záložka bez formuláře tužku nemá', async () => {
    let html = await detail('');
    assert.ok(html.includes('data-rezim="zobrazeni"'), 'výchozí je zobrazení');
    assert.ok(html.includes('href="?tab=zakladni&amp;upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"'), 'tužka vede bez JS na ?upravit=1');
    assert.ok(html.includes('form="formFirma" class="btn btn-primary upravit-ulozit"'), 'Uložit míří na formulář záznamu');
    assert.ok(html.includes(`action="/crm/firmy/${ctx.firmaId}" id="formFirma" class="upravitelne"`), 'formulář záznamu je označený');
    assert.ok(!html.includes('modalEdit'), 'modal úprav je pryč');

    html = await detail('?tab=zakladni&upravit=1');
    assert.ok(html.includes('data-rezim="upravy"'), '?upravit=1 otevře úpravy i bez JavaScriptu');

    html = await detail('?tab=poznamky&upravit=1');
    assert.ok(html.includes('data-rezim="upravy"') && html.includes(`action="/crm/firmy/${ctx.firmaId}/poznamky" id="formPoznamky" class="upravitelne"`), 'poznámky mají vlastní formulář');

    for (const tab of ['kontakty', 'objednavky', 'faktury', 'smlouvy']) {
      html = await detail(`?tab=${tab}&upravit=1`);
      assert.ok(html.includes('data-rezim="zobrazeni"') && !html.includes('upravit-otevrit') && !html.includes('upravit-ulozit'), `${tab}: bez formuláře záznamu není tužka ani úpravy`);
    }
  });

  test('POST /crm/firmy/:id/poznamky uloží jen poznámku – web zůstane', async () => {
    const res = await ctx.api.post(`/crm/firmy/${ctx.firmaId}/poznamky`, { notes: `  Nová poznámka ${r}  ` });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/crm/firmy/${ctx.firmaId}?tab=poznamky&saved=1`, 'vrátí na záložku poznámek bez upravit');
    const [f] = await sql`SELECT name, notes, website, modified_by FROM crm_companies WHERE id = ${ctx.firmaId}`;
    assert.equal(f.notes, `Nová poznámka ${r}`, 'poznámka se uložila oříznutá');
    assert.equal(f.website, 'https://firma.example.invalid', 'web se poznámkami nemaže');
    assert.equal(f.name, `Firma test ${r}`, 'název se nemění');
    assert.equal(f.modified_by, ctx.userId);
    const html = await detail('?tab=poznamky&saved=1');
    assert.ok(html.includes(`Nová poznámka ${r}`) && /class="jen-zobrazeni"[^>]*>✓ Uloženo/.test(html), 'detail ukáže novou poznámku a hlášku');
  });

  test('POST /crm/firmy/:id/poznamky bez pole notes poznámky nesmaže', async () => {
    const [pred] = await sql`SELECT notes FROM crm_companies WHERE id = ${ctx.firmaId}`;
    assert.ok(pred.notes, 'fixtura má poznámku z předchozího testu');
    const res = await ctx.api.post(`/crm/firmy/${ctx.firmaId}/poznamky`, {});
    assert.equal(res.status, 400);
    const [po] = await sql`SELECT notes FROM crm_companies WHERE id = ${ctx.firmaId}`;
    assert.equal(po.notes, pred.notes);
  });

  test('POST /crm/firmy/:id uloží základní informace a přesměruje do zobrazení', async () => {
    const res = await ctx.api.post(`/crm/firmy/${ctx.firmaId}`, {
      name: `Firma nová ${r}`, company_type: 'Partner', city: 'Brno', website: 'https://nova.example.invalid',
      notes: `Nová poznámka ${r}`, founded_date: '2020-01-15', company_status: 'Aktivní',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/crm/firmy/${ctx.firmaId}?saved=1`, 'po uložení zpět do zobrazení');
    const [f] = await sql`SELECT name, company_type, city, website, founded_date::text AS founded_date FROM crm_companies WHERE id = ${ctx.firmaId}`;
    assert.deepEqual([f.name, f.company_type, f.city, f.website, f.founded_date],
      [`Firma nová ${r}`, 'Partner', 'Brno', 'https://nova.example.invalid', '2020-01-15']);
    const html = await detail('?saved=1');
    assert.ok(html.includes('data-rezim="zobrazeni"'), 'saved bez upravit je zobrazení');
    assert.match(html, /<div class="pole-hodnota">15\. 1\. 2020<\/div>/, 'datum vzniku z databáze česky');
  });
});
