/**
 * Import faktur z POHODA Excel exportů do accounting_invoices.
 *
 * Spuštění:
 *   node --env-file=.env scripts/import-faktury-xlsx.js --dry-run
 *   node --env-file=.env scripts/import-faktury-xlsx.js
 *   node --env-file=.env scripts/import-faktury-xlsx.js --no-merge
 *   node --env-file=.env scripts/import-faktury-xlsx.js --sync-status
 *
 * Přepínače:
 *   --dry-run      nic neukládá, jen vypíše, co by se stalo
 *   --no-merge     shody přes variabilní symbol jen přeskočí (viz níže)
 *   --sync-status  u faktur, které už v DB jsou, srovná stav úhrady
 *                  a datum zaplacení podle POHODY (jinak se nesahá)
 *
 * Zdroje (adresář import/):
 *   FA vyd.xlsx    → accounting_invoices (type='issued')
 *   FA prija.xlsx  → accounting_invoices (type='received')
 *
 * Hlídání duplicit:
 *   1. Číslo dokladu (POHODA "Číslo") proti number v DB — hlavní klíč.
 *   2. Variabilní symbol proti number v DB — zachytí faktury, které do
 *      systému přitekly jinou cestou (import z Disku) a jsou vedené pod
 *      číslem dodavatele. Ty se ve výchozím stavu sloučí do existujícího
 *      záznamu (zůstane id i příloha), s --no-merge se jen přeskočí.
 *   3. Kontrolně dodavatel+datum+částka — jen varování do logu.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { readSheet } from './lib/xlsx-lite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const DRY_RUN     = process.argv.includes('--dry-run');
const NO_MERGE    = process.argv.includes('--no-merge');
const SYNC_STATUS = process.argv.includes('--sync-status');

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
  if (serial == null || serial === '') return null;
  if (typeof serial !== 'number') {
    const m = str(serial).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : null;
  }
  return new Date(Math.round((serial - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
}

// IČO: Excel občas ukousne úvodní nuly → zarovnat na 8 číslic
function formatIco(v) {
  const s = str(v).replace(/\s/g, '');
  if (!s) return '';
  return /^\d+$/.test(s) ? s.padStart(8, '0') : s;
}

function formatZip(v) {
  return str(v).replace(/\s/g, '');
}

// Základ daně = součet všech sazeb včetně nulové (přenesená povinnost, zahraničí)
function taxBase(row) {
  return num(row['Kč 0']) + num(row['Kč snížená']) + num(row['Kč základní']) + num(row['Kč 2 snížená']);
}

function vatTotal(row) {
  return num(row['DPH snížená']) + num(row['DPH základní']) + num(row['DPH 2 snížená']);
}

function invoiceStatus(row, today) {
  if (row['Storno']) return 'Storno';
  // K likvidaci = kolik z dokladu zbývá uhradit; 0 znamená vyrovnáno
  // (i u nulového dokladu, např. vyúčtování zálohy)
  const remaining = num(row['K likvidaci']);
  if (remaining === 0) return 'Zaplacena';
  const due = excelDate(row['Splatno']);
  if (due && new Date(due) < today) return 'Po splatnosti';
  return 'Nezaplacena';
}

// Poznámka: text dokladu + doplňky, které by se jinak ztratily
function buildNotes(row) {
  const parts = [str(row['Text'])];
  const cm = str(row['Cizí měna']);
  if (cm) parts.push(`${num(row['CM celkem'])} ${cm}`);
  const typ = str(row['Typ']);
  if (typ && typ !== 'Faktura') parts.push(typ);
  return parts.filter(Boolean).join(' | ');
}

/** Společná pole faktury z řádku POHODY. */
function mapRow(row, today) {
  const psc  = formatZip(row['PSČ']);
  const obec = str(row['Obec']);
  const status = invoiceStatus(row, today);
  return {
    number:    str(row['Číslo']),
    varsym:    str(row['Varsym']),
    status,
    name:      str(row['Firma']) || str(row['Jméno']),
    ico:       formatIco(row['IČ']),
    dic:       str(row['DIČ']),
    street:    str(row['Ulice']),
    zip:       psc,
    city:      obec,
    address:   [str(row['Ulice']), psc && obec ? `${psc} ${obec}` : obec].filter(Boolean).join(', '),
    issueDate: excelDate(row['Datum']),
    dueDate:   excelDate(row['Splatno']),
    paidDate:  status === 'Zaplacena' ? (excelDate(row['Likv']) || excelDate(row['Splatno'])) : null,
    amount:    taxBase(row),
    vat:       vatTotal(row),
    total:     num(row['Celkem']),
    notes:     buildNotes(row),
  };
}

function readImport(file) {
  return readSheet(path.join(ROOT, 'import', file)).filter(r => str(r['Číslo']));
}

const stats = {
  issued: 0, issuedSkip: 0,
  received: 0, receivedSkip: 0, receivedMerged: 0,
  statusSynced: 0, statusDrift: 0,
};
const warnings = [];

/**
 * Existující faktura — srovnat stav úhrady s POHODOU.
 * POHODA je zdroj pravdy pro platby, DB se od ní rozejde vždy, když
 * platba dorazí až po předchozím importu.
 */
async function syncStatus(existing, f) {
  const paidDbe = existing.paid_date ?? null;
  if (existing.status === f.status && paidDbe === f.paidDate) return;

  stats.statusDrift++;
  const desc = `${f.number}: stav "${existing.status}" → "${f.status}"` +
               (f.paidDate !== paidDbe ? `, uhrazeno ${paidDbe ?? '—'} → ${f.paidDate ?? '—'}` : '');

  if (!SYNC_STATUS) {
    warnings.push(`${desc} — v POHODĚ jinak, spusť s --sync-status pro srovnání`);
    return;
  }
  if (!DRY_RUN) {
    await sql`
      UPDATE accounting_invoices
      SET status = ${f.status}, paid_date = ${f.paidDate}, modified_at = NOW()
      WHERE id = ${existing.id}
    `;
  }
  stats.statusSynced++;
  console.log(`  ~ ${desc}`);
}

// ── Vydané faktury ────────────────────────────────────────────

async function importIssued(icoToCompany, today) {
  console.log('\n━━━ FA vyd.xlsx → vydané faktury ━━━');
  const rows = readImport('FA vyd.xlsx');
  console.log(`  Řádků v souboru: ${rows.length}`);

  const existing = new Map(
    (await sql`
      SELECT id, number, status, paid_date::text AS paid_date
      FROM accounting_invoices WHERE type = 'issued'
    `).map(r => [r.number, r])
  );

  for (const row of rows) {
    const f = mapRow(row, today);
    const dup = existing.get(f.number);
    if (dup) {
      stats.issuedSkip++;
      await syncStatus(dup, f);
      continue;
    }

    const companyId = f.ico ? icoToCompany.get(f.ico) ?? null : null;

    if (DRY_RUN) {
      console.log(`  [nová] ${f.number} | ${f.issueDate} | ${f.name} | ${f.total} Kč | ${f.status}`);
    } else {
      await sql`
        INSERT INTO accounting_invoices
          (id, type, number, status, client_name, client_ico, client_dic, client_address,
           crm_company_id, issue_date, due_date, paid_date,
           amount, vat_amount, total_amount, currency, notes, created_at, modified_at)
        VALUES (
          ${genId()}, 'issued', ${f.number}, ${f.status},
          ${f.name}, ${f.ico}, ${f.dic}, ${f.address},
          ${companyId}, ${f.issueDate}, ${f.dueDate}, ${f.paidDate},
          ${f.amount}, ${f.vat}, ${f.total}, 'CZK', ${f.notes}, NOW(), NOW()
        )
      `;
      console.log(`  + ${f.number} | ${f.issueDate} | ${f.name} | ${f.total} Kč | ${f.status}`);
    }

    existing.set(f.number, { id: null, number: f.number, status: f.status, paid_date: f.paidDate });
    stats.issued++;
  }

  console.log(`  ✓ vloženo ${stats.issued}, přeskočeno jako duplicita ${stats.issuedSkip}`);
}

// ── Přijaté faktury ───────────────────────────────────────────

async function importReceived(icoToCompany, today) {
  console.log('\n━━━ FA prija.xlsx → přijaté faktury ━━━');
  const rows = readImport('FA prija.xlsx');
  console.log(`  Řádků v souboru: ${rows.length}`);

  const dbRows = await sql`
    SELECT id, number, supplier, status, issue_date::text AS issue_date,
           paid_date::text AS paid_date, total_amount
    FROM accounting_invoices WHERE type = 'received'
  `;
  const byNumber = new Map(dbRows.map(r => [r.number, r]));
  // Kontrolní index pro fuzzy shodu (jiné číslo, ale stejné datum i částka)
  const byDateAmount = new Map();
  for (const r of dbRows) {
    const key = `${r.issue_date}|${num(r.total_amount).toFixed(2)}`;
    byDateAmount.set(key, [...(byDateAmount.get(key) ?? []), r]);
  }

  for (const row of rows) {
    const f = mapRow(row, today);

    // 1) duplicita podle čísla dokladu
    const dup = byNumber.get(f.number);
    if (dup) {
      stats.receivedSkip++;
      await syncStatus(dup, f);
      continue;
    }

    // 2) duplicita pod variabilním symbolem (faktura přišla jinou cestou)
    const underVs = f.varsym ? byNumber.get(f.varsym) : null;
    if (underVs) {
      if (NO_MERGE) {
        stats.receivedSkip++;
        warnings.push(`${f.number}: již v DB pod VS ${f.varsym} (id ${underVs.id}) — přeskočeno`);
        continue;
      }
      if (!DRY_RUN) {
        await sql`
          UPDATE accounting_invoices SET
            number = ${f.number}, status = ${f.status},
            supplier = ${f.name}, supplier_ico = ${f.ico}, supplier_dic = ${f.dic},
            supplier_address = ${f.street}, supplier_city = ${f.city}, supplier_zip = ${f.zip},
            crm_company_id = COALESCE(crm_company_id, ${f.ico ? icoToCompany.get(f.ico) ?? null : null}),
            issue_date = ${f.issueDate}, due_date = ${f.dueDate}, paid_date = ${f.paidDate},
            amount = ${f.amount}, vat_amount = ${f.vat}, total_amount = ${f.total},
            notes = ${f.notes}, modified_at = NOW()
          WHERE id = ${underVs.id}
        `;
      }
      byNumber.delete(f.varsym);
      byNumber.set(f.number, { ...underVs, number: f.number });
      stats.receivedMerged++;
      warnings.push(
        `${f.number}: sloučeno s existujícím záznamem "${underVs.number}" ` +
        `(${underVs.supplier}, ${underVs.issue_date}, ${num(underVs.total_amount)} Kč) — příloha zachována`
      );
      console.log(`  ~ ${f.number} | sloučeno se záznamem pod VS ${f.varsym}`);
      continue;
    }

    // 3) kontrolní shoda datum+částka — jen upozornění
    const fuzzy = byDateAmount.get(`${f.issueDate}|${f.total.toFixed(2)}`);
    if (fuzzy?.length) {
      warnings.push(
        `${f.number} (${f.name}, ${f.issueDate}, ${f.total} Kč): stejné datum i částka jako ` +
        fuzzy.map(r => `${r.number} (${r.supplier})`).join(', ') + ' — zkontrolovat ručně'
      );
    }

    const companyId = f.ico ? icoToCompany.get(f.ico) ?? null : null;

    if (DRY_RUN) {
      console.log(`  [nová] ${f.number} | ${f.issueDate} | ${f.name} | ${f.total} Kč | ${f.status}`);
    } else {
      await sql`
        INSERT INTO accounting_invoices
          (id, type, number, status, supplier, supplier_ico, supplier_dic,
           supplier_address, supplier_city, supplier_zip, supplier_country,
           crm_company_id, issue_date, due_date, paid_date,
           amount, vat_amount, total_amount, currency, notes, created_at, modified_at)
        VALUES (
          ${genId()}, 'received', ${f.number}, ${f.status},
          ${f.name}, ${f.ico}, ${f.dic},
          ${f.street}, ${f.city}, ${f.zip}, 'Česká republika',
          ${companyId}, ${f.issueDate}, ${f.dueDate}, ${f.paidDate},
          ${f.amount}, ${f.vat}, ${f.total}, 'CZK', ${f.notes}, NOW(), NOW()
        )
      `;
    }

    byNumber.set(f.number, {
      id: null, number: f.number, supplier: f.name, status: f.status,
      issue_date: f.issueDate, paid_date: f.paidDate, total_amount: f.total,
    });
    stats.received++;
  }

  console.log(`  ✓ vloženo ${stats.received}, sloučeno ${stats.receivedMerged}, přeskočeno jako duplicita ${stats.receivedSkip}`);
}

// ── Hlavní ────────────────────────────────────────────────────

console.log('=== Import faktur z POHODY ===');
if (DRY_RUN)     console.log('⚠  DRY RUN — nic se neukládá');
if (NO_MERGE)    console.log('⚠  --no-merge — shody přes VS se jen přeskočí');
if (SYNC_STATUS) console.log('★  --sync-status — u existujících faktur se srovná stav úhrady');

try {
  const today = new Date();
  const icoToCompany = new Map(
    (await sql`SELECT id, ico FROM crm_companies WHERE ico <> ''`).map(r => [r.ico, r.id])
  );
  console.log(`  Firem v CRM s IČO: ${icoToCompany.size}`);

  await importIssued(icoToCompany, today);
  await importReceived(icoToCompany, today);

  if (warnings.length) {
    console.log('\n━━━ Ke kontrole ━━━');
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  console.log('\n=== Hotovo ===');
  console.log(`Vydané:   +${stats.issued} nových, ${stats.issuedSkip} duplicit přeskočeno`);
  console.log(`Přijaté:  +${stats.received} nových, ${stats.receivedMerged} sloučeno, ${stats.receivedSkip} duplicit přeskočeno`);
  console.log(`Stav úhrady: ${stats.statusDrift} rozdílů oproti POHODĚ, ${stats.statusSynced} srovnáno`);
} catch (err) {
  console.error('\n❌ Chyba:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
