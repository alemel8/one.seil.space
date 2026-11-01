// Kolo formuláře záznamu v opravdovém prohlížeči: řádek s jinou hodnotou v každém sloupci, otevřít ?upravit=1, kliknout
// Uložit bez změny a porovnat řádek v databázi. Routy přepisují celý řádek, takže špatně navázaná nebo prázdná hodnota
// by potichu smazala data. Tenhle test hlídá vazbu pole na sloupec na všech převedených stránkách.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/rezim-uprav-kolo.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import puppeteer from 'puppeteer';
import { BASE, PRESKOCIT, lokalniDatabaze, serverBezi, prihlas } from './pomocnici/server.js';

const IGNORUJ = new Set(['modified_at', 'updated_at', 'modified_by']);
// Prohlížeč posílá konce řádků textarea vždycky jako CRLF, to ztráta dat není.
const norm = (v) => (v instanceof Date ? v.toISOString()
  : typeof v === 'string' ? v.replace(/\r\n/g, '\n')
    : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

const FIRMA_SLOUPCE = ['name', 'ico', 'dic', 'address', 'city', 'zip', 'country', 'phone', 'email', 'bank_account', 'bank_name', 'iban', 'swift',
  'vat_payer', 'invoice_note', 'pohoda_cash_account', 'pohoda_predkontace', 'pohoda_predkontace_prijate', 'pohoda_predkontace_repre', 'gdrive_root_folder_id'];

describe('kolo: Uložit beze změny nechá řádek být', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(3).toString('hex');
  let sql, browser, page, session, nastaveni;
  const f = {};

  const radek = (tabulka, id) => async () => (await sql`SELECT * FROM ${sql(tabulka)} WHERE id = ${id}`)[0];

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [f.admin] = await sql`INSERT INTO users (email, password_hash, first_name, last_name, is_admin) VALUES (${`kolo-admin-${r}@example.invalid`}, 'x', 'Kolo', ${`Správce ${r}`}, TRUE) RETURNING id`;
    session = await prihlas(sql, f.admin.id);
    [f.clen] = await sql`INSERT INTO users (email, password_hash, first_name, last_name, title, phone, position, bio, address, city, zip, country, bank_account, bank_name, iban, is_admin, is_active)
      VALUES (${`kolo-clen-${r}@example.invalid`}, 'x', 'Jmeno', 'Prijmeni', 'Ing.', '+420 777 000 111', 'Pozice', ${'Bio 1\nBio 2'}, 'Ulice 1', 'Mesto', '602 00', 'Slovensko', '111/0100', 'Banka', 'CZ65', FALSE, TRUE) RETURNING id, public_id`;
    [f.clen2] = await sql`INSERT INTO users (email, password_hash, first_name, last_name, country, is_admin, is_active)
      VALUES (${`kolo-clen2-${r}@example.invalid`}, 'x', 'Spravce', 'Neaktivni', '', TRUE, FALSE) RETURNING id, public_id`;
    [f.shop] = await sql`INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address, email_reply_to, support_email, support_phone, support_phone_link, tagline, claim, logo_mark_url, logo_wordmark_url, color_primary, color_primary_dark, color_primary_light, color_on_primary_soft, warehouse_email, warehouse_email_bcc, warehouse_dispatch_since, marketing_margin_pct, marketing_pno_alert_pct)
      VALUES (${`kolo-${r}`}, ${`Kolo ${r}`}, 'https://kolo.example.invalid', TRUE, 'Od', 'od@kolo.example.invalid', 'rep@kolo.example.invalid', 'sup@kolo.example.invalid', '+420 1', 'tel:1', 'Tag', 'Claim', 'https://kolo.example.invalid/m.png', 'https://kolo.example.invalid/w.png', '#111111', '#222222', '#333333', '#444444', 'sklad@kolo.example.invalid', 'kopie@kolo.example.invalid', '2026-03-05', 33.33, 12.5) RETURNING id`;
    [f.shop2] = await sql`INSERT INTO shops (slug, name, url, active, email_from_name, email_from_address) VALUES (${`kolo2-${r}`}, ${`Kolo2 ${r}`}, 'https://kolo2.example.invalid', FALSE, 'Od', 'od2@kolo.example.invalid') RETURNING id`;
    f.firma = `kolof${r}`; f.firma2 = `kolog${r}`; f.kontakt = `kolok${r}`; f.projekt = `kolop${r}`; f.item = `koloi${r}`; f.fak = `kolofak${r}`; f.fak2 = `kolofag${r}`;
    await sql`INSERT INTO crm_companies (id, name, company_type, ico, dic, country, city, zip, address, email, phone, website, notes, legal_form, founded_date, registration_info, company_status)
      VALUES (${f.firma}, ${`Firma ${r}`}, 'Jiný druh', '11111111', 'CZ11111111', 'Polsko', 'Mesto', '1', 'Adresa', 'a@kolo.example.invalid', '+420 2', 'https://w.example.invalid', ${'Pozn 1\nPozn 2'}, 'a.s.', '2020-01-15', 'C 1', 'Zaniklá')`;
    await sql`INSERT INTO crm_companies (id, name, company_type, country) VALUES (${f.firma2}, ${`Firma2 ${r}`}, 'Zákazník', '')`;
    await sql`INSERT INTO crm_contacts (id, first_name, last_name, company_id) VALUES (${f.kontakt}, 'Cizi', 'Kontakt', ${f.firma2})`;
    await sql`INSERT INTO projects (id, company_id, name, status, primary_contact_id, start_date, brand_primary_color, brand_secondary_color, brand_fonts, brand_assets_url, brand_notes, billing_payment_terms_days, billing_currency, billing_hourly_rate, billing_notes, notes)
      VALUES (${f.projekt}, ${f.firma}, ${`Projekt ${r}`}, 'Legacy', ${f.kontakt}, '2026-01-10', '#14E6E6', 'modra', 'Inter', 'https://b.example.invalid', 'BN', 0, 'GBP', 1500.55, 'FN', 'PN')`;
    [f.hc] = await sql`INSERT INTO healthchecks (name, url) VALUES (${`hc ${r}`}, 'https://h.example.invalid') RETURNING id`;
    await sql`INSERT INTO project_items (id, project_id, type, name, status, description, hosting_provider, production_url, staging_url, repo_url, tech_stack, shop_id, healthcheck_id, go_live_date, notes)
      VALUES (${f.item}, ${f.projekt}, 'web', ${`Item ${r}`}, 'Legacy', 'D', 'H', 'https://p.example.invalid', 'https://s.example.invalid', 'https://r.example.invalid', 'T', ${f.shop.id}, ${f.hc.id}, '2026-02-02', 'N')`;
    [f.uct] = await sql`INSERT INTO receipts (number, vendor, vendor_ico, amount, vat_amount, total_amount, currency, receipt_date, category, status, payment_method, vat_deductible, notes, account_debit, account_credit)
      VALUES ('U-1', ${`Prodejce ${r}`}, '22222222', 100.10, 21.02, 121.99, 'GBP', '2026-02-02', 'Stará kategorie', 'Zaúčtována', 'Karta', FALSE, 'N', '518', '211') RETURNING id`;
    [f.uct2] = await sql`INSERT INTO receipts (vendor, amount, vat_amount, total_amount, currency, receipt_date, category, status, payment_method)
      VALUES (${`Prodejce2 ${r}`}, 0, 0, 0, 'CZK', '2026-02-02', 'Reprezentace', 'Nezaúčtována', 'Šek') RETURNING id`;
    await sql`INSERT INTO accounting_invoices (id, type, number, supplier, supplier_ico, supplier_dic, supplier_address, supplier_city, supplier_zip, supplier_country, amount, vat_amount, total_amount, currency, issue_date, due_date, paid_date, status, notes, account_debit, account_credit, vat_deductible)
      VALUES (${f.fak}, 'received', ${`PF-${r}`}, ${`Dod ${r}`}, '33333333', 'CZ33', 'A', 'B', 'C', 'Rakousko', 1000.55, 210.11, 1210.99, 'GBP', '2026-02-02', '2026-02-16', '2026-02-20', 'Zaplacena', 'N', '518', '321', FALSE)`;
    await sql`INSERT INTO accounting_invoices (id, type, number, supplier, amount, vat_amount, total_amount, currency, issue_date, status, supplier_country)
      VALUES (${f.fak2}, 'received', ${`PG-${r}`}, ${`Dod2 ${r}`}, 0, 0, 0, 'CZK', '2026-02-02', 'Nezaplacena', '')`;
    [nastaveni] = await sql`SELECT * FROM company_settings ORDER BY id LIMIT 1`;
    if (!nastaveni) [f.novaNastaveni] = await sql`INSERT INTO company_settings (name) VALUES ('kolo') RETURNING id`;
    f.nastaveniId = nastaveni?.id ?? f.novaNastaveni.id;

    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setCookie({ name: 'sessionId', value: session.cookie.slice('sessionId='.length), domain: new URL(BASE).hostname, path: '/' });
    page.on('dialog', d => d.accept());
  });

  after(async () => {
    await browser?.close();
    if (!sql) return;
    if (nastaveni) await sql`UPDATE company_settings SET ${sql(nastaveni, ...FIRMA_SLOUPCE, 'updated_at')} WHERE id = ${nastaveni.id}`;
    else if (f.novaNastaveni) await sql`DELETE FROM company_settings WHERE id = ${f.novaNastaveni.id}`;
    await sql`DELETE FROM session WHERE sid = ${session?.sid ?? ''}`;
    await sql`DELETE FROM accounting_invoices WHERE id = ANY(${[f.fak ?? '', f.fak2 ?? '']})`;
    await sql`DELETE FROM receipts WHERE id = ANY(${[f.uct?.id ?? 0, f.uct2?.id ?? 0]})`;
    await sql`DELETE FROM project_items WHERE id = ${f.item ?? ''}`;
    await sql`DELETE FROM projects WHERE id = ${f.projekt ?? ''}`;
    await sql`DELETE FROM healthchecks WHERE id = ${f.hc?.id ?? 0}`;
    await sql`DELETE FROM crm_contacts WHERE id = ${f.kontakt ?? ''}`;
    await sql`DELETE FROM crm_companies WHERE id = ANY(${[f.firma ?? '', f.firma2 ?? '']})`;
    await sql`DELETE FROM shops WHERE id = ANY(${[f.shop?.id ?? 0, f.shop2?.id ?? 0]})`;
    await sql`DELETE FROM users WHERE id = ANY(${[f.admin?.id ?? 0, f.clen?.id ?? 0, f.clen2?.id ?? 0]})`;
    await sql.end();
  });

  /** Otevře úpravy, klikne Uložit bez změny a porovná řádek; `ocekavane` = sloupce, které se změnit smějí (záměrné výchozí hodnoty). */
  async function kolo(url, nacti, { ocekavane = {}, tlacitko = '.page-header-akce .upravit-ulozit', pripravit } = {}) {
    if (pripravit) await pripravit();
    const pred = await nacti();
    await page.goto(BASE + url, { waitUntil: 'networkidle0' });
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 5000 }), page.click(tlacitko)]);
    assert.ok(page.url().includes('saved=1'), `uložení se povedlo, ${page.url()}`);
    const po = await nacti();
    const rozdily = {};
    for (const k of Object.keys(pred)) if (!IGNORUJ.has(k) && norm(pred[k]) !== norm(po[k])) rozdily[k] = norm(po[k]);
    assert.deepEqual(rozdily, ocekavane);
  }

  test('člen, detail', () => kolo(`/lide/tym/${f.clen.public_id}?tab=detail&upravit=1`, radek('users', f.clen.id)));
  test('člen, banka', () => kolo(`/lide/tym/${f.clen.public_id}?tab=banka&upravit=1`, radek('users', f.clen.id)));
  test('člen správce a neaktivní, detail: prázdný stát dostane výchozí', () => kolo(`/lide/tym/${f.clen2.public_id}?tab=detail&upravit=1`, radek('users', f.clen2.id), { ocekavane: { country: 'Česká republika' } }));
  test('člen správce a neaktivní, banka', () => kolo(`/lide/tym/${f.clen2.public_id}?tab=banka&upravit=1`, radek('users', f.clen2.id)));
  for (const tab of ['zakladni', 'identita', 'expedice', 'marketing']) {
    test(`e-shop, ${tab}`, () => kolo(`/nastaveni/eshopy/${f.shop.id}?tab=${tab}&upravit=1`, radek('shops', f.shop.id)));
  }
  test('e-shop vypnutý, zakladni', () => kolo(`/nastaveni/eshopy/${f.shop2.id}?tab=zakladni&upravit=1`, radek('shops', f.shop2.id)));
  test('firma, základní informace', () => kolo(`/crm/firmy/${f.firma}?tab=zakladni&upravit=1`, radek('crm_companies', f.firma)));
  test('firma, poznámky', () => kolo(`/crm/firmy/${f.firma}?tab=poznamky&upravit=1`, radek('crm_companies', f.firma)));
  test('firma s prázdným státem', () => kolo(`/crm/firmy/${f.firma2}?tab=zakladni&upravit=1`, radek('crm_companies', f.firma2), { ocekavane: { country: 'Česká republika' } }));
  test('projekt', () => kolo(`/projekty/${f.projekt}?tab=prehled&upravit=1`, radek('projects', f.projekt)));
  test('podprojekt', () => kolo(`/projekty/podprojekty/${f.item}?upravit=1`, radek('project_items', f.item)));
  test('účtenka', () => kolo(`/ucetnictvi/uctenky/${f.uct.id}?upravit=1`, radek('receipts', f.uct.id)));
  test('účtenka, Reprezentace a forma mimo nabídku: route přepíše formu i odpočet', () => kolo(`/ucetnictvi/uctenky/${f.uct2.id}?upravit=1`, radek('receipts', f.uct2.id), { ocekavane: { payment_method: 'Hotovost', vat_deductible: false } }));
  test('přijatá faktura', () => kolo(`/ucetnictvi/prijate-faktury/${f.fak}?upravit=1`, radek('accounting_invoices', f.fak)));
  test('přijatá faktura s prázdným státem', () => kolo(`/ucetnictvi/prijate-faktury/${f.fak2}?upravit=1`, radek('accounting_invoices', f.fak2), { ocekavane: { supplier_country: 'Česká republika' } }));
  test('Můj profil', () => kolo('/profil?upravit=1', radek('users', f.admin.id), { tlacitko: '.card-header-akce .upravit-ulozit' }));
  // Nastavení firmy po záložkách: každá má vlastní POST, výchozí hodnoty se zapíšou jen na své záložce.
  const firmaPlna = () => sql`UPDATE company_settings SET ${sql({ name: `Fi ${r}`, ico: '01', dic: 'CZ02', address: 'A3', city: 'C4', zip: 'Z5', country: 'Polsko', phone: '+6', email: 'e7@example.invalid', bank_account: 'B8', bank_name: 'N9', iban: 'I10', swift: 'S11', vat_payer: true, invoice_note: 'P12\nP13', pohoda_cash_account: 'K14', pohoda_predkontace: 'Q15', pohoda_predkontace_prijate: 'Q16', pohoda_predkontace_repre: 'Q17', gdrive_root_folder_id: 'G18' }, ...FIRMA_SLOUPCE)} WHERE id = ${f.nastaveniId}`;
  const firmaPrazdna = () => sql`UPDATE company_settings SET ${sql({ name: `Fi2 ${r}`, ico: '', dic: '', address: '', city: '', zip: '', country: '', phone: '', email: '', bank_account: '', bank_name: '', iban: '', swift: '', vat_payer: false, invoice_note: '', pohoda_cash_account: '', pohoda_predkontace: '', pohoda_predkontace_prijate: '', pohoda_predkontace_repre: '', gdrive_root_folder_id: '' }, ...FIRMA_SLOUPCE)} WHERE id = ${f.nastaveniId}`;
  for (const tab of ['zakladni', 'fakturace', 'pohoda', 'disk']) {
    test(`Nastavení firmy, ${tab}: plátce a všechny sloupce vyplněné`, () => kolo(`/nastaveni/firma?tab=${tab}&upravit=1`, radek('company_settings', f.nastaveniId), { pripravit: firmaPlna }));
    const ocekavane = tab === 'zakladni' ? { country: 'Česká republika' } : tab === 'pohoda' ? { pohoda_cash_account: 'Pokladna' } : {};
    test(`Nastavení firmy, ${tab}: neplátce, prázdný stát a pokladna dostanou výchozí jen na své záložce`, () => kolo(`/nastaveni/firma?tab=${tab}&upravit=1`, radek('company_settings', f.nastaveniId), { pripravit: firmaPrazdna, ocekavane }));
  }
});
