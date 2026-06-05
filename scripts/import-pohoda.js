/**
 * Jednorázový import dat z POHODA Excel exportů.
 *
 * Spuštění:
 *   node --env-file=.env scripts/import-pohoda.js
 *   node --env-file=.env scripts/import-pohoda.js --with-ares   (aktualizuje firmy z ARESu)
 *   node --env-file=.env scripts/import-pohoda.js --dry-run      (jen loguje, nic neukládá)
 *
 * Fáze:
 *   1. Adresy.xlsx    → crm_companies + crm_contacts
 *   2. FA.xlsx        → accounting_invoices (type='issued')
 *   3. FA-prija.xlsx  → accounting_invoices (type='received')
 */

import XLSX from 'xlsx';
import postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const WITH_ARES = process.argv.includes('--with-ares');
const DRY_RUN   = process.argv.includes('--dry-run');

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true',
  max: 3,
});

// ── Helpers ───────────────────────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function str(v) {
  return String(v ?? '').trim();
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// POHODA exportuje data jako Excel sériová čísla (dny od 30.12.1899)
function excelDate(serial) {
  if (!serial || typeof serial !== 'number') return null;
  return new Date((serial - 25569) * 86400 * 1000).toISOString().slice(0, 10);
}

// IČO: Excel někdy odstraní leading nuly → zarovnat na 8 číslic
function formatIco(v) {
  if (!v) return '';
  const s = String(v).replace(/\s/g, '').trim();
  if (!s || s.length === 0) return '';
  if (/^\d+$/.test(s)) return s.padStart(8, '0');
  return s;
}

function formatZip(v) {
  if (!v) return '';
  return String(v).replace(/\s/g, '').trim();
}

// Jméno → first_name / last_name (první slovo = jméno, zbytek = příjmení)
function splitName(jmeno) {
  const parts = str(jmeno).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first_name: '', last_name: '' };
  if (parts.length === 1) return { first_name: '', last_name: parts[0] };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

// Odvození stavu faktury z POHODA polí
function invoiceStatus(row, today = new Date()) {
  if (row['Storno']) return 'Storno';
  const remaining = num(row['K likvidaci']);
  const total     = num(row['Celkem']);
  if (total > 0 && remaining === 0) return 'Zaplacena';
  const due = excelDate(row['Splatno']);
  if (due && new Date(due) < today && remaining > 0) return 'Po splatnosti';
  return 'Nezaplacena';
}

// ARES lookup — vrátí {name, dic, address, city, zip} nebo null
async function aresLookup(ico, delayMs = 200) {
  await new Promise(r => setTimeout(r, delayMs));
  try {
    const res = await fetch(
      `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${ico}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const d = await res.json();
    const s = d.sidlo || {};
    const streetParts = [s.nazevUlice, s.cisloDomovni, s.cisloOrientacni].filter(Boolean);
    return {
      name:    str(d.obchodniJmeno),
      dic:     str(d.dic),
      address: streetParts.join(' '),
      city:    str(s.nazevObce),
      zip:     str(s.psc),
    };
  } catch {
    return null;
  }
}

function readSheet(file) {
  const wb = XLSX.readFile(path.join(ROOT, 'import', file));
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
}

let stats = { companies: 0, companiesSkip: 0, contacts: 0, contactsSkip: 0,
              issued: 0, issuedSkip: 0, received: 0, receivedSkip: 0, aresOk: 0, aresErr: 0 };

// ── Fáze 1: Adresy ───────────────────────────────────────────

async function importAdresy() {
  console.log('\n━━━ Fáze 1: Adresy.xlsx → CRM ━━━');
  const rows = readSheet('Adresy.xlsx');
  console.log(`  Celkem řádků: ${rows.length}`);

  // Načti existující IČO a emaily pro dedup
  const existIco   = new Set((await sql`SELECT ico   FROM crm_companies WHERE ico   IS NOT NULL AND ico   <> ''`).map(r => r.ico));
  const existName  = new Set((await sql`SELECT LOWER(name) AS n FROM crm_companies`).map(r => r.n));
  const existEmail = new Set((await sql`SELECT LOWER(email) AS e FROM crm_contacts WHERE email IS NOT NULL AND email <> ''`).map(r => r.e));

  // Mapa ico → company id (pro propojení kontaktů)
  const icoToId = {};
  const existRows = await sql`SELECT id, ico FROM crm_companies WHERE ico IS NOT NULL AND ico <> ''`;
  for (const r of existRows) icoToId[r.ico] = r.id;

  for (const row of rows) {
    const firma  = str(row['Firma']);
    const jmeno  = str(row['Jméno']);
    const ico    = formatIco(row['IČ']);
    const dic    = str(row['DIČ']);
    const ulice  = str(row['Ulice']);
    const psc    = formatZip(row['PSČ']);
    const obec   = str(row['Obec']);
    const tel    = str(row['Telefon']) || str(row['Mobil']);
    const email  = str(row['E-mail']).toLowerCase();

    // ── Firma ─────────────────────────────────────────────
    if (firma) {
      const ico8 = ico;

      // Dedup
      if (ico8 && existIco.has(ico8)) {
        stats.companiesSkip++;
        // Ale pokud ico8 → id existuje, zapamatuj pro kontakty
        continue;
      }
      if (!ico8 && existName.has(firma.toLowerCase())) {
        stats.companiesSkip++;
        continue;
      }

      let compName = firma;
      let compDic  = dic;
      let compAddr = ulice;
      let compCity = obec;
      let compZip  = psc;

      // ARES enrichment pro firmy s IČO
      if (WITH_ARES && ico8) {
        process.stdout.write(`  ARES: ${ico8} (${firma}) … `);
        const a = await aresLookup(ico8);
        if (a) {
          if (a.name) compName = a.name;
          if (a.dic)  compDic  = a.dic;
          if (a.address) compAddr = a.address;
          if (a.city)    compCity = a.city;
          if (a.zip)     compZip  = a.zip;
          stats.aresOk++;
          console.log('✓');
        } else {
          stats.aresErr++;
          console.log('✗ nenalezeno');
        }
      }

      const newId = genId();
      if (!DRY_RUN) {
        await sql`
          INSERT INTO crm_companies (id, name, ico, dic, address, city, zip, phone, email, source, created_at, modified_at)
          VALUES (${newId}, ${compName}, ${ico8||''}, ${compDic||''}, ${compAddr||''}, ${compCity||''}, ${compZip||''}, ${tel||''}, ${email||''}, 'pohoda', NOW(), NOW())
          ON CONFLICT DO NOTHING
        `;
      }

      if (ico8) {
        existIco.add(ico8);
        icoToId[ico8] = newId;
      }
      existName.add(firma.toLowerCase());
      stats.companies++;
    }

    // ── Kontakt (osoba) ───────────────────────────────────
    if (jmeno) {
      const { first_name, last_name } = splitName(jmeno);
      const emailLow = email;

      // Dedup
      if (emailLow && existEmail.has(emailLow)) {
        stats.contactsSkip++;
        continue;
      }

      // Propojení s firmou
      const companyId = ico && icoToId[ico] ? icoToId[ico] : null;

      if (!DRY_RUN) {
        await sql`
          INSERT INTO crm_contacts
            (id, first_name, last_name, email, phone, address, city, zip, company_id, source, created_at, modified_at)
          VALUES
            (${genId()}, ${first_name}, ${last_name}, ${email||null}, ${tel||''},
             ${ulice||''}, ${obec||''}, ${psc||''}, ${companyId}, 'pohoda', NOW(), NOW())
          ON CONFLICT DO NOTHING
        `;
      }

      if (emailLow) existEmail.add(emailLow);
      stats.contacts++;
    }
  }

  console.log(`  ✓ Firmy:     +${stats.companies} vloženo, ${stats.companiesSkip} přeskočeno`);
  console.log(`  ✓ Kontakty:  +${stats.contacts} vloženo, ${stats.contactsSkip} přeskočeno`);
  if (WITH_ARES) console.log(`  ✓ ARES:      ${stats.aresOk} ok, ${stats.aresErr} chyb`);
}

// ── Fáze 2: Vydané faktury ────────────────────────────────────

async function importIssued() {
  console.log('\n━━━ Fáze 2: FA.xlsx → Vydané faktury ━━━');
  const rows = readSheet('FA.xlsx');
  console.log(`  Celkem řádků: ${rows.length}`);

  // Existující čísla faktur (dedup)
  const existNums = new Set(
    (await sql`SELECT number FROM accounting_invoices WHERE type='issued'`).map(r => r.number)
  );

  // Mapa ico → company id
  const icoToId = {};
  for (const r of await sql`SELECT id, ico FROM crm_companies WHERE ico IS NOT NULL`) {
    icoToId[r.ico] = r.id;
  }

  const today = new Date();

  for (const row of rows) {
    const number = str(row['Číslo']);
    if (!number) continue;
    if (existNums.has(number)) { stats.issuedSkip++; continue; }

    const ico        = formatIco(row['IČ']);
    const status     = invoiceStatus(row, today);
    const issueDate  = excelDate(row['Datum']);
    const dueDate    = excelDate(row['Splatno']);
    const paidDate   = status === 'Zaplacena' ? (excelDate(row['Splatno']) || issueDate) : null;
    const clientName = str(row['Firma']) || str(row['Jméno']);
    const clientDic  = str(row['DIČ']);
    const ulice      = str(row['Ulice']);
    const psc        = formatZip(row['PSČ']);
    const obec       = str(row['Obec']);
    const clientAddr = [ulice, psc && obec ? `${psc} ${obec}` : obec].filter(Boolean).join(', ');
    const companyId  = ico ? icoToId[ico] || null : null;
    const amount     = num(row['Kč základní']);
    const vatAmount  = num(row['DPH základní']);
    const total      = num(row['Celkem']);
    const notes      = str(row['Text']);

    if (!DRY_RUN) {
      await sql`
        INSERT INTO accounting_invoices
          (id, type, number, status, client_name, client_ico, client_dic, client_address,
           crm_company_id, issue_date, due_date, paid_date,
           amount, vat_amount, total_amount, currency, notes, created_at, modified_at)
        VALUES (
          ${genId()}, 'issued', ${number}, ${status},
          ${clientName}, ${ico||''}, ${clientDic||''}, ${clientAddr||''},
          ${companyId}, ${issueDate}, ${dueDate}, ${paidDate},
          ${amount}, ${vatAmount}, ${total}, 'CZK', ${notes||''}, NOW(), NOW()
        )
        ON CONFLICT DO NOTHING
      `;
    } else {
      console.log(`  [dry] ${number} | ${clientName} | ${status} | ${total} CZK`);
    }

    existNums.add(number);
    stats.issued++;
  }

  console.log(`  ✓ Vydané faktury: +${stats.issued} vloženo, ${stats.issuedSkip} přeskočeno`);
}

// ── Fáze 3: Přijaté faktury ───────────────────────────────────

async function importReceived() {
  console.log('\n━━━ Fáze 3: FA-prija.xlsx → Přijaté faktury ━━━');
  const rows = readSheet('FA-prija.xlsx');
  console.log(`  Celkem řádků: ${rows.length}`);

  const existNums = new Set(
    (await sql`SELECT number FROM accounting_invoices WHERE type='received'`).map(r => r.number)
  );

  const icoToId = {};
  for (const r of await sql`SELECT id, ico FROM crm_companies WHERE ico IS NOT NULL`) {
    icoToId[r.ico] = r.id;
  }

  const today = new Date();

  for (const row of rows) {
    const number = str(row['Číslo']);
    if (!number) continue;
    if (existNums.has(number)) { stats.receivedSkip++; continue; }

    const ico        = formatIco(row['IČ']);
    const status     = invoiceStatus(row, today);
    const issueDate  = excelDate(row['Datum']);
    const dueDate    = excelDate(row['Splatno']);
    const paidDate   = status === 'Zaplacena' ? (excelDate(row['Splatno']) || issueDate) : null;
    const supplier   = str(row['Firma']) || str(row['Jméno']);
    const supDic     = str(row['DIČ']);
    const ulice      = str(row['Ulice']);
    const psc        = formatZip(row['PSČ']);
    const obec       = str(row['Obec']);
    const companyId  = ico ? icoToId[ico] || null : null;
    const amount     = num(row['Kč základní']);
    const vatAmount  = num(row['DPH základní']);
    const total      = num(row['Celkem']);
    const notes      = str(row['Text']);

    if (!DRY_RUN) {
      await sql`
        INSERT INTO accounting_invoices
          (id, type, number, status, supplier, supplier_ico, supplier_dic,
           supplier_address, supplier_city, supplier_zip, supplier_country,
           crm_company_id, issue_date, due_date, paid_date,
           amount, vat_amount, total_amount, currency, notes, created_at, modified_at)
        VALUES (
          ${genId()}, 'received', ${number}, ${status},
          ${supplier||''}, ${ico||''}, ${supDic||''},
          ${ulice||''}, ${obec||''}, ${psc||''}, 'Česká republika',
          ${companyId}, ${issueDate}, ${dueDate}, ${paidDate},
          ${amount}, ${vatAmount}, ${total}, 'CZK', ${notes||''}, NOW(), NOW()
        )
        ON CONFLICT DO NOTHING
      `;
    } else {
      console.log(`  [dry] ${number} | ${supplier} | ${status} | ${total} CZK`);
    }

    existNums.add(number);
    stats.received++;
  }

  console.log(`  ✓ Přijaté faktury: +${stats.received} vloženo, ${stats.receivedSkip} přeskočeno`);
}

// ── Hlavní ───────────────────────────────────────────────────

console.log('=== Import POHODA → one.seil.space ===');
if (DRY_RUN)   console.log('⚠  DRY RUN — nic se neukládá');
if (WITH_ARES) console.log('★  ARES enrichment zapnut');

try {
  await importAdresy();
  await importIssued();
  await importReceived();

  console.log('\n=== Hotovo ===');
  console.log(`Firmy:            +${stats.companies} (přeskočeno: ${stats.companiesSkip})`);
  console.log(`Kontakty:         +${stats.contacts} (přeskočeno: ${stats.contactsSkip})`);
  console.log(`Vydané faktury:   +${stats.issued} (přeskočeno: ${stats.issuedSkip})`);
  console.log(`Přijaté faktury:  +${stats.received} (přeskočeno: ${stats.receivedSkip})`);
} catch (err) {
  console.error('\n❌ Chyba:', err.message);
  process.exit(1);
} finally {
  await sql.end();
}
