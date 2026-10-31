// Detail projektu (views/pages/projects/detail.ejs) a podprojektu
// (views/pages/projects/item-detail.ejs) v režimu úprav „tužka → Uložit“.
// První část vykresluje šablony bez serveru a databáze: tužka jen na záložce
// s formulářem záznamu, žádný vnořený formulář a každý sloupec, který POST
// routy v src/routes/projects.js přepisují, má ve formuláři pole. Druhá část
// jede proti běžícímu serveru a lokální databázi (bez DATABASE_URL se přeskočí).
//
//   node --test test/render-projekt.test.js
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/render-projekt.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { vykresliStranku, zkontrolujDetail } from './pomocnici/render.js';
import { PRESKOCIT, lokalniDatabaze, serverBezi, prihlas, pozadavky } from './pomocnici/server.js';
import { PROJECT_TYPES } from '../src/routes/projects.js';

// Stejná pole jako v src/routes/projects.js (routa je neexportuje).
const PROJECT_STATUSES = ['Aktivní', 'Pozastaveno', 'Dokončeno', 'Archivováno'];
const ITEM_STATUSES    = ['V přípravě', 'Aktivní', 'Pozastaveno', 'Dokončeno'];

// Sloupce z UPDATE v src/routes/projects.js (+ hidden tab, podle kterého POST přesměruje)
const SLOUPCE_PROJEKTU = ['name', 'status', 'primary_contact_id', 'start_date', 'brand_primary_color', 'brand_secondary_color',
  'brand_fonts', 'brand_assets_url', 'brand_notes', 'billing_payment_terms_days', 'billing_currency', 'billing_hourly_rate',
  'billing_notes', 'notes', 'tab'];
const SLOUPCE_PODPROJEKTU = ['name', 'status', 'description', 'hosting_provider', 'production_url', 'staging_url', 'repo_url',
  'tech_stack', 'shop_id', 'healthcheck_id', 'go_live_date', 'notes'];

const DATUM = new Date('2026-01-10T00:00:00Z');
const project = {
  id: 'proj1', company_id: 'firma1', company_name: 'Vlněnka <b>s.r.o.</b>', name: 'Web <Vlněnka>', status: 'Aktivní',
  primary_contact_id: 'kont1', start_date: DATUM,
  brand_primary_color: '#14E6E6', brand_secondary_color: 'tmavě modrá', brand_fonts: '', brand_assets_url: 'https://drive.example.invalid/brand', brand_notes: '',
  billing_payment_terms_days: 14, billing_currency: 'CZK', billing_hourly_rate: '1500.00', billing_notes: '',
  notes: 'Poznámka <b>tučně</b>', created_at: DATUM, modified_at: DATUM,
};
const contacts = [{ id: 'kont1', first_name: 'Jana', last_name: 'Nováková' }, { id: 'kont2', first_name: 'Petr', last_name: '' }];
const healthchecks = [{ id: 3, name: 'Web Vlněnka' }];
const shops = [{ id: 7, name: 'Dílna' }];
const item = {
  id: 'item1', project_id: 'proj1', project_name: project.name, company_id: 'firma1', company_name: project.company_name,
  type: 'web', name: 'Prezentace <b>webu</b>', status: 'Aktivní', description: '', hosting_provider: 'Coolify — VPS #1',
  production_url: 'https://dilnavlnenka.cz', staging_url: '', repo_url: '', tech_stack: '', shop_id: 7, healthcheck_id: null,
  go_live_date: DATUM, notes: '', created_at: DATUM, modified_at: DATUM,
};

function vykresliProjekt(tab, prepis = {}) {
  return vykresliStranku('projects/detail', {
    pageTitle: project.name, currentPath: '/projekty', project, contacts, items: [], healthchecks, shops,
    PROJECT_TYPES, PROJECT_STATUSES, ITEM_STATUSES, tab, saved: false, rezimUprav: false, ...prepis,
  });
}
function vykresliPodprojekt(prepis = {}) {
  return vykresliStranku('projects/item-detail', {
    pageTitle: item.name, currentPath: '/projekty', item, health: null, shop: null, healthchecks, shops,
    PROJECT_TYPES, ITEM_STATUSES, saved: false, rezimUprav: false, ...prepis,
  });
}

test('projekt, záložka prehled: tužka, formulář a všechny sloupce v obou režimech', async () => {
  const zobrazeni = await vykresliProjekt('prehled');
  zkontrolujDetail(zobrazeni, { formular: 'formProjekt', sloupce: SLOUPCE_PROJEKTU, rezim: 'zobrazeni' });
  const upravy = await vykresliProjekt('prehled', { rezimUprav: true });
  zkontrolujDetail(upravy, { formular: 'formProjekt', sloupce: SLOUPCE_PROJEKTU, rezim: 'upravy' });
});

test('projekt, záložka podprojekty: bez tužky a ?upravit=1 úpravy neotevře', async () => {
  const zobrazeni = await vykresliProjekt('podprojekty');
  zkontrolujDetail(zobrazeni, { formular: null, rezim: 'zobrazeni' });
  const upravy = await vykresliProjekt('podprojekty', { rezimUprav: true });
  zkontrolujDetail(upravy, { formular: null, rezim: 'zobrazeni' });
  assert.ok(upravy.includes('id="modalAddItem"'), 'modal pro přidání podprojektu zůstává');
});

test('projekt: hodnoty jako text, vzorek barvy jen u platného hexu, modal úprav je pryč', async () => {
  const html = await vykresliProjekt('prehled', { saved: true });
  assert.ok(html.includes('Web &lt;Vlněnka&gt;'), 'název se escapuje');
  assert.ok(html.includes('Poznámka &lt;b&gt;tučně&lt;/b&gt;'), 'poznámka se escapuje');
  assert.match(html, /<div class="pole-hodnota">Jana Nováková<\/div>/, 'kontaktní osoba jako jméno, ne id');
  assert.match(html, /<div class="pole-hodnota">14 dní<\/div>/, 'splatnost s jednotkou');
  assert.match(html, /<div class="pole-hodnota">1 500 CZK\/h<\/div>/, 'sazba česky s měnou');
  assert.ok(html.includes('10. 1. 2026'), 'datum zahájení česky nezávisle na časovém pásmu');
  assert.match(html, /<span class="barva-vzorek" style="background:#14E6E6;"><\/span><code>#14E6E6<\/code>/, 'platný hex má vzorek');
  assert.ok(!html.includes('background:tmavě'), 'neplatná barva do style nejde');
  assert.ok(html.includes('>tmavě modrá<'), 'ale je vidět jako text');
  assert.match(html, /<a href="https:\/\/drive\.example\.invalid\/brand" target="_blank" rel="noopener noreferrer">/, 'brand manuál jako odkaz');
  assert.match(html, /<div class="form-group pole jen-upravy">\s*<label class="form-label required" for="pole-name">/, 'název je v kartě jen při úpravách (v zobrazení je v hlavičce)');
  assert.match(html, /<input type="hidden" name="tab" value="prehled">/, 'hidden tab zůstává — POST podle něj přesměruje');
  assert.ok(html.includes('href="?tab=prehled&amp;upravit=1"'), 'tužka bez JS otevře úpravy na téže záložce');
  assert.ok(html.includes('href="?tab=prehled" class="btn btn-ghost upravit-zrusit"'), 'Zrušit vede zpět bez upravit');
  assert.match(html, /class="jen-zobrazeni"[^>]*>✓ Uloženo</, 'banner Uloženo je jen pro režim zobrazení');
  assert.ok(!html.includes('modalEditProject') && !html.includes('✏️ Upravit'), 'modal úprav i tlačítko, které ho otevíralo, jsou pryč');
  assert.ok(!html.includes('tlačítkem Upravit'), 'věta o tlačítku Upravit je pryč');
  assert.ok(html.includes('<strong>Poznámky</strong>') && html.includes('<strong>Brand identita</strong>'), 'karty se vykreslují vždy');
});

test('podprojekt: tužka, formulář a všechny sloupce v obou režimech', async () => {
  const zobrazeni = await vykresliPodprojekt();
  zkontrolujDetail(zobrazeni, { formular: 'formPodprojekt', sloupce: SLOUPCE_PODPROJEKTU, rezim: 'zobrazeni' });
  const upravy = await vykresliPodprojekt({ rezimUprav: true });
  zkontrolujDetail(upravy, { formular: 'formPodprojekt', sloupce: SLOUPCE_PODPROJEKTU, rezim: 'upravy' });
});

test('podprojekt: odkazy, prázdné karty, napojení jen v úpravách, modal úprav je pryč', async () => {
  const html = await vykresliPodprojekt();
  assert.ok(html.includes('Prezentace &lt;b&gt;webu&lt;/b&gt;'), 'název se escapuje');
  assert.match(html, /<a href="https:\/\/dilnavlnenka\.cz" target="_blank" rel="noopener noreferrer">https:\/\/dilnavlnenka\.cz<\/a>/, 'produkční URL jako odkaz');
  assert.ok(html.includes('<strong>Popis</strong>') && html.includes('<strong>Poznámky</strong>'), 'karty Popis a Poznámky i bez hodnoty');
  assert.match(html, /<div class="form-group pole jen-upravy">\s*<label class="form-label" for="pole-shop_id">/, 'napojený eshop je v kartě jen při úpravách (v zobrazení ho ukazuje karta vpravo)');
  assert.match(html, /<select class="form-select" id="pole-shop_id" name="shop_id">\s*<option value="">— žádný —<\/option>\s*<option value="7" selected>Dílna<\/option>/, 'eshop je ve výběru předvybraný');
  assert.match(html, /<select class="form-select" id="pole-healthcheck_id" name="healthcheck_id">\s*<option value="" selected>— žádný —<\/option>/, 'bez healthchecku je vybraná prázdná volba');
  assert.ok(html.includes('Přidejte ho tužkou nahoře.'), 'text o healthchecku neodkazuje na tlačítko Upravit');
  assert.ok(html.includes('href="?upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"'), 'tužka bez JS');
  assert.ok(html.includes(`href="/projekty/podprojekty/${item.id}" class="btn btn-ghost upravit-zrusit"`), 'Zrušit vede na kanonickou cestu stránky');
  assert.ok(!html.includes('modalEditItem') && !html.includes('✏️ Upravit'), 'modal úprav i tlačítko, které ho otevíralo, jsou pryč');
});

// ── Proti serveru a lokální databázi ─────────────────────────────

describe('proti serveru', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(4).toString('hex');
  const ids = { firma: `tprojf${r}`, projekt: `tprojp${r}`, item: `tproji${r}` };
  let sql, http, sid, userId;

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const [u] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`projekt-${r}@example.invalid`}, 'x', 'Test', 'Správce', TRUE) RETURNING id`;
    userId = u.id;
    const session = await prihlas(sql, userId);
    sid = session.sid;
    http = pozadavky(session.cookie);
    await sql`INSERT INTO crm_companies (id, name, company_type) VALUES (${ids.firma}, ${`Firma ${r}`}, 'Zákazník')`;
    await sql`INSERT INTO projects (id, company_id, name, status, start_date) VALUES (${ids.projekt}, ${ids.firma}, ${`Projekt ${r}`}, 'Aktivní', '2026-01-10')`;
    await sql`INSERT INTO project_items (id, project_id, type, name, status, production_url)
              VALUES (${ids.item}, ${ids.projekt}, 'web', ${`Web ${r}`}, 'Aktivní', 'https://web.example.invalid')`;
  });

  after(async () => {
    if (!sql) return;
    // Pořadí podle cizích klíčů: podprojekt → projekt → firma.
    await sql`DELETE FROM project_items WHERE id = ${ids.item}`;
    await sql`DELETE FROM projects WHERE id = ${ids.projekt}`;
    await sql`DELETE FROM crm_companies WHERE id = ${ids.firma}`;
    if (sid) await sql`DELETE FROM session WHERE sid = ${sid}`;
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.end();
  });

  test('detail projektu: zobrazení, ?upravit=1 otevře úpravy, záložka podprojekty bez tužky', async () => {
    const res = await http.get(`/projekty/${ids.projekt}`);
    assert.equal(res.status, 200);
    let html = await res.text();
    assert.ok(html.includes('data-rezim="zobrazeni"'), 'výchozí je zobrazení');
    assert.ok(html.includes('href="?tab=prehled&amp;upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"'), 'tužka vede bez JS na ?upravit=1');
    assert.ok(html.includes('id="formProjekt" class="upravitelne"'), 'formulář záznamu je označený');
    assert.ok(html.includes(`Projekt ${r}`), 'projekt z fixture');

    html = await (await http.get(`/projekty/${ids.projekt}?tab=prehled&upravit=1`)).text();
    assert.ok(html.includes('data-rezim="upravy"'), '?upravit=1 otevře úpravy i bez JavaScriptu');

    html = await (await http.get(`/projekty/${ids.projekt}?tab=podprojekty&upravit=1`)).text();
    assert.ok(html.includes('data-rezim="zobrazeni"') && !html.includes('upravit-otevrit') && !html.includes('upravit-ulozit'), 'bez formuláře záznamu není tužka ani úpravy');
  });

  test('detail podprojektu: oba režimy', async () => {
    const res = await http.get(`/projekty/podprojekty/${ids.item}`);
    assert.equal(res.status, 200);
    let html = await res.text();
    assert.ok(html.includes('data-rezim="zobrazeni"'));
    assert.ok(html.includes('id="formPodprojekt" class="upravitelne"'));
    assert.ok(html.includes('href="?upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"'));
    html = await (await http.get(`/projekty/podprojekty/${ids.item}?upravit=1`)).text();
    assert.ok(html.includes('data-rezim="upravy"'));
  });

  test('POST projektu uloží a vrátí na záložku bez upravit', async () => {
    const res = await http.post(`/projekty/${ids.projekt}`, {
      tab: 'prehled', name: `Projekt ${r} nový`, status: 'Pozastaveno', primary_contact_id: '', start_date: '2026-02-01',
      billing_payment_terms_days: '30', billing_currency: 'EUR', billing_hourly_rate: '1500.5', notes: 'pozn.',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/projekty/${ids.projekt}?tab=prehled&saved=1`);
    const [p] = await sql`SELECT name, status, billing_payment_terms_days, billing_currency, billing_hourly_rate, notes FROM projects WHERE id = ${ids.projekt}`;
    assert.equal(p.name, `Projekt ${r} nový`);
    assert.equal(p.status, 'Pozastaveno');
    assert.equal(p.billing_payment_terms_days, 30);
    assert.equal(p.billing_currency, 'EUR');
    assert.equal(Number(p.billing_hourly_rate), 1500.5);
    assert.equal(p.notes, 'pozn.');

    const html = await (await http.get(`/projekty/${ids.projekt}?tab=prehled&saved=1`)).text();
    assert.ok(html.includes('data-rezim="zobrazeni"') && html.includes('✓ Uloženo'), 'po uložení zpět v zobrazení s hláškou');
    assert.match(html, /<div class="pole-hodnota">1 500,5 EUR\/h<\/div>/, 'sazba se ukáže s novou měnou');
  });

  test('POST podprojektu uloží název a vrátí na detail bez upravit', async () => {
    const res = await http.post(`/projekty/podprojekty/${ids.item}`, {
      name: `Web ${r} nový`, status: 'Dokončeno', production_url: 'https://web.example.invalid', shop_id: '', healthcheck_id: '',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/projekty/podprojekty/${ids.item}?saved=1`);
    const [i] = await sql`SELECT name, status, shop_id FROM project_items WHERE id = ${ids.item}`;
    assert.equal(i.name, `Web ${r} nový`);
    assert.equal(i.status, 'Dokončeno');
    assert.equal(i.shop_id, null);
  });
});
