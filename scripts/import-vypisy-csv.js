/**
 * Import bankovních výpisů z Fio banky (CSV) do accounting_bank_transactions.
 *
 * Spuštění (.env si skript načte sám, --env-file není potřeba):
 *   node scripts/import-vypisy-csv.js --dry-run
 *   node scripts/import-vypisy-csv.js
 *   node scripts/import-vypisy-csv.js --no-match
 *
 * Přepínače:
 *   --dry-run   nic neukládá, jen vypíše, co by se stalo
 *   --no-match  nespáruje transakce s fakturami (jen naimportuje pohyby)
 *
 * Zdroje (adresář import/):
 *   Vypis_z_uctu-<účet>_<od>-<do>_cislo-<n>.csv   → jeden soubor = jeden výpis
 *
 * Hlídání duplicit:
 *   Klíčem je "ID operace" z výpisu → external_id (v DB UNIQUE). Transakce se
 *   tak nezdvojí ani při opakovaném importu, ani při překrytí období dvou
 *   výpisů, ani proti pohybům, které dorazily webhookem z Make.
 *   Soubor, ve kterém nic nového není, se přeskočí a nezaloží se pro něj
 *   záznam v accounting_bank_imports.
 *
 * Párování s fakturami:
 *   Podle variabilního symbolu proti číslu faktury (příjem → vydaná faktura
 *   nebo proforma, výdaj → přijatá faktura). Páruje se jen na jednoznačnou
 *   shodu; nejednoznačné případy zůstanou nespárované pro ruční dohledání
 *   v /ucetnictvi/banka. Rozdíl v částce se spáruje, ale zapíše do varování
 *   (částečná úhrada, poplatek).
 */

import './lib/load-env.js';   // musí být první — plní process.env z .env
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { parseStatement, normalizeAccount } from './lib/fio-csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '..');
const IMPORT_DIR = path.join(ROOT, 'import');

const DRY_RUN  = process.argv.includes('--dry-run');
const NO_MATCH = process.argv.includes('--no-match');

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 3,
});

// ── Helpers ───────────────────────────────────────────────────

/** Číslo faktury i VS na společný tvar — bez oddělovačů a úvodních nul. */
function normalizeVs(v) {
  return String(v ?? '').replace(/[\s\-/]/g, '').replace(/^0+(?=\d)/, '');
}

function money(n) {
  return Number(n).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const stats = {
  files: 0, filesSkipped: 0,
  inserted: 0, duplicates: 0,
  matched: 0, invoicesPaid: 0,
};
const warnings = [];

// ── Bankovní účty ─────────────────────────────────────────────

/**
 * Najde účet podle čísla, jinak založí. Porovnává se i na číslo bez kódu
 * banky, aby se netvořil druhý záznam k účtu, který už v systému je
 * (webhook z Make zakládá "Hlavní účet" s číslem 2800828200/2010).
 */
async function resolveAccount(cache, statement) {
  const norm  = statement.accountNorm;
  const bare  = norm.split('/')[0];
  const hit   = cache.find(a => a.norm === norm || a.norm.split('/')[0] === bare);
  if (hit) return hit;

  const bankName = statement.rows.find(r => r.bankName)?.bankName || 'Fio banka, a.s.';
  const name     = `Fio ${statement.currency} ${bare}`;

  if (DRY_RUN) {
    console.log(`  [nový účet] ${name} (${statement.account}, ${statement.currency})`);
    const fake = { id: null, norm, name };
    cache.push(fake);
    return fake;
  }

  const [row] = await sql`
    INSERT INTO accounting_bank_accounts (name, bank_name, account_number, currency)
    VALUES (${name}, ${bankName}, ${statement.account}, ${statement.currency})
    RETURNING id
  `;
  console.log(`  + nový bankovní účet: ${name} (${statement.account})`);
  const created = { id: row.id, norm, name };
  cache.push(created);
  return created;
}

// ── Párování s fakturami ──────────────────────────────────────

/**
 * Najde fakturu k transakci podle VS. Vrací { id, number, total, status }
 * nebo null. Nejednoznačné shody nepáruje.
 */
function findInvoice(invoiceIndex, tx) {
  const vs = normalizeVs(tx.vs);
  if (vs.length < 4) return null;   // krátké VS u karetních transakcí nejsou čísla faktur

  const wanted = tx.type === 'credit' ? ['issued', 'proforma'] : ['received'];
  const candidates = (invoiceIndex.get(vs) ?? []).filter(i => wanted.includes(i.type));
  if (candidates.length !== 1) {
    if (candidates.length > 1) {
      warnings.push(
        `VS ${tx.vs} (${tx.date}, ${money(tx.amount)} ${tx.currency}): odpovídá více fakturám ` +
        `(${candidates.map(c => c.number).join(', ')}) — nespárováno, dohledat ručně`
      );
    }
    return null;
  }
  return candidates[0];
}

// ── Import jednoho výpisu ─────────────────────────────────────

async function importStatement(file, seenIds, accounts, invoiceIndex) {
  let statement;
  try {
    statement = parseStatement(path.join(IMPORT_DIR, file));
  } catch (err) {
    warnings.push(`${file}: nelze přečíst — ${err.message}`);
    console.log(`  ⚠ ${file}: ${err.message}`);
    return;
  }

  const fresh = statement.rows.filter(r => !seenIds.has(r.externalId));
  const dupes = statement.rows.length - fresh.length;
  stats.duplicates += dupes;

  const label = `${file} (výpis ${statement.statementNo ?? '?'}, ` +
                `${statement.dateFrom} → ${statement.dateTo}, ${statement.rows.length} pohybů)`;

  if (!fresh.length) {
    stats.filesSkipped++;
    console.log(`  = ${label} — vše už v systému, přeskočeno`);
    return;
  }

  const account = await resolveAccount(accounts, statement);
  console.log(`\n  ${label}`);
  console.log(`    účet: ${account.name} | nových ${fresh.length}, duplicit ${dupes}`);

  // Co se má vložit — spočítá se dopředu, aby se stav v paměti (seenIds,
  // stats) měnil až po úspěšném commitu.
  const plan = fresh.map(tx => ({
    tx,
    invoice: NO_MATCH ? null : findInvoice(invoiceIndex, tx),
    // Poznámka: co se do zprávy nevešlo, ale je užitečné při dohledávání
    notes: [tx.txType, tx.author && `provedl ${tx.author}`, tx.detail].filter(Boolean).join(' | '),
  }));

  let paidNow = 0;

  /**
   * Celý výpis jednou transakcí — když spojení spadne v půlce souboru,
   * nezůstane v accounting_bank_imports záznam bez pohybů a další běh
   * soubor naimportuje celý znovu a čistě.
   */
  const run = async db => {
    let importId = null;
    if (db) {
      const [imp] = await db`
        INSERT INTO accounting_bank_imports
          (bank_account_id, filename, format, date_from, date_to)
        VALUES (${account.id}, ${file}, 'fio_csv', ${statement.dateFrom}, ${statement.dateTo})
        RETURNING id
      `;
      importId = imp.id;
    }

    for (const { tx, invoice, notes } of plan) {
      let txId = null;
      if (db) {
        const [ins] = await db`
          INSERT INTO accounting_bank_transactions
            (bank_account_id, import_id, external_id, type, amount, currency,
             counterparty_account, counterparty_name,
             variable_symbol, constant_symbol, specific_symbol,
             message, transaction_date, matched_invoice_id, matched_at, notes)
          VALUES (
            ${account.id}, ${importId}, ${tx.externalId}, ${tx.type}, ${tx.amount}, ${tx.currency},
            ${tx.cpAccount}, ${tx.cpName},
            ${tx.vs}, ${tx.ks}, ${tx.ss},
            ${tx.message}, ${tx.date}, ${invoice?.id ?? null},
            ${invoice ? db`NOW()` : null}, ${notes}
          )
          RETURNING id
        `;
        txId = ins.id;
      }

      if (invoice) {
        if (Math.abs(Number(invoice.total) - tx.amount) > 0.01) {
          warnings.push(
            `${invoice.number}: platba ${money(tx.amount)} ${tx.currency} z ${tx.date} ` +
            `neodpovídá částce faktury ${money(invoice.total)} — spárováno, zkontrolovat`
          );
        }
        if (db) {
          // Faktura z POHODY už stav úhrady většinou má; doplní se jen chybějící
          const done = await db`
            UPDATE accounting_invoices
            SET status = 'Zaplacena', paid_date = COALESCE(paid_date, ${tx.date}),
                bank_transaction_id = COALESCE(bank_transaction_id, ${txId}),
                modified_at = NOW()
            WHERE id = ${invoice.id} AND status <> 'Zaplacena'
            RETURNING id
          `;
          if (done.length) paidNow++;
        }
      }

      const sign = tx.type === 'debit' ? '-' : '+';
      console.log(
        `    ${DRY_RUN ? '[nová]' : '+'} ${tx.date} ${sign}${money(tx.amount)} ${tx.currency}` +
        ` | ${tx.cpName || tx.message.slice(0, 40) || tx.txType}` +
        `${tx.vs ? ` | VS ${tx.vs}` : ''}${invoice ? ` → ${invoice.number}` : ''}`
      );
    }

    if (db) {
      await db`
        UPDATE accounting_bank_imports
        SET rows_imported = ${plan.length}, rows_skipped = ${dupes},
            rows_matched = ${plan.filter(p => p.invoice).length}
        WHERE id = ${importId}
      `;
    }
  };

  if (DRY_RUN) await run(null);
  else         await sql.begin(run);

  // Až po commitu — dokud transakce neprojde, tvařme se, že se nic nestalo
  for (const { tx, invoice } of plan) {
    seenIds.add(tx.externalId);
    if (invoice) invoice.status = 'Zaplacena';
  }
  stats.files++;
  stats.inserted     += plan.length;
  stats.matched      += plan.filter(p => p.invoice).length;
  stats.invoicesPaid += paidNow;
}

// ── Hlavní ────────────────────────────────────────────────────

console.log('=== Import bankovních výpisů z Fio ===');
if (DRY_RUN)  console.log('⚠  DRY RUN — nic se neukládá');
if (NO_MATCH) console.log('⚠  --no-match — transakce se nepárují s fakturami');

try {
  const files = fs.readdirSync(IMPORT_DIR)
    .filter(f => /^Vypis_z_uctu.*\.csv$/i.test(f))
    // podle čísla výpisu, ne podle názvu — "cislo-10" je až za "cislo-9"
    .sort((a, b) => {
      const key = f => {
        const acct = f.match(/Vypis_z_uctu-(\d+)/)?.[1] ?? '';
        const from = f.match(/_(\d{8})-/)?.[1] ?? '';
        return `${acct}|${from}`;
      };
      return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    });

  if (!files.length) {
    console.log(`\nV ${path.relative(ROOT, IMPORT_DIR)}/ nejsou žádné soubory Vypis_z_uctu*.csv`);
    process.exit(0);
  }
  console.log(`\nSouborů k načtení: ${files.length}`);

  // Existující external_id — hlavní ochrana proti duplicitám
  const seenIds = new Set(
    (await sql`SELECT external_id FROM accounting_bank_transactions WHERE external_id IS NOT NULL`)
      .map(r => r.external_id)
  );
  console.log(`Transakcí už v systému: ${seenIds.size}`);

  const accounts = (await sql`SELECT id, name, account_number FROM accounting_bank_accounts`)
    .map(a => ({ id: a.id, name: a.name, norm: normalizeAccount(a.account_number) }));
  console.log(`Bankovních účtů v systému: ${accounts.length}`);

  // Index faktur podle normalizovaného čísla pro párování podle VS
  const invoiceIndex = new Map();
  if (!NO_MATCH) {
    const invoices = await sql`
      SELECT id, type, number, status, total_amount
      FROM accounting_invoices
      WHERE number <> '' AND type IN ('issued', 'proforma', 'received')
    `;
    for (const i of invoices) {
      const key = normalizeVs(i.number);
      if (!key) continue;
      const entry = { id: i.id, type: i.type, number: i.number, status: i.status, total: i.total_amount };
      invoiceIndex.set(key, [...(invoiceIndex.get(key) ?? []), entry]);
    }
    console.log(`Faktur k párování: ${invoices.length}`);
  }

  for (const file of files) {
    await importStatement(file, seenIds, accounts, invoiceIndex);
  }

  if (warnings.length) {
    console.log('\n━━━ Ke kontrole ━━━');
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  console.log('\n=== Hotovo ===');
  console.log(`Výpisů zpracováno: ${stats.files}, přeskočeno jako již naimportované: ${stats.filesSkipped}`);
  console.log(`Transakcí: +${stats.inserted} nových, ${stats.duplicates} duplicit přeskočeno`);
  console.log(`Párování: ${stats.matched} transakcí navázáno na fakturu, ${stats.invoicesPaid} faktur přepnuto na Zaplacena`);
} catch (err) {
  console.error('\n❌ Chyba:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
