#!/usr/bin/env node
/**
 * Migrace objednávek z Airtable do SQLite.
 *
 * Spuštění:
 *   node scripts/migrate-airtable-orders.js
 *
 * Potřebuje v .env (nebo jako env vars):
 *   AIRTABLE_API_KEY=patXXXX
 *   AIRTABLE_BASE_ID=appXXXX
 *
 * Skript je idempotentní – objednávky se přeskočí, pokud již existují
 * (porovnání podle order_number).
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// ── Načti .env ────────────────────────────────────────────────

const envPath = path.join(projectRoot, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const APP_DATA_DIR = process.env.APP_DATA_DIR || path.join(projectRoot, 'data');

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('\nChybí AIRTABLE_API_KEY nebo AIRTABLE_BASE_ID.');
  console.error('Přidej je do .env nebo nastav jako env vars.\n');
  process.exit(1);
}

// ── Airtable tabulky ──────────────────────────────────────────

const AT_ORDERS     = 'tblhP8tvVl0KdJQeR';
const AT_ITEMS      = 'tblqjU6x9KTGEH7YW';

// Field IDs na objednávkách
const F = {
  orderNumber:      'fldrpOS8rh4zFuQhf',
  createdAt:        'fldBoq3y26qLLmFmf',
  status:           'fldqYJ0WgbNktvodr',
  firstName:        'fldSXFWeGZWP5p78m',
  lastName:         'fldHWnihHavgvzd7C',
  company:          'fld0baVKNA2s8Ew30',
  phone:            'fldM1HKgq9JG7z1Qv',
  address:          'fldRPHZNBLGIYctDq',
  city:             'fldz9ziSCPL4nhyRN',
  zip:              'fldNgmNrv1cwC2j4A',
  ipAddress:        'fldFT6kBX0IFpKf7F',
  shippingMethod:   'fld8Q8OjYH7vtGmK6',
  paymentMethod:    'fldfS6nqK4WallV4P',
  shippingFirstName:'fld4IdoOPmcyrhp5L',
  shippingLastName: 'fld2sRyKXxE72cHM8',
  shippingCompany:  'fldeUtp0EUC74ycKf',
  shippingPhone:    'fldsWCHPNEkxI185x',
  shippingAddress:  'fldDi1E3Zc8PTyRnu',
  shippingCity:     'fldGluke3JodUfPc6',
  shippingZip:      'fldBBzDOdot41I90S',
  totalPrice:       'flds7bIEsbE2cEWWj',
  pickupPointName:  'fldcrzmuNe6XcYURH',
  pickupPointId:    'fldniFThX5tVAh1aB',
  trackingNumber:   'fldCZ1TBBTGgBMfVg',
  labelUrl:         'fldIMKECXvDhNCUct',
  // email není přímé pole na objednávce (je v linked Adresář) — migrujeme bez něj
};

// Field IDs na položkách objednávky
const FI = {
  orderLink: 'fldY2RggE06sKFJ8y',
  name:      'fldvB5z3lFM8JLTQT',
  quantity:  'fld8hRuAjAkk1VnSL',
};

// ── Airtable fetch ────────────────────────────────────────────

async function atFetch(path, params = {}) {
  const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}${path}`);
  url.searchParams.set('returnFieldsByFieldId', 'true');
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(vi => url.searchParams.append(k, vi));
    else url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchAll(table, fieldIds) {
  const records = [];
  let offset;
  do {
    const params = { pageSize: '100' };
    if (offset) params.offset = offset;
    fieldIds.forEach(f => { params['fields[]'] = params['fields[]'] ? [...(Array.isArray(params['fields[]']) ? params['fields[]'] : [params['fields[]']]), f] : f; });
    // Rebuild properly
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table}`);
    url.searchParams.set('returnFieldsByFieldId', 'true');
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    fieldIds.forEach(f => url.searchParams.append('fields[]', f));

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;

    process.stdout.write(`\r  Staženo ${records.length} záznamů…`);
  } while (offset);
  process.stdout.write('\n');
  return records;
}

// ── SQLite ────────────────────────────────────────────────────

if (!existsSync(APP_DATA_DIR)) {
  try { mkdirSync(APP_DATA_DIR, { recursive: true }); } catch {}
}

const DB_PATH = path.join(APP_DATA_DIR, 'app.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

function str(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.filter(x => typeof x === 'string').join(', ');
  return String(v);
}
function num(v) {
  if (typeof v === 'number') return v;
  if (Array.isArray(v) && typeof v[0] === 'number') return v[0];
  return 0;
}

// ── CRM upsert ────────────────────────────────────────────────

function upsertContactToCRM({ email, firstName, lastName, company, phone, city, country }) {
  if (!email) return;

  let companyId = null;
  if (company) {
    const existingCo = db.prepare('SELECT id FROM crm_companies WHERE name = ?').get(company);
    if (existingCo) {
      companyId = existingCo.id;
    } else {
      companyId = generateId();
      db.prepare(`
        INSERT INTO crm_companies (id, name, company_type, city, country, modified_at)
        VALUES (?, ?, 'Zákazník', ?, ?, datetime('now'))
      `).run(companyId, company, city || '', country || '');
    }
  }

  const existing = db.prepare('SELECT id FROM crm_contacts WHERE email = ?').get(email);
  if (existing) {
    db.prepare(`
      UPDATE crm_contacts SET
        first_name = ?, last_name = ?, phone = ?,
        company_id = COALESCE(company_id, ?),
        modified_at = datetime('now')
      WHERE email = ?
    `).run(firstName || '', lastName || '', phone || '', companyId, email);
  } else {
    db.prepare(`
      INSERT INTO crm_contacts (id, first_name, last_name, email, phone, company_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, 'Zákazník Toneráček.cz')
    `).run(generateId(), firstName || '', lastName || '', email, phone || '', companyId);
  }
}

// ── Hlavní migrace ────────────────────────────────────────────

console.log('\n=== Migrace objednávek z Airtable → SQLite ===\n');

console.log('1. Stahování objednávek z Airtable…');
const orderRecords = await fetchAll(AT_ORDERS, Object.values(F));

console.log(`   Celkem ${orderRecords.length} objednávek.\n`);

console.log('2. Stahování položek objednávek…');
const itemRecords = await fetchAll(AT_ITEMS, Object.values(FI));

console.log(`   Celkem ${itemRecords.length} položek.\n`);

// Seskup položky podle order ID
const itemsByOrder = {};
for (const rec of itemRecords) {
  const f = rec.fields;
  const links = f[FI.orderLink];
  const orderId = Array.isArray(links) ? links[0] : links;
  if (!orderId) continue;
  if (!itemsByOrder[orderId]) itemsByOrder[orderId] = [];
  itemsByOrder[orderId].push({
    name: str(f[FI.name]),
    quantity: num(f[FI.quantity]) || 1,
  });
}

// ── Vlož do SQLite ────────────────────────────────────────────

console.log('3. Importování do SQLite…\n');

const insertOrder = db.prepare(`
  INSERT OR IGNORE INTO toneracek_orders (
    id, order_number, status, payment_method, shipping_method,
    first_name, last_name, company,
    email, phone, address, city, zip,
    shipping_first_name, shipping_last_name, shipping_company,
    shipping_phone, shipping_address, shipping_city, shipping_zip,
    pickup_point_id, pickup_point_name,
    total_price, invoice_number,
    tracking_number, label_url,
    ip_address, created_at, modified_at
  ) VALUES (
    ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?,
    ?, ?,
    ?, ?,
    ?, ?, ?
  )
`);

const insertItem = db.prepare(`
  INSERT INTO toneracek_order_items (order_id, sku, name, quantity, price)
  VALUES (?, '', ?, ?, 0)
`);

const stats = { imported: 0, skipped: 0, items: 0, contacts: 0 };

const migrate = db.transaction(() => {
  for (const rec of orderRecords) {
    const f   = rec.fields;
    const atId = rec.id; // Airtable record ID jako SQLite ID

    const orderNum = num(f[F.orderNumber]);
    if (!orderNum) { stats.skipped++; continue; }

    // Zkontroluj zda objednávka již existuje (idempotence)
    const exists = db.prepare('SELECT id FROM toneracek_orders WHERE id = ? OR order_number = ?').get(atId, orderNum);
    if (exists) { stats.skipped++; continue; }

    const email = '';
    const createdAt = str(f[F.createdAt]) || new Date().toISOString();
    const year = new Date(createdAt).getFullYear();
    const invoiceNumber = `FV-${year}-${orderNum}`;

    insertOrder.run(
      atId,
      orderNum,
      str(f[F.status]) || 'Přijata',
      str(f[F.paymentMethod]) || '',
      str(f[F.shippingMethod]) || 'Zásilkovna',
      str(f[F.firstName]),
      str(f[F.lastName]),
      str(f[F.company]),
      email,
      str(f[F.phone]),
      str(f[F.address]),
      str(f[F.city]),
      str(f[F.zip]),
      str(f[F.shippingFirstName]) || str(f[F.firstName]),
      str(f[F.shippingLastName])  || str(f[F.lastName]),
      str(f[F.shippingCompany])   || str(f[F.company]),
      str(f[F.shippingPhone])     || str(f[F.phone]),
      str(f[F.shippingAddress])   || str(f[F.address]),
      str(f[F.shippingCity])      || str(f[F.city]),
      str(f[F.shippingZip])       || str(f[F.zip]),
      str(f[F.pickupPointId]),
      str(f[F.pickupPointName]),
      num(f[F.totalPrice]),
      invoiceNumber,
      str(f[F.trackingNumber]),
      str(f[F.labelUrl]),
      str(f[F.ipAddress]),
      createdAt,
      createdAt,
    );

    // Vlož položky
    const items = itemsByOrder[atId] || [];
    for (const item of items) {
      insertItem.run(atId, item.name, item.quantity);
      stats.items++;
    }

    // CRM upsert
    if (email) {
      try {
        upsertContactToCRM({
          email,
          firstName: str(f[F.firstName]),
          lastName:  str(f[F.lastName]),
          company:   str(f[F.company]),
          phone:     str(f[F.phone]),
          city:      str(f[F.city]),
          country:   'Česká republika',
        });
        stats.contacts++;
      } catch {}
    }

    stats.imported++;
    if (stats.imported % 50 === 0) {
      console.log(`   ${stats.imported} / ${orderRecords.length} importováno…`);
    }
  }
});

migrate();

db.close();

console.log('\n=== Výsledek ===');
console.log(`  Importováno objednávek: ${stats.imported}`);
console.log(`  Přeskočeno (již existuje): ${stats.skipped}`);
console.log(`  Importováno položek: ${stats.items}`);
console.log(`  CRM kontaktů upsertováno: ${stats.contacts}`);
console.log(`\nHotovo! DB: ${DB_PATH}\n`);
