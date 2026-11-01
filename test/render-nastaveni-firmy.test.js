// Nastavení firmy (views/pages/settings/company.ejs) po záložkách: každá má vlastní
// formulář a POST, který zapisuje jen své sloupce. Formulář jedné záložky by přes
// společný POST tiše smazal ostatní (IČO, plátce DPH, složku Disku). Serverová část
// jede proti běžícímu serveru a lokální databázi; company_settings je jednořádková
// a sdílená, po testech se řádek obnoví.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/render-nastaveni-firmy.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { vykresliStranku, zkontrolujDetail, hodnotyFormulare } from './pomocnici/render.js';
import { PRESKOCIT, lokalniDatabaze, serverBezi, prihlas, pozadavky } from './pomocnici/server.js';

const ZALOZKY = [
  ['zakladni',  'Základní údaje',    'formFirmaZakladni'],
  ['fakturace', 'Banka a fakturace', 'formFirmaFakturace'],
  ['pohoda',    'Export do POHODY',  'formFirmaPohoda'],
  ['disk',      'Google Disk',       'formFirmaDisk'],
];

const SLOUPCE_ZALOZKY = {
  zakladni:  ['name', 'ico', 'dic', 'address', 'city', 'zip', 'country', 'phone', 'email'],
  fakturace: ['bank_account', 'bank_name', 'iban', 'swift', 'vat_payer', 'invoice_note'],
  pohoda:    ['pohoda_cash_account', 'pohoda_predkontace', 'pohoda_predkontace_prijate', 'pohoda_predkontace_repre'],
  disk:      ['gdrive_root_folder_id'],
};
const SLOUPCE = Object.values(SLOUPCE_ZALOZKY).flat();

const company = {
  id: 1, name: 'SEIL <b>s.r.o.</b>', ico: '04245610', dic: 'CZ04245610', address: 'Nádražní 1', city: 'Brno', zip: '602 00',
  country: 'Česká republika', phone: '+420 777 123 456', email: 'info@example.invalid',
  bank_account: '2800828200/2010', bank_name: 'Fio banka', iban: '', swift: '',
  vat_payer: true, invoice_note: '', pohoda_cash_account: '', pohoda_predkontace: '3Vd',
  pohoda_predkontace_prijate: '', pohoda_predkontace_repre: '', gdrive_root_folder_id: '',
};

function vykresli(prepis = {}) {
  return vykresliStranku('settings/company', {
    pageTitle: 'Nastavení firmy', currentPath: '/nastaveni/firma', company, saved: false, error: null, rezimUprav: false,
    tab: 'zakladni', zalozky: ZALOZKY, serviceAccount: 'one-seil@example.invalid', chybaKontroly: '', ...prepis,
  });
}

test('sloupce záložek pokrývají všech 20 sloupců a žádný není dvakrát', () => {
  assert.equal(SLOUPCE.length, 20);
  assert.equal(new Set(SLOUPCE).size, 20);
});

for (const [tab, , formular] of ZALOZKY) {
  test(`${tab}: tužka, formulář se svými sloupci v obou režimech, cizí sloupce v něm nejsou`, async () => {
    const zobrazeni = await vykresli({ tab });
    zkontrolujDetail(zobrazeni, { formular, sloupce: SLOUPCE_ZALOZKY[tab], rezim: 'zobrazeni' });
    const upravy = await vykresli({ tab, rezimUprav: true });
    zkontrolujDetail(upravy, { formular, sloupce: SLOUPCE_ZALOZKY[tab], rezim: 'upravy' });
    assert.equal((zobrazeni.match(/<form\b/g) || []).length, 1, 'na záložce je jeden formulář');
    assert.match(zobrazeni, /<div class="upravit-paticka jen-upravy">/, 'pod formulářem je patička Zrušit a Uložit');
    assert.ok(zobrazeni.includes(`action="/nastaveni/firma/${tab}"`), 'POST míří na routu záložky');
    assert.ok(zobrazeni.includes(`href="/nastaveni/firma?tab=${tab}&amp;upravit=1" class="btn btn-outline btn-ikona upravit-otevrit"`), 'tužka nese záložku, jinak by se tiše vypnula kontrola při Uložit');
    assert.ok(zobrazeni.includes(`href="/nastaveni/firma?tab=${tab}" class="btn btn-ghost upravit-zrusit"`), 'Zrušit se vrací na záložku');
    const odeslane = Object.keys(hodnotyFormulare(upravy, formular));
    const cizi = odeslane.filter(k => SLOUPCE.includes(k) && !SLOUPCE_ZALOZKY[tab].includes(k));
    assert.deepEqual(cizi, [], 'formulář nenese sloupce jiné záložky');
  });
}

test('pruh záložek: čtyři odkazy, otevřená je označená, odkazy bez saved', async () => {
  const html = await vykresli({ tab: 'pohoda', saved: true });
  for (const [tab, popisek] of ZALOZKY) {
    assert.ok(html.includes(`href="/nastaveni/firma?tab=${tab}"`), tab);
    assert.ok(html.includes(popisek), popisek);
  }
  assert.match(html, /<a href="\/nastaveni\/firma\?tab=pohoda" class="tab active" aria-current="page">Export do POHODY<\/a>/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
});

test('hodnoty jako text: escapovaný název, odkazy, plátce DPH, výchozí pokladna', async () => {
  const zakladni = await vykresli();
  assert.ok(zakladni.includes('SEIL &lt;b&gt;s.r.o.&lt;/b&gt;'), 'název se escapuje');
  assert.ok(!zakladni.includes('<b>s.r.o.</b>'), 'surový název v HTML není');
  assert.match(zakladni, /<a href="mailto:info@example\.invalid">info@example\.invalid<\/a>/, 'e-mail jako odkaz');
  assert.match(zakladni, /<a href="tel:\+420777123456">\+420 777 123 456<\/a>/, 'telefon jako odkaz');

  const fakturace = await vykresli({ tab: 'fakturace' });
  assert.match(fakturace, /<div class="pole-hodnota">Plátce DPH<\/div>/, 'plátce DPH jako text');
  assert.match(fakturace, /<input type="checkbox" value="on" id="pole-vat_payer" name="vat_payer" checked>/, 'checkbox posílá on');
  const neplatce = await vykresli({ tab: 'fakturace', company: { ...company, vat_payer: false } });
  assert.match(neplatce, /<div class="pole-hodnota">Neplátce DPH<\/div>/, 'neplátce má význam, ne „Ne“');
  assert.doesNotMatch(neplatce, /name="vat_payer"[^>]*checked/, 'checkbox neplátce není zaškrtnutý');

  const pohoda = await vykresli({ tab: 'pohoda' });
  assert.match(pohoda, /<div class="pole-hodnota">Pokladna<\/div>/, 'prázdná pokladna ukazuje výchozí „Pokladna“');
  assert.match(pohoda, /name="pohoda_cash_account"[^>]*maxlength="20"/);
});

test('POHODA: IČO jen pro čtení bez vstupu, box „Kam který doklad spadne“ vždy, nápovědy jen v úpravách', async () => {
  const html = await vykresli({ tab: 'pohoda' });
  assert.match(html, /<span class="form-label">IČO účetní jednotky<\/span>\s*<div class="pole-hodnota pole-mono">04245610<\/div>/);
  assert.ok(!/name="ico"/.test(html), 'IČO se odtud neodesílá');
  assert.ok(!html.includes('IČO výše'), 'IČO je na jiné záložce');
  const box = html.lastIndexOf('<div class="form-group', html.indexOf('Kam který doklad spadne'));
  assert.ok(!html.slice(box, box + 60).includes('jen-'), 'box je vidět v obou režimech');
  const hinty = html.match(/<small class="form-hint jen-upravy">[^]*?<\/small>/g) || [];
  assert.equal(hinty.length, 5, 'IČO, pokladna a tři předkontace');
  assert.ok(hinty.every(h => !h.includes('<code>')), 'nápovědy jsou prostý text');
  assert.ok(!(await vykresli({ tab: 'zakladni' })).includes('Kam který doklad spadne'), 'box patří jen na svou záložku');
});

test('Google Disk: účet služby, poslední kontrola, chyba s odkazem na konzoli, odkaz na import; nic živého', async () => {
  const url = 'https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=1';
  const html = await vykresli({ tab: 'disk', chybaKontroly: `Zapněte <b> na ${url} a zkuste znovu.`,
    company: { ...company, gdrive_posledni_kontrola: new Date('2026-11-01T09:45:33Z') } });
  assert.ok(html.includes('one-seil@example.invalid'));
  assert.ok(html.includes('1. 11. 2026'), 'čas poslední kontroly');
  assert.ok(html.includes(`<a href="${url.replace(/&/g, '&amp;')}" target="_blank" rel="noopener noreferrer">`), 'konzole je odkaz');
  assert.ok(html.includes('Zapněte &lt;b&gt;'), 'text chyby se escapuje');
  assert.ok(html.includes('href="/ucetnictvi/prijate-faktury/gdrive"'));
  assert.match(html, /drive\.google\.com\/drive\/folders\/ID/, 'adresa složky je v nápovědě');
  const bezKlice = await vykresli({ tab: 'disk', serviceAccount: null });
  assert.ok(bezKlice.includes('Není nastavený'));
  assert.ok(bezKlice.includes('Zatím neproběhla'));
});

test('hlášky: Uloženo jen v zobrazení, chyba zůstane vidět i v úpravách a nepřipadne na neznámý kód', async () => {
  const ulozeno = await vykresli({ saved: true });
  assert.match(ulozeno, /data-hlaska class="alert alert-success jen-zobrazeni"/);
  const chyba = await vykresli({ error: 'Název firmy je povinný.', rezimUprav: true });
  const blok = chyba.match(/<div data-hlaska[^>]*>[^<]*Název firmy je povinný/)?.[0];
  assert.ok(blok && !blok.includes('jen-zobrazeni'), 'chybu by jen-zobrazeni v úpravách skrylo');
});

// ── Proti serveru ───────────────────────────────────────────────

describe('proti serveru', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(4).toString('hex');
  const uklid = { users: [], sids: [] };
  let sql, req, reqBezny, puvodni, id;

  // Každý sloupec jiná hodnota: vypadlé nebo přehozené pole by se projevilo.
  const naplnene = (platce) => ({
    name: `Firma ${r}`, ico: `I${r}`, dic: `D${r}`, address: `A${r}`, city: `C${r}`, zip: `Z${r}`, country: `S${r}`, phone: `P${r}`, email: `e${r}@example.invalid`,
    bank_account: `U${r}`, bank_name: `B${r}`, iban: `CZ${r}`, swift: `SW${r}`, vat_payer: platce, invoice_note: `N${r}`,
    pohoda_cash_account: `K${r}`, pohoda_predkontace: `1${r}`, pohoda_predkontace_prijate: `2${r}`, pohoda_predkontace_repre: `3${r}`,
    gdrive_root_folder_id: `slozka${r}`,
  });
  const radek = async () => (await sql`SELECT * FROM company_settings WHERE id = ${id}`)[0];
  const norm = (v) => (v instanceof Date ? v.toISOString() : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  const rozdily = (pred, po) => Object.keys(pred).filter(k => k !== 'updated_at' && norm(pred[k]) !== norm(po[k])).sort();
  const hodnotaTelo = (k, v) => (k === 'vat_payer' ? (v ? { vat_payer: 'on' } : {}) : { [k]: String(v) });

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const [u] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`nast-firma-${r}@example.invalid`}, 'x', 'Test', 'Správce', TRUE) RETURNING id`;
    const [b] = await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
      VALUES (${`nast-bezny-${r}@example.invalid`}, 'x', 'Test', 'Běžný', FALSE) RETURNING id`;
    uklid.users.push(u.id, b.id);
    const s = await prihlas(sql, u.id);
    const s2 = await prihlas(sql, b.id);
    uklid.sids.push(s.sid, s2.sid);
    req = pozadavky(s.cookie);
    reqBezny = pozadavky(s2.cookie);
    [puvodni] = await sql`SELECT * FROM company_settings ORDER BY id LIMIT 1`;
    id = puvodni?.id ?? (await sql`INSERT INTO company_settings (name) VALUES (${`Firma test ${r}`}) RETURNING id`)[0].id;
  });

  after(async () => {
    if (!sql) return;
    if (puvodni) await sql`UPDATE company_settings SET ${sql(puvodni, ...SLOUPCE, 'updated_at')} WHERE id = ${puvodni.id}`;
    else if (id) await sql`DELETE FROM company_settings WHERE id = ${id}`;
    if (uklid.sids.length)  await sql`DELETE FROM session WHERE sid = ANY(${uklid.sids})`;
    if (uklid.users.length) await sql`DELETE FROM users WHERE id = ANY(${uklid.users})`;
    await sql.end();
  });

  test('GET: každá záložka 200, bez tab první, neznámý tab i pole z dvojitého parametru padají na první', async () => {
    for (const [tab, , formular] of ZALOZKY) {
      const html = await (await req.get(`/nastaveni/firma?tab=${tab}`)).text();
      assert.ok(html.includes(`id="${formular}" class="upravitelne" autocomplete="off"`), tab);
      assert.ok(html.includes('data-rezim="zobrazeni"'));
      const upravy = await (await req.get(`/nastaveni/firma?tab=${tab}&upravit=1`)).text();
      assert.ok(upravy.includes('data-rezim="upravy"'), tab);
    }
    for (const adresa of ['/nastaveni/firma', '/nastaveni/firma?tab=xyz', '/nastaveni/firma?tab=disk&tab=pohoda', '/nastaveni/firma?tab=__proto__', '/nastaveni/firma?error=__proto__']) {
      const res = await req.get(adresa);
      assert.equal(res.status, 200, adresa);
      assert.ok((await res.text()).includes('id="formFirmaZakladni"'), adresa);
    }
  });

  for (const [tab, , formular] of ZALOZKY) {
    for (const platce of [true, false]) {
      test(`POST ${tab} (plátce ${platce}) změní přesně své sloupce`, async () => {
        await sql`UPDATE company_settings SET ${sql(naplnene(platce))} WHERE id = ${id}`;
        const pred = await radek();
        // Tělo z opravdového formuláře, změněné jen ve sloupcích záložky.
        const html = await (await req.get(`/nastaveni/firma?tab=${tab}`)).text();
        const telo = hodnotyFormulare(html, formular);
        const ocekavane = [];
        for (const k of SLOUPCE_ZALOZKY[tab]) {
          if (k === 'vat_payer') { ocekavane.push(k); if (platce) delete telo.vat_payer; else telo.vat_payer = 'on'; continue; }
          telo[k] = `${telo[k]}-nove`;
          ocekavane.push(k);
        }
        const res = await req.post(`/nastaveni/firma/${tab}`, telo);
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), `/nastaveni/firma?tab=${tab}&saved=1`);
        assert.deepEqual(rozdily(pred, await radek()), ocekavane.sort());
      });
    }

    test(`POST ${tab} ignoruje sloupce jiné záložky v těle`, async () => {
      await sql`UPDATE company_settings SET ${sql(naplnene(true))} WHERE id = ${id}`;
      const pred = await radek();
      const telo = {};
      for (const k of SLOUPCE) Object.assign(telo, k === 'vat_payer' ? {} : { [k]: `podvrh-${k}` });
      for (const k of SLOUPCE_ZALOZKY[tab]) Object.assign(telo, hodnotaTelo(k, pred[k]));
      assert.equal((await req.post(`/nastaveni/firma/${tab}`, telo)).status, 302);
      assert.deepEqual(rozdily(pred, await radek()), []);
    });

    test(`POST ${tab} bez polí nic nesmaže`, async () => {
      await sql`UPDATE company_settings SET ${sql(naplnene(true))} WHERE id = ${id}`;
      const pred = await radek();
      const res = await req.post(`/nastaveni/firma/${tab}`, { neco: 'x' });
      assert.equal(res.status, 400);
      assert.deepEqual(rozdily(pred, await radek()), []);
    });

    test(`POST ${tab}: běžný uživatel dostane 403 a nic se nezmění`, async () => {
      await sql`UPDATE company_settings SET ${sql(naplnene(true))} WHERE id = ${id}`;
      const pred = await radek();
      assert.equal((await reqBezny.post(`/nastaveni/firma/${tab}`, { name: 'x' })).status, 403);
      assert.deepEqual(rozdily(pred, await radek()), []);
    });
  }

  test('starý společný POST /nastaveni/firma už není', async () => {
    const pred = await radek();
    const res = await req.post('/nastaveni/firma', { name: 'x' });
    assert.equal(res.status, 404);
    assert.deepEqual(rozdily(pred, await radek()), []);
  });

  test('běžný uživatel nemá ani stránku', async () => {
    assert.equal((await reqBezny.get('/nastaveni/firma?tab=disk')).status, 403);
  });

  test('zakladni: prázdný název se odmítne, řádek beze změny, chyba otevře úpravy', async () => {
    await sql`UPDATE company_settings SET ${sql(naplnene(true))} WHERE id = ${id}`;
    const pred = await radek();
    const telo = { ...hodnotyFormulare(await (await req.get('/nastaveni/firma')).text(), 'formFirmaZakladni'), name: '   ' };
    const res = await req.post('/nastaveni/firma/zakladni', telo);
    assert.equal(res.headers.get('location'), '/nastaveni/firma?tab=zakladni&error=nazev&upravit=1');
    assert.deepEqual(rozdily(pred, await radek()), []);
    const html = await (await req.get(res.headers.get('location'))).text();
    assert.ok(html.includes('Název firmy je povinný.'));
    assert.ok(html.includes('data-rezim="upravy"'));
  });

  test('fakturace: bez zaškrtnutí neplátce, s on plátce', async () => {
    const telo = { bank_account: '', bank_name: '', iban: '', swift: '', invoice_note: '' };
    await req.post('/nastaveni/firma/fakturace', telo);
    assert.equal((await radek()).vat_payer, false);
    await req.post('/nastaveni/firma/fakturace', { ...telo, vat_payer: 'on' });
    assert.equal((await radek()).vat_payer, true);
  });

  test('pohoda: prázdná pokladna je Pokladna; disk: celá adresa složky se zkrátí na ID', async () => {
    await req.post('/nastaveni/firma/pohoda', { pohoda_cash_account: '  ', pohoda_predkontace: '', pohoda_predkontace_prijate: '', pohoda_predkontace_repre: '' });
    assert.equal((await radek()).pohoda_cash_account, 'Pokladna');
    await req.post('/nastaveni/firma/disk', { gdrive_root_folder_id: 'https://drive.google.com/drive/folders/0B8Cw_a-b?resourcekey=1' });
    assert.equal((await radek()).gdrive_root_folder_id, '0B8Cw_a-b');
  });

  test('po uložení je zobrazení s hláškou a novou hodnotou', async () => {
    await req.post('/nastaveni/firma/zakladni', { ...naplnene(true), name: `Nová ${r}`, vat_payer: undefined });
    const html = await (await req.get('/nastaveni/firma?tab=zakladni&saved=1')).text();
    assert.ok(html.includes('data-rezim="zobrazeni"'));
    assert.ok(html.includes('class="alert alert-success jen-zobrazeni"'));
    assert.ok(html.includes(`<div class="pole-hodnota">Nová ${r}</div>`));
  });
});

describe('prázdná tabulka', { skip: PRESKOCIT }, () => {
  test('první uložení založí řádek bez nepravdivé poznámky na faktuře', async () => {
    const sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    const r = crypto.randomBytes(4).toString('hex');
    const [u] = await sql`INSERT INTO users (email, password_hash, is_admin) VALUES (${`nast-prazdna-${r}@example.invalid`}, 'x', TRUE) RETURNING id`;
    const { sid, cookie } = await prihlas(sql, u.id);
    const puvodni = await sql`SELECT * FROM company_settings`;
    try {
      await sql`DELETE FROM company_settings`;
      const res = await pozadavky(cookie).post('/nastaveni/firma/disk', { gdrive_root_folder_id: 'abc' });
      assert.equal(res.status, 302);
      const radky = await sql`SELECT gdrive_root_folder_id, invoice_note, country, pohoda_cash_account FROM company_settings`;
      assert.equal(radky.length, 1);
      assert.equal(radky[0].gdrive_root_folder_id, 'abc');
      assert.equal(radky[0].invoice_note, '', 'výchozí „Nejsme plátci DPH.“ se nesmí dostat na faktury');
      assert.equal(radky[0].country, 'Česká republika');
    } finally {
      await sql`DELETE FROM company_settings`;
      for (const p of puvodni) await sql`INSERT INTO company_settings ${sql(p)}`;
      await sql`DELETE FROM session WHERE sid = ${sid}`;
      await sql`DELETE FROM users WHERE id = ${u.id}`;
      await sql.end();
    }
  });
});
