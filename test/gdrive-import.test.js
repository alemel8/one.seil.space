// Automatický import přijatých faktur z Google Disku proti lokální databázi:
// Drive API je nasimulované přes fetch, vytěžení Claudem je předané jako funkce.
//
//   node --test test/gdrive-import.test.js
//   DATABASE_URL=postgresql://…@127.0.0.1/… node --test test/gdrive-import.test.js
//
// Hlídá hlavně to, co by v účetnictví nadělalo škodu: první kontrola nic
// nenaimportuje, stejná faktura z POHODY se doplní a nezaloží znovu, nevytěžený
// doklad nezaloží prázdnou fakturu a pokusy o něj mají strop.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import postgres from 'postgres';
import { PRESKOCIT, lokalniDatabaze } from './pomocnici/server.js';
import { idSlozky, monthOfFolder } from '../src/gdrive.js';

describe('názvy složek a ID', () => {
  test('červenec není červen', () => {
    assert.equal(monthOfFolder('Červenec'), 7);
    assert.equal(monthOfFolder('Červen'), 6);
    assert.equal(monthOfFolder('7. Červenec'), 7);
    assert.equal(monthOfFolder('07 - červenec'), 7);
    assert.equal(monthOfFolder('Přijaté'), null);
  });

  test('skutečné názvy složek na Disku', () => {
    ['1. Leden', '2. Unor', '3. Brezen', '4. Duben', '5. Kveten', '6. Cerven',
      '7. Cervenec', '8. Srpen', '9. Zari', '10. Rijen', '11. Listopad', '12. Prosinec',
    ].forEach((nazev, i) => assert.equal(monthOfFolder(nazev), i + 1, nazev));
  });

  test('z adresy složky zůstane jen ID', () => {
    assert.equal(idSlozky('https://drive.google.com/drive/folders/0B8Cw_a-b?resourcekey=0-fz6'), '0B8Cw_a-b');
    assert.equal(idSlozky(' 0B8Cw_a-b '), '0B8Cw_a-b');
    assert.equal(idSlozky(undefined), '');
  });
});

describe('automatický import', { skip: PRESKOCIT }, () => {
  const FOLDER = 'application/vnd.google-apps.folder';
  const ROOT = 'root-test';
  // Skutečný čas: pauzu mezi pokusy porovnává s NOW() databáze.
  const NOW = new Date();
  const ROK = String(NOW.getFullYear());
  const PDF = Buffer.from('%PDF-1.4 test');
  const puvodniFetch = globalThis.fetch;
  const puvodniKlic = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const VYTEZENO = {
    number: 'FA-77', supplier: 'WEDOS Internet, a.s.', supplier_ico: '28115708',
    amount: 100, vat_amount: 21, total_amount: 121, currency: 'CZK', issue_date: '2026-11-01',
  };

  let sql;
  let tikGdrive;
  let importujSoubor;
  let MAX_POKUSU;
  let deleteAttachment;
  let doklady;
  let oznameni;

  const extract = async () => VYTEZENO;
  const notify = async (zprava) => { oznameni.push(zprava); return {}; };
  const faktura = async (fileId) => (await sql`SELECT * FROM accounting_invoices WHERE gdrive_file_id = ${fileId}`)[0];
  const stav = async (fileId) => (await sql`SELECT * FROM gdrive_soubory WHERE file_id = ${fileId}`)[0];

  function odpovedDrive(url) {
    const u = new URL(url);
    if (u.host === 'oauth2.googleapis.com') return { access_token: 'tok', expires_in: 3600 };
    const parent = u.searchParams.get('q')?.match(/^'([^']+)'/)?.[1];
    if (parent === ROOT) return { files: [{ id: 'rok-test', name: ROK, mimeType: FOLDER }] };
    if (parent === 'rok-test') return { files: [{ id: 'mes-11', name: 'Listopad', mimeType: FOLDER }] };
    if (parent === 'mes-11') return { files: [{ id: 'prij-11', name: 'Přijaté faktury', mimeType: FOLDER }] };
    if (parent === 'prij-11') return { files: doklady.map(id => ({ id, name: `${id}.pdf`, mimeType: 'application/pdf' })) };
    if (parent) return { files: [] };
    return { id: u.pathname.split('/').pop(), name: 'doklad.pdf', mimeType: 'application/pdf' };
  }

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'test@test.iam.gserviceaccount.com', private_key: privateKey });
    ({ tikGdrive, importujSoubor, MAX_POKUSU } = await import('../src/gdrive-import.js'));
    ({ deleteAttachment } = await import('../src/attachments.js'));
  });

  // Přílohy jdou do data/media a cesta se nedá přesměrovat, proto se mažou i s fakturami.
  const uklid = async () => {
    // Řádky ir- patří souběžně běžícímu test/interni-rada.test.js.
    await sql`DELETE FROM gdrive_soubory WHERE file_id NOT LIKE 'ir-%'`;
    const smazane = await sql`
      DELETE FROM accounting_invoices
      WHERE number LIKE 'FA-%' OR number LIKE 'POHODA-%' OR gdrive_file_id IS NOT NULL
      RETURNING attachment_path
    `;
    for (const { attachment_path } of smazane) if (attachment_path) await deleteAttachment(attachment_path);
  };

  after(async () => {
    await uklid();
    if (puvodniKlic === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = puvodniKlic;
    await sql.end();
  });

  beforeEach(async () => {
    doklady = [];
    oznameni = [];
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.searchParams.get('alt') === 'media') return new Response(PDF, { status: 200 });
      return new Response(JSON.stringify(odpovedDrive(url)), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await uklid();
    const [firma] = await sql`SELECT id FROM company_settings LIMIT 1`;
    if (firma) {
      await sql`UPDATE company_settings SET gdrive_root_folder_id = ${ROOT}, gdrive_vychozi_slozka = '', gdrive_posledni_chyba = '' WHERE id = ${firma.id}`;
    } else {
      await sql`INSERT INTO company_settings (name, gdrive_root_folder_id) VALUES ('Test', ${ROOT})`;
    }
  });

  afterEach(() => { globalThis.fetch = puvodniFetch; });

  test('první kontrola jen zapíše výchozí stav, další importuje jen nové', async () => {
    doklady = ['stary'];
    const prvni = await tikGdrive(null, { sql, now: NOW, extract, notify });
    assert.deepEqual(prvni, { vychozi: 1, naimportovano: 0, chyby: 0 });
    assert.equal((await stav('stary')).stav, 'vychozi');
    assert.equal(await faktura('stary'), undefined, 'starý doklad se nezaložil');

    doklady = ['stary', 'novy'];
    const druha = await tikGdrive(null, { sql, now: NOW, extract, notify });
    assert.equal(druha.naimportovano, 1);
    assert.equal(await faktura('stary'), undefined);
    const f = await faktura('novy');
    assert.equal(f.supplier, VYTEZENO.supplier);
    assert.equal(Number(f.total_amount), 121);
    assert.equal(f.status, 'Nezaplacena');
    assert.ok(f.attachment_path, 'PDF je přiložené');
    assert.equal((await stav('novy')).stav, 'naimportovano');
    assert.equal(oznameni.length, 1);

    const treti = await tikGdrive(null, { sql, now: NOW, extract, notify });
    assert.equal(treti.naimportovano, 0, 'opakovaná kontrola nic nezdvojí');
  });

  test('prázdná složka při první kontrole: pozdější doklad se naimportuje', async () => {
    await tikGdrive(null, { sql, now: NOW, extract, notify });
    doklady = ['prvni-novy'];
    assert.equal((await tikGdrive(null, { sql, now: NOW, extract, notify })).naimportovano, 1);
  });

  test('stejná faktura z POHODY se doplní, nová nevznikne', async () => {
    await sql`
      INSERT INTO accounting_invoices (id, type, number, supplier, supplier_ico, amount, vat_amount, total_amount, status, issue_date)
      VALUES ('inv_pohoda', 'received', 'POHODA-261100099', 'WEDOS', '28115708', 100, 21, 121, 'Zaplacena', '2026-11-01')
    `;
    await tikGdrive(null, { sql, now: NOW, extract, notify });
    doklady = ['z-disku'];
    assert.equal((await tikGdrive(null, { sql, now: NOW, extract, notify })).naimportovano, 1);

    const f = await faktura('z-disku');
    assert.equal(f.id, 'inv_pohoda');
    assert.equal(f.number, 'POHODA-261100099', 'číslo z POHODY zůstává');
    assert.equal(f.status, 'Zaplacena', 'stav se nepřepisuje');
    assert.ok(f.attachment_path, 'doplnila se příloha');
    const [{ n }] = await sql`SELECT count(*)::int n FROM accounting_invoices WHERE supplier_ico = '28115708'`;
    assert.equal(n, 1);
  });

  test('jiná částka u téhož dodavatele je jiná faktura', async () => {
    await sql`
      INSERT INTO accounting_invoices (id, type, number, supplier, supplier_ico, amount, vat_amount, total_amount, status, issue_date)
      VALUES ('inv_jina', 'received', 'POHODA-261100098', 'WEDOS', '28115708', 500, 105, 605, 'Zaplacena', '2026-11-01')
    `;
    const { vysledek } = await importujSoubor(sql, null, 'jina-castka', { extract });
    assert.equal(vysledek, 'imported');
  });

  test('stejné číslo od jiného dodavatele je další faktura', async () => {
    assert.equal((await importujSoubor(sql, null, 'dodavatel-1', { extract })).vysledek, 'imported');
    const jiny = async () => ({ ...VYTEZENO, supplier: 'Jiný s.r.o.', supplier_ico: '12345678', total_amount: 605 });
    assert.equal((await importujSoubor(sql, null, 'dodavatel-2', { extract: jiny })).vysledek, 'imported');
    const [{ n }] = await sql`SELECT count(*)::int n FROM accounting_invoices WHERE number = 'FA-77'`;
    assert.equal(n, 2);
  });

  test('faktura bez IČO a IČO v jiném zápisu se připojí k té z ručního zadání', async () => {
    await sql`
      INSERT INTO accounting_invoices (id, type, number, supplier, supplier_ico, amount, vat_amount, total_amount, status, issue_date)
      VALUES ('inv_rucne', 'received', 'FA-77', ' wedos INTERNET, a.s.', NULL, 100, 21, 121, 'Zaplacena', '2026-10-01')
    `;
    assert.equal((await importujSoubor(sql, null, 'bez-ico', { extract })).vysledek, 'merged');
    await sql`UPDATE accounting_invoices SET gdrive_file_id = NULL, supplier_ico = '281 157 08' WHERE id = 'inv_rucne'`;
    assert.equal((await importujSoubor(sql, null, 'ico-v-mezerach', { extract })).vysledek, 'merged');
  });

  test('druhý soubor téže faktury skončí chybou a další kontrola ho znovu nevytěžuje', async () => {
    await tikGdrive(null, { sql, now: NOW, extract, notify });
    doklady = ['kopie-1', 'kopie-2'];
    let vytezeni = 0;
    const pocitej = async () => { vytezeni++; return VYTEZENO; };

    const prvni = await tikGdrive(null, { sql, now: NOW, extract: pocitej, notify });
    assert.deepEqual([prvni.naimportovano, prvni.chyby], [1, 1]);
    assert.equal(vytezeni, 2);
    const s = await stav('kopie-2');
    assert.equal(s.stav, 'chyba');
    assert.equal(s.pokusy, 1);
    assert.match(s.chyba, /FA-77 už v systému je/);
    assert.ok(!/index|constraint|unique/i.test(s.chyba), 'bez technického textu');
    assert.equal(await faktura('kopie-2'), undefined);

    await tikGdrive(null, { sql, now: NOW, extract: pocitej, notify });
    assert.equal(vytezeni, 2, 'hned znovu se Claude nevolá');
  });

  test('dvě kopie téhož dokladu, jedna vytěžená bez IČO: druhá se nezaloží, v obou pořadích', async () => {
    const bezIco = async () => ({ ...VYTEZENO, supplier_ico: null });
    for (const [prvni, druha] of [[extract, bezIco], [bezIco, extract]]) {
      await uklid();
      assert.equal((await importujSoubor(sql, null, 'kopie-a', { extract: prvni })).vysledek, 'imported');
      await assert.rejects(importujSoubor(sql, null, 'kopie-b', { extract: druha }), /FA-77 už v systému je/);
      assert.equal((await stav('kopie-b')).stav, 'chyba');
      const [{ n }] = await sql`SELECT count(*)::int n FROM accounting_invoices WHERE number = 'FA-77'`;
      assert.equal(n, 1);
    }
  });

  test('dvě kopie s jinak vytěženým dodavatelem: stejné číslo, datum a částka se nezaloží', async () => {
    assert.equal((await importujSoubor(sql, null, 'jina-a', { extract: async () => ({ ...VYTEZENO, supplier_ico: null }) })).vysledek, 'imported');
    const jinakPsany = async () => ({ ...VYTEZENO, supplier: 'WEDOS Internet a.s.', supplier_ico: null });
    await assert.rejects(importujSoubor(sql, null, 'jina-b', { extract: jinakPsany }), /FA-77 už v systému je/);
    const [{ n }] = await sql`SELECT count(*)::int n FROM accounting_invoices WHERE number = 'FA-77'`;
    assert.equal(n, 1);
  });

  test('stejné číslo a název, ale jiné datum i částka: nepřipojí se a skončí chybou', async () => {
    for (const icoRadku of [null, '28115708']) {
      await uklid();
      await sql`
        INSERT INTO accounting_invoices (id, type, number, supplier, supplier_ico, amount, vat_amount, total_amount, status, issue_date)
        VALUES ('inv_stara', 'received', 'FA-77', ${VYTEZENO.supplier}, ${icoRadku}, 1000, 0, 1000, 'Zaplacena', '2025-01-10')
      `;
      const dalsi = async () => ({ ...VYTEZENO, supplier_ico: icoRadku ? null : '28115708', total_amount: 5000, issue_date: '2026-10-01' });
      await assert.rejects(importujSoubor(sql, null, 'jiny-doklad', { extract: dalsi }), /FA-77 už v systému je/);
      const [r] = await sql`SELECT total_amount, gdrive_file_id, attachment_path FROM accounting_invoices WHERE id = 'inv_stara'`;
      assert.equal(Number(r.total_amount), 1000);
      assert.equal(r.gdrive_file_id, null, 'cizí řádek zůstal bez vazby');
      assert.equal(r.attachment_path, null, 'a bez cizí přílohy');
      await sql`DELETE FROM accounting_invoices WHERE id = 'inv_stara'`;
    }
  });

  test('stejné IČO a číslo, ale jiné datum i částka: nepřipojí se k cizímu řádku', async () => {
    await sql`
      INSERT INTO accounting_invoices (id, type, number, supplier, supplier_ico, amount, vat_amount, total_amount, status, issue_date)
      VALUES ('inv_lonska', 'received', 'FA-77', 'WEDOS', '28115708', 1000, 0, 1000, 'Zaplacena', '2025-01-10')
    `;
    const letos = async () => ({ ...VYTEZENO, total_amount: 5000, issue_date: '2026-10-01' });
    await assert.rejects(importujSoubor(sql, null, 'letos', { extract: letos }), /FA-77 už v systému je/);
    const [r] = await sql`SELECT total_amount, gdrive_file_id, attachment_path FROM accounting_invoices WHERE id = 'inv_lonska'`;
    assert.deepEqual([Number(r.total_amount), r.gdrive_file_id, r.attachment_path], [1000, null, null]);
    await sql`DELETE FROM accounting_invoices WHERE id = 'inv_lonska'`;
  });

  test('kopie s jinak zapsaným číslem nebo bez čísla se nezdvojí', async () => {
    assert.equal((await importujSoubor(sql, null, 'zapis-a', { extract })).vysledek, 'imported');
    const jinakCislo = async () => ({ ...VYTEZENO, number: 'fa 77' });
    await assert.rejects(importujSoubor(sql, null, 'zapis-b', { extract: jinakCislo }), /už v systému je/);
    const bezCisla = async () => ({ ...VYTEZENO, number: null });
    await assert.rejects(importujSoubor(sql, null, 'zapis-c', { extract: bezCisla }), /už v systému je/);
    const [{ n }] = await sql`SELECT count(*)::int n FROM accounting_invoices WHERE supplier_ico = '28115708'`;
    assert.equal(n, 1);
  });

  test('doklad bez čísla: součet bez celkové částky se zaokrouhlí a kopii pozná', async () => {
    const bezCisla = async () => ({ ...VYTEZENO, number: null, amount: 10.1, vat_amount: 2.12, total_amount: null });
    assert.equal((await importujSoubor(sql, null, 'soucet-a', { extract: bezCisla })).vysledek, 'imported');
    assert.equal(Number((await faktura('soucet-a')).total_amount), 12.22);
    await assert.rejects(importujSoubor(sql, null, 'soucet-b', { extract: bezCisla }), /už v systému je/);
  });

  test('doklad bez čísla od jiného IČO se stejným názvem, datem a částkou je další faktura', async () => {
    const jineCislo = async () => ({ ...VYTEZENO, number: 'FA-90' });
    assert.equal((await importujSoubor(sql, null, 'nazev-a', { extract: jineCislo })).vysledek, 'imported');
    const jineIco = async () => ({ ...VYTEZENO, number: null, supplier_ico: '12345678' });
    assert.equal((await importujSoubor(sql, null, 'nazev-b', { extract: jineIco })).vysledek, 'imported');
  });

  test('různá čísla téhož dodavatele se stejným datem a částkou jsou dvě faktury', async () => {
    const druha = async () => ({ ...VYTEZENO, number: 'FA-78' });
    assert.equal((await importujSoubor(sql, null, 'cislo-77', { extract })).vysledek, 'imported');
    assert.equal((await importujSoubor(sql, null, 'cislo-78', { extract: druha })).vysledek, 'imported');
  });

  test('datum v jiném tvaru se neuloží posunuté, doklad skončí chybou', async () => {
    const ceskeDatum = async () => ({ ...VYTEZENO, issue_date: '1. 10. 2026' });
    await assert.rejects(importujSoubor(sql, null, 'datum-cesky', { extract: ceskeDatum }), /datum vystavení/);
    assert.equal(await faktura('datum-cesky'), undefined);
    const neexistujici = async () => ({ ...VYTEZENO, issue_date: '2026-02-30' });
    await assert.rejects(importujSoubor(sql, null, 'datum-30-2', { extract: neexistujici }), /datum vystavení/);
    const spatnaSplatnost = async () => ({ ...VYTEZENO, due_date: '30. 2.' });
    assert.equal((await importujSoubor(sql, null, 'splatnost', { extract: spatnaSplatnost })).vysledek, 'imported');
    assert.equal((await faktura('splatnost')).due_date, null, 'nepoužitelná splatnost se nevymýšlí');
  });

  test('IČO s předponou CZ je týž dodavatel: připojí se k faktuře z POHODY a nezdvojí se', async () => {
    await sql`
      INSERT INTO accounting_invoices (id, type, number, supplier, supplier_ico, amount, vat_amount, total_amount, status, issue_date)
      VALUES ('inv_pohoda_cz', 'received', 'POHODA-261100097', 'WEDOS', '28115708', 100, 21, 121, 'Zaplacena', '2026-11-01')
    `;
    const sDic = async () => ({ ...VYTEZENO, supplier_ico: 'cz 28115708' });
    assert.equal((await importujSoubor(sql, null, 'dic-a', { extract: sDic })).vysledek, 'merged');
    const [{ n }] = await sql`SELECT count(*)::int n FROM accounting_invoices WHERE supplier_ico = '28115708'`;
    assert.equal(n, 1);
  });

  test('založená faktura má zdroj Disk a interní číslo, připojená si nechá svůj zdroj', async () => {
    doklady = ['zdroj-novy'];
    await sql`INSERT INTO gdrive_soubory (file_id, nazev, slozka, stav) VALUES ('zdroj-novy', 'n.pdf', '', 'cekajici')`;
    await importujSoubor(sql, null, 'zdroj-novy', { extract });
    const nova = await faktura('zdroj-novy');
    assert.equal(nova.source, 'gdrive');
    assert.match(nova.internal_number, /^PF\d{2}-\d{4,}$/);

    const POHODA = { ...VYTEZENO, number: 'FA-ZDROJ-2' };
    await sql`
      INSERT INTO accounting_invoices (id, type, number, supplier_number, supplier, supplier_ico, amount, vat_amount, total_amount, currency, status, issue_date, source, pohoda_v_evidenci)
      VALUES ('zdroj-pohoda', 'received', 'POHODA-261100900', 'FA-ZDROJ-2', 'Jiný s.r.o.', '11223344', 10, 0, 777, 'CZK', 'Zaplacena', ${POHODA.issue_date}, 'pohoda', TRUE)
    `;
    await importujSoubor(sql, null, 'zdroj-pripojeny', {
      extract: async () => ({ ...POHODA, supplier: 'Jiný s.r.o.', supplier_ico: '11223344', total_amount: 777 }),
    });
    const [pripojena] = await sql`SELECT source, gdrive_file_id, pohoda_v_evidenci FROM accounting_invoices WHERE id = 'zdroj-pohoda'`;
    assert.deepEqual([pripojena.source, pripojena.gdrive_file_id, pripojena.pohoda_v_evidenci], ['pohoda', 'zdroj-pripojeny', true]);
  });

  test('souběh na stejném souboru se tiše přeskočí', async () => {
    const soubeh = async () => {
      // Mezitím soubor naimportoval druhý běh: INSERT narazí na index gdrive_file_id.
      await sql`
        INSERT INTO accounting_invoices (id, type, number, supplier, gdrive_file_id, amount, vat_amount, total_amount, status, issue_date)
        VALUES ('inv_soubeh', 'received', 'FA-soubeh', 'Soubeh', 'soubeh', 1, 0, 1, 'Nezaplacena', '2026-09-09')
      `;
      return VYTEZENO;
    };
    const { vysledek } = await importujSoubor(sql, null, 'soubeh', { extract: soubeh });
    assert.equal(vysledek, 'skipped');
    assert.equal(await stav('soubeh'), undefined, 'žádná chyba se nezapsala');
  });

  test('nevytěžený doklad nezaloží fakturu a po stropu pokusů se vzdá', async () => {
    await tikGdrive(null, { sql, now: NOW, extract, notify });
    doklady = ['necitelny'];
    const prazdne = async () => ({});

    const prvni = await tikGdrive(null, { sql, now: NOW, extract: prazdne, notify });
    assert.equal(prvni.chyby, 1);
    assert.equal(await faktura('necitelny'), undefined);
    const s = await stav('necitelny');
    assert.equal(s.stav, 'chyba');
    assert.match(s.chyba, /dodavatele a částku/);

    // Hned znovu se nezkouší, až po pauze.
    const hned = await tikGdrive(null, { sql, now: NOW, extract: prazdne, notify });
    assert.equal(hned.chyby, 0);

    await sql`UPDATE gdrive_soubory SET pokusy = ${MAX_POKUSU - 1}, posledni_pokus = ${new Date(NOW.getTime() - 2 * 3600_000)} WHERE file_id = 'necitelny'`;
    const posledni = await tikGdrive(null, { sql, now: NOW, extract: prazdne, notify });
    assert.equal(posledni.chyby, 1);
    assert.equal(oznameni.at(-1).title, 'Doklad z Google Disku se nepodařilo načíst');

    await sql`UPDATE gdrive_soubory SET posledni_pokus = ${new Date(NOW.getTime() - 2 * 3600_000)} WHERE file_id = 'necitelny'`;
    const poStropu = await tikGdrive(null, { sql, now: NOW, extract: prazdne, notify });
    assert.equal(poStropu.chyby, 0, 'po stropu se už nezkouší');
  });

  test('chyba Disku se zapíše a výchozí stav se nezaloží', async () => {
    globalThis.fetch = async (url) => {
      if (new URL(url).host === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      return new Response('{}', { status: 403 });
    };
    assert.equal(await tikGdrive(null, { sql, now: NOW, extract, notify }), null);
    const [firma] = await sql`SELECT gdrive_vychozi_slozka, gdrive_posledni_chyba FROM company_settings LIMIT 1`;
    assert.equal(firma.gdrive_vychozi_slozka, '');
    assert.match(firma.gdrive_posledni_chyba, /403/);
  });

  describe('párování starých dokladů podle čísla dodavatele', () => {
    const pohoda = (id, prepis = {}) => sql`INSERT INTO accounting_invoices ${sql({
      id, type: 'received', number: `POHODA-${id}`, supplier: 'Anthropic, PBC @anthropic548 Market Street', supplier_ico: '',
      amount: 309.55, vat_amount: 0, total_amount: 309.55, status: 'Zaplacena', issue_date: '2026-10-07', supplier_number: 'IM69EW9T-0014', ...prepis,
    })}`;
    const stary = (id, stav = 'vychozi') => sql`INSERT INTO gdrive_soubory (file_id, nazev, slozka, stav) VALUES (${id}, 'stary.pdf', '2026', ${stav})`;
    const usd = async () => ({ number: 'IM69EW9T-0014', supplier: 'Anthropic, PBC', supplier_ico: null, amount: 14.3, vat_amount: 0, total_amount: 14.3, currency: 'USD', issue_date: '2026-10-01' });
    const pocet = async () => (await sql`SELECT count(*)::int n FROM accounting_invoices WHERE type = 'received' AND (number LIKE 'POHODA-%' OR number LIKE 'IM69%' OR number LIKE 'FA-%')`)[0].n;

    test('zahraniční doklad bez IČO, v USD a s jiným datem se připojí k faktuře z POHODY', async () => {
      await pohoda('inv_usd');
      await stary('usd-1');
      const { vysledek, invoiceId } = await importujSoubor(sql, null, 'usd-1', { extract: usd });
      assert.equal(vysledek, 'merged');
      assert.equal(invoiceId, 'inv_usd');
      const [r] = await sql`SELECT number, total_amount, gdrive_file_id, attachment_path FROM accounting_invoices WHERE id = 'inv_usd'`;
      assert.equal(r.number, 'POHODA-inv_usd', 'interní číslo zůstává');
      assert.equal(Number(r.total_amount), 309.55, 'korunová částka zůstává');
      assert.equal(r.gdrive_file_id, 'usd-1');
      assert.ok(r.attachment_path, 'PDF je připojené');
      assert.equal(await pocet(), 1);
      assert.equal((await stav('usd-1')).stav, 'naimportovano');
    });

    test('číslo se porovnává bez pomlček a velikosti písmen', async () => {
      await pohoda('inv_tvar', { supplier_number: 'im69ew9t 0014' });
      await stary('tvar-1');
      assert.equal((await importujSoubor(sql, null, 'tvar-1', { extract: usd })).vysledek, 'merged');
    });

    test('starý doklad bez faktury nic nezaloží: Nespárováno a automatika ho nezkouší', async () => {
      await stary('nic-1');
      let vytezeni = 0;
      const pocitej = async () => { vytezeni++; return usd(); };
      assert.equal((await importujSoubor(sql, null, 'nic-1', { extract: pocitej })).vysledek, 'nesparovano');
      assert.equal(await pocet(), 0);
      const zaznam = await stav('nic-1');
      assert.equal(zaznam.stav, 'nesparovano');
      assert.match(zaznam.chyba, /IM69EW9T-0014/);
      await sql`UPDATE company_settings SET gdrive_vychozi_slozka = ${ROOT}`;
      doklady = ['nic-1'];
      const vysledek = await tikGdrive(null, { sql, now: NOW, extract: pocitej, notify });
      assert.equal(vysledek.naimportovano, 0);
      assert.equal(vytezeni, 1, 'žádné další vytěžování');
      assert.equal((await stav('nic-1')).stav, 'nesparovano');
    });

    test('Založit jako novou založí fakturu i z nespárovaného dokladu', async () => {
      await stary('novy-1', 'nesparovano');
      assert.equal((await importujSoubor(sql, null, 'novy-1', { extract: usd, zalozitNovou: true })).vysledek, 'imported');
      assert.equal(await pocet(), 1);
    });

    test('selhání vytěžení nechá starý doklad starý, ze stavu chyba by ho automatika založila', async () => {
      await stary('pad-1');
      await assert.rejects(importujSoubor(sql, null, 'pad-1', { extract: async () => { throw new Error('API spadlo'); } }));
      const zaznam = await stav('pad-1');
      assert.equal(zaznam.stav, 'vychozi');
      assert.match(zaznam.chyba, /API spadlo/);
    });

    test('dvě různá IČO se stejným číslem jsou různí dodavatelé', async () => {
      await pohoda('inv_ico', { supplier_ico: '11111111' });
      await stary('ico-1');
      const jine = async () => ({ ...(await usd()), supplier_ico: '22222222' });
      assert.equal((await importujSoubor(sql, null, 'ico-1', { extract: jine })).vysledek, 'nesparovano');
    });

    test('stejné číslo na dvou řádcích (Twilio má v Dokladu číslo zákazníka): žádná shoda', async () => {
      await pohoda('inv_tw1', { supplier_number: '37348266' });
      await pohoda('inv_tw2', { supplier_number: '37348266' });
      await stary('tw-1');
      const twilio = async () => ({ ...(await usd()), number: '37348266' });
      assert.equal((await importujSoubor(sql, null, 'tw-1', { extract: twilio })).vysledek, 'nesparovano');
    });

    test('krátké číslo bez IČO samo nestačí, s datem nebo částkou ano', async () => {
      await pohoda('inv_kratke', { supplier_number: '2143' });
      await stary('kr-1');
      const kratke = async () => ({ ...(await usd()), number: '2143' });
      assert.equal((await importujSoubor(sql, null, 'kr-1', { extract: kratke })).vysledek, 'nesparovano');
      await stary('kr-2');
      const sDatem = async () => ({ ...(await usd()), number: '2143', issue_date: '2026-10-07' });
      assert.equal((await importujSoubor(sql, null, 'kr-2', { extract: sDatem })).vysledek, 'merged');
    });

    test('nový doklad (ne starý) se k faktuře z POHODY taky připojí a nezdvojí', async () => {
      await pohoda('inv_nova');
      assert.equal((await importujSoubor(sql, null, 'nova-1', { extract: usd })).vysledek, 'merged');
      assert.equal(await pocet(), 1);
    });
  });
});
