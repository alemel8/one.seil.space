#!/usr/bin/env node
// Jednorázová migrace dat z app.sqlite → PostgreSQL
// Spuštění: node scripts/migrate-sqlite-to-postgres.js
//
// Předpoklady:
//   - .env nebo DATABASE_URL v prostředí
//   - app.sqlite existuje v ./data/app.sqlite
//   - PG schema je již vytvořeno (migrations/ runner)

import Database from 'better-sqlite3';
import postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(projectRoot, 'data', 'app.sqlite');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL není nastavena');
  process.exit(1);
}
if (!existsSync(SQLITE_PATH)) {
  console.error(`❌ SQLite databáze nenalezena: ${SQLITE_PATH}`);
  process.exit(1);
}

const sqlite = new Database(SQLITE_PATH, { readonly: true });
const sql = postgres(DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 1,
});

const stats = {
  users: 0, companies: 0, contacts: 0,
  orders: 0, orderItems: 0,
  invoicesReceived: 0, invoicesIssued: 0,
  bank: 0, skipped: 0,
};

function nullify(val) {
  return val === '' || val === undefined ? null : val;
}

async function run() {
  console.log('🚀 Spouštím migraci SQLite → PostgreSQL');
  console.log(`   SQLite: ${SQLITE_PATH}`);
  console.log(`   PG:     ${DATABASE_URL.replace(/:([^:@]+)@/, ':***@')}\n`);

  // ── 1. Toneráček shop (seed) ─────────────────────────────
  console.log('📦 Eshop: Toneráček...');
  const [existingShop] = await sql`SELECT id FROM shops WHERE slug = 'toneracek' LIMIT 1`;
  let toneracekShopId;
  if (!existingShop) {
    const [shop] = await sql`
      INSERT INTO shops (slug, name, url) VALUES ('toneracek', 'Toneráček.cz', 'https://toneracek.cz')
      RETURNING id
    `;
    toneracekShopId = shop.id;
    console.log(`   ✓ Shop vytvořen (id=${toneracekShopId})`);
  } else {
    toneracekShopId = existingShop.id;
    console.log(`   ✓ Shop existuje (id=${toneracekShopId})`);
  }

  // Toneráček API klíč
  const apiKey = process.env.TONERACEK_API_KEY;
  if (apiKey) {
    await sql`
      INSERT INTO api_keys (key, shop_id) VALUES (${apiKey}, ${toneracekShopId})
      ON CONFLICT (key) DO NOTHING
    `;
    console.log('   ✓ API klíč Toneráček uložen');
  }

  // ── 2. Uživatelé ─────────────────────────────────────────
  console.log('\n👤 Uživatelé...');
  const users = sqlite.prepare('SELECT * FROM users').all();
  for (const u of users) {
    await sql`
      INSERT INTO users (id, email, password_hash, first_name, last_name, is_admin, is_active, photo, created_at)
      VALUES (${u.id}, ${u.email}, ${u.password_hash}, ${u.first_name||''}, ${u.last_name||''},
              ${!!u.is_admin}, ${!!u.is_active}, ${nullify(u.photo)}, ${u.created_at})
      ON CONFLICT (email) DO NOTHING
    `;
    stats.users++;
  }
  console.log(`   ✓ ${stats.users} uživatelů`);

  // ── 3. CRM Firmy ─────────────────────────────────────────
  console.log('\n🏢 CRM firmy...');
  const hasIco = sqlite.prepare("PRAGMA table_info(crm_companies)").all().some(c => c.name === 'ico');
  const companies = sqlite.prepare('SELECT * FROM crm_companies').all();
  for (const c of companies) {
    await sql`
      INSERT INTO crm_companies
        (id, name, company_type, ico, dic, country, city, zip, address, email, phone, website, notes, created_at, modified_at)
      VALUES (
        ${c.id}, ${c.name}, ${c.company_type||'Zákazník'},
        ${hasIco ? (c.ico||'') : ''}, ${hasIco ? (c.dic||'') : ''},
        ${c.country||''}, ${c.city||''}, ${c.zip||''}, ${c.address||''},
        ${c.email||''}, ${c.phone||''}, ${c.website||''}, ${c.notes||''},
        ${c.created_at}, ${c.modified_at||c.created_at}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    stats.companies++;
  }
  console.log(`   ✓ ${stats.companies} firem`);

  // ── 4. CRM Kontakty ───────────────────────────────────────
  console.log('\n👥 CRM kontakty...');
  const contacts = sqlite.prepare('SELECT * FROM crm_contacts').all();
  for (const c of contacts) {
    const email = c.email?.trim() || null;
    await sql`
      INSERT INTO crm_contacts
        (id, first_name, last_name, email, phone, title, company_id, company_name,
         address, city, zip, notes, is_registered, active,
         marketing_consent, notifications_consent, last_login, created_at, modified_at)
      VALUES (
        ${c.id}, ${c.first_name||''}, ${c.last_name||''}, ${email}, ${c.phone||''},
        ${c.title||''}, ${nullify(c.company_id)}, ${c.company_name||''},
        ${c.address||''}, ${c.city||''}, ${c.zip||''}, ${c.notes||''},
        ${!!c.is_registered}, ${c.aktivni !== 0},
        ${!!c.souhlas_marketing}, ${!!c.souhlas_notifikace},
        ${nullify(c.posledni_prihlaseni)}, ${c.created_at}, ${c.modified_at||c.created_at}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    stats.contacts++;
  }
  console.log(`   ✓ ${stats.contacts} kontaktů`);

  // ── 5. Objednávky (shop_orders + shop_order_items) ────────
  console.log('\n📋 Objednávky...');

  // Zkus načíst z shop_orders (pokud existuje), jinak z toneracek_orders
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const ordersTable = tables.includes('shop_orders') ? 'shop_orders' : 'toneracek_orders';
  const itemsTable  = tables.includes('shop_order_items') ? 'shop_order_items' : 'toneracek_order_items';
  console.log(`   Zdrojová tabulka: ${ordersTable}`);

  const orders = sqlite.prepare(`SELECT * FROM ${ordersTable}`).all();
  for (const o of orders) {
    const existing = await sql`SELECT id FROM shop_orders WHERE id = ${o.id} LIMIT 1`;
    if (existing[0]) { stats.skipped++; continue; }

    await sql`
      INSERT INTO shop_orders (
        id, shop_id, order_number, status, payment_method, shipping_method, currency,
        first_name, last_name, company, ic, dic, email, phone,
        address, city, zip, country,
        shipping_first_name, shipping_last_name, shipping_company,
        shipping_phone, shipping_address, shipping_city, shipping_zip,
        pickup_point_id, pickup_point_name,
        total_price, invoice_number, tracking_number, label_url, ip_address,
        notes, crm_contact_id, crm_company_id, created_at, modified_at
      ) VALUES (
        ${o.id}, ${toneracekShopId},
        ${String(o.order_number)}, ${o.status||'Přijata'},
        ${o.payment_method||''}, ${o.shipping_method||''}, ${o.currency||'CZK'},
        ${o.first_name||''}, ${o.last_name||''}, ${o.company||''},
        ${o.ic||''}, ${o.dic||''}, ${o.email||''}, ${o.phone||''},
        ${o.address||''}, ${o.city||''}, ${o.zip||''}, ${o.country||'Česká republika'},
        ${o.shipping_first_name||''}, ${o.shipping_last_name||''}, ${o.shipping_company||''},
        ${o.shipping_phone||''}, ${o.shipping_address||''}, ${o.shipping_city||''}, ${o.shipping_zip||''},
        ${o.pickup_point_id||''}, ${o.pickup_point_name||''},
        ${o.total_price||0}, ${o.invoice_number||''}, ${o.tracking_number||''},
        ${o.label_url||''}, ${o.ip_address||''}, ${o.notes||''},
        ${nullify(o.crm_contact_id)}, ${nullify(o.crm_company_id)},
        ${o.created_at}, ${o.modified_at||o.created_at}
      )
    `;

    const items = sqlite.prepare(`SELECT * FROM ${itemsTable} WHERE order_id = ?`).all(o.id);
    for (const item of items) {
      await sql`
        INSERT INTO shop_order_items (order_id, sku, name, quantity, price, product_id)
        VALUES (${o.id}, ${item.sku||''}, ${item.name}, ${item.quantity||1}, ${item.price||0}, ${nullify(item.product_id)})
      `;
      stats.orderItems++;
    }
    stats.orders++;
  }
  console.log(`   ✓ ${stats.orders} objednávek, ${stats.orderItems} položek (přeskočeno: ${stats.skipped})`);

  // ── 6. Přijaté faktury ────────────────────────────────────
  if (tables.includes('accounting_invoices_received')) {
    console.log('\n🧾 Přijaté faktury...');
    const invoices = sqlite.prepare('SELECT * FROM accounting_invoices_received').all();
    for (const inv of invoices) {
      await sql`
        INSERT INTO accounting_invoices
          (id, type, number, supplier, amount, total_amount, currency, status, due_date, issue_date, notes, created_at)
        VALUES (
          ${inv.id}, 'received', ${inv.number||''}, ${inv.supplier||''},
          ${inv.amount||0}, ${inv.amount||0}, ${inv.currency||'CZK'}, ${inv.status||'Nezaplacena'},
          ${nullify(inv.due_date)}, ${inv.date||new Date().toISOString().split('T')[0]},
          ${inv.notes||''}, ${inv.created_at}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      stats.invoicesReceived++;
    }
    console.log(`   ✓ ${stats.invoicesReceived} přijatých faktur`);
  }

  // ── 7. Vydané faktury ─────────────────────────────────────
  if (tables.includes('accounting_invoices_issued')) {
    console.log('\n🧾 Vydané faktury...');
    const invoices = sqlite.prepare('SELECT * FROM accounting_invoices_issued').all();
    for (const inv of invoices) {
      await sql`
        INSERT INTO accounting_invoices
          (id, type, number, client_name, amount, total_amount, currency, status, due_date, issue_date, notes, created_at)
        VALUES (
          ${inv.id}, 'issued', ${inv.number||''}, ${inv.client||''},
          ${inv.amount||0}, ${inv.amount||0}, ${inv.currency||'CZK'}, ${inv.status||'Nezaplacena'},
          ${nullify(inv.due_date)}, ${inv.date||new Date().toISOString().split('T')[0]},
          ${inv.notes||''}, ${inv.created_at}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      stats.invoicesIssued++;
    }
    console.log(`   ✓ ${stats.invoicesIssued} vydaných faktur`);
  }

  // ── 8. Banka (accounting_bank) ────────────────────────────
  if (tables.includes('accounting_bank')) {
    console.log('\n🏦 Bankovní záznamy...');
    const [bankAcc] = await sql`SELECT id FROM accounting_bank_accounts LIMIT 1`;
    let bankAccId = bankAcc?.id;
    if (!bankAccId) {
      const [acc] = await sql`
        INSERT INTO accounting_bank_accounts (name, bank_name, account_number, currency)
        VALUES ('Hlavní účet', 'Fio banka', '2800828200/2010', 'CZK') RETURNING id
      `;
      bankAccId = acc.id;
    }

    const transactions = sqlite.prepare('SELECT * FROM accounting_bank').all();
    for (const t of transactions) {
      const amount = Math.abs(t.amount || 0);
      const type = (t.type === 'Výdaj' || t.amount < 0) ? 'debit' : 'credit';
      await sql`
        INSERT INTO accounting_bank_transactions
          (bank_account_id, type, amount, currency, message, transaction_date, notes, created_at)
        VALUES (
          ${bankAccId}, ${type}, ${amount}, ${t.currency||'CZK'},
          ${t.description||''}, ${t.date||new Date().toISOString().split('T')[0]},
          ${t.notes||''}, ${t.created_at}
        )
      `;
      stats.bank++;
    }
    console.log(`   ✓ ${stats.bank} bankovních záznamů`);
  }

  console.log('\n✅ Migrace dokončena!');
  console.log(stats);

  sqlite.close();
  await sql.end();
}

run().catch(err => {
  console.error('❌ Migrace selhala:', err.message);
  process.exit(1);
});
