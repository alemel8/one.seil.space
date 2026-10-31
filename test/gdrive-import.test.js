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
    await sql`DELETE FROM gdrive_soubory`;
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
});
