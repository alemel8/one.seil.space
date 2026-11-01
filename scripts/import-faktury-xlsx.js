/**
 * Import faktur z POHODA Excel exportů do accounting_invoices.
 *
 * Spuštění (.env si skript načte sám, --env-file není potřeba):
 *   node scripts/import-faktury-xlsx.js --dry-run
 *   node scripts/import-faktury-xlsx.js
 *   node scripts/import-faktury-xlsx.js --no-merge
 *   node scripts/import-faktury-xlsx.js --sync-status
 *   node scripts/import-faktury-xlsx.js --jen-uhrazene
 *
 * Přepínače:
 *   --dry-run      nic neukládá, jen vypíše, co by se stalo
 *   --no-merge     shody přes variabilní symbol jen přeskočí (viz níže)
 *   --sync-status  u faktur, které už v DB jsou, srovná stav úhrady
 *                  a datum zaplacení podle POHODY (jinak se nesahá).
 *                  Fakturu s navázaným bankovním pohybem ale nikdy
 *                  neshodí na nezaplacenou – viz syncStatus().
 *   --jen-uhrazene  jako --sync-status, ale zapíše jen faktury, které jsou v POHODĚ
 *                  uhrazené a tady ne. Nikdy nic nevrátí na nezaplacenou: faktury
 *                  z e-shopu bývají zaplacené jen tady, likvidace v POHODĚ chybí.
 *
 * Zdroje (adresář import/):
 *   FA vyd*.xlsx   → accounting_invoices (type='issued')
 *   FA pri*.xlsx   → accounting_invoices (type='received')
 *
 *   POHODA pojmenovává exporty různě ("FA vyd.xlsx", "FAvyd.xlsx", "FApri.xlsx",
 *   "FA prijate.xlsx"), soubor se proto hledá podle názvu bez mezer a diakritiky.
 *
 * Hlídání duplicit:
 *   1. Číslo dokladu (POHODA "Číslo") a dodavatel proti number a dodavateli
 *      v DB – hlavní klíč. Stejné číslo od jiného dodavatele je jiná faktura
 *      (migrace 044), ale jen když se liší IČO i název. Jinak, nebo když sedí datum
 *      a částka, jde nejspíš o opravené IČO nebo název: přeskočí se s varováním.
 *   2. Variabilní symbol a dodavatel proti number a dodavateli v DB – zachytí
 *      faktury, které do systému přitekly jinou cestou (import z Disku) a jsou
 *      vedené pod číslem dodavatele. Ty se ve výchozím stavu sloučí do
 *      existujícího záznamu (zůstane id i příloha), s --no-merge se jen přeskočí.
 *      Slučuje se jen při shodě data nebo částky. Když to poznat nejde, přeskočí
 *      se s varováním.
 *   3. Kontrolně dodavatel+datum+částka – jen varování do logu.
 *
 * Každý doklad nalezený v exportu dostane příznak pohoda_v_evidenci (seznamy
 * ukazují V POHODĚ), i faktura z e-shopu nebo z Disku, kterou tu nezakládá POHODA.
 */

import './lib/load-env.js';   // musí být první – plní process.env z .env
import { posudCislo, posudVs } from './lib/dodavatel.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { readSheet } from './lib/xlsx-lite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const DRY_RUN     = process.argv.includes('--dry-run');
const NO_MERGE    = process.argv.includes('--no-merge');
const JEN_UHRAZENE = process.argv.includes('--jen-uhrazene');
const SYNC_STATUS = process.argv.includes('--sync-status') || JEN_UHRAZENE;

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
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
    doklad:    str(row['Doklad']),
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

/** Název souboru na porovnávací tvar: bez diakritiky, mezer a přípony. */
function fileKey(name) {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\.xlsx$/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

/**
 * Najde v import/ exporty daného druhu. POHODA umí vyvézt buď všechno
 * najednou, nebo po letech, takže se počítá s obojím pojmenováním:
 *
 *   FAvyd.xlsx / FApri.xlsx   – jeden export; víc shod = radši spadnout,
 *                               ať se nenaimportuje omylem starší soubor
 *   FA24v.xlsx / FA24p.xlsx   – export po letech; těch je klidně víc,
 *                               jsou to různá data, ne konkurenční verze
 *
 * Roční exporty se vrací od nejnovějšího. Stejná faktura se totiž objeví
 * ve víc letech (nezaplacené se táhnou dál) a chceme její poslední stav.
 */
function findImportFiles(kind, label) {
  const dir = path.join(ROOT, 'import');
  const suffix = kind === 'issued' ? 'v' : 'p';
  const legacyPrefix = kind === 'issued' ? 'favyd' : 'fapri';
  const yearRe = new RegExp(`^fa(\\d{2})${suffix}$`);

  const files = fs.readdirSync(dir).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
  // POHODA pojmenovává export vydaných i prostě FA.xlsx.
  const legacy = files.filter(f => fileKey(f).startsWith(legacyPrefix) || (kind === 'issued' && fileKey(f) === 'fa'));
  const yearly = files
    .filter(f => yearRe.test(fileKey(f)))
    .sort((a, b) => fileKey(b).localeCompare(fileKey(a)));   // od nejnovějšího

  if (legacy.length && yearly.length) {
    throw new Error(
      `v import/ jsou obě pojmenování ${label}: ${[...legacy, ...yearly].join(', ')} – ` +
      'nech jen jedno, ať se stejná faktura neimportuje ze dvou zdrojů'
    );
  }
  if (legacy.length > 1) {
    throw new Error(
      `v import/ je více exportů ${label}: ${legacy.join(', ')} – ` +
      'nech jen ten aktuální, ať se nenaimportuje starší'
    );
  }
  const hits = legacy.length ? legacy : yearly;
  if (!hits.length) {
    throw new Error(
      `v import/ chybí export ${label} ` +
      `(hledá se ${legacyPrefix}*.xlsx nebo FA<rok>${suffix}.xlsx)`
    );
  }
  return hits.map(f => path.join(dir, f));
}

/**
 * Načte řádky ze všech exportů daného druhu. Doklad, který je ve víc
 * ročních souborech, se vezme jen jednou – z toho nejnovějšího, protože
 * ten má aktuální stav úhrady.
 */
function readImport(kind, label) {
  const rows = [];
  const videno = new Set();
  let prekryv = 0;

  for (const file of findImportFiles(kind, label)) {
    const part = readSheet(file).filter(r => str(r['Číslo']));
    let nove = 0;
    for (const row of part) {
      const cislo = str(row['Číslo']);
      if (videno.has(cislo)) { prekryv++; continue; }
      videno.add(cislo);
      rows.push(row);
      nove++;
    }
    console.log(`  Soubor: import/${path.basename(file)} – ${part.length} řádků, ${nove} nových`);
  }
  if (prekryv) {
    console.log(`  (${prekryv}× stejný doklad ve více letech – brán z nejnovějšího exportu)`);
  }
  return rows;
}

const stats = {
  issued: 0, issuedSkip: 0,
  received: 0, receivedSkip: 0, receivedMerged: 0,
  statusSynced: 0, statusDrift: 0, statusProtected: 0, dokladDoplnen: 0,
};
const warnings = [];
// Řádky v DB, které export z POHODY obsahuje; příznak se zapíše na konci najednou.
const vPohode = new Set();

/**
 * Existující faktura – srovnat stav úhrady s POHODOU.
 * POHODA je zdroj pravdy pro platby, DB se od ní rozejde vždy, když
 * platba dorazí až po předchozím importu.
 */
async function syncStatus(existing, f) {
  const paidDbe = existing.paid_date ?? null;
  if (existing.status === f.status && paidDbe === f.paidDate) return;

  // Navázaný bankovní pohyb je tvrdší důkaz než POHODA: platba na účtu
  // prokazatelně přišla, v POHODĚ jen chybí likvidace. Takovou fakturu
  // nikdy neshazujeme zpátky na nezaplacenou, ani s --sync-status.
  if (existing.status === 'Zaplacena' && f.status !== 'Zaplacena' && existing.bank_transaction_id) {
    stats.statusProtected++;
    warnings.push(
      `${f.number}: v POHODĚ "${f.status}", ale úhradu potvrzuje bankovní pohyb ` +
      `(uhrazeno ${paidDbe ?? '–'}) – ponecháno "Zaplacena", chybí likvidace v POHODĚ`
    );
    return;
  }

  stats.statusDrift++;
  const desc = `${f.number}: stav "${existing.status}" → "${f.status}"` +
               (f.paidDate !== paidDbe ? `, uhrazeno ${paidDbe ?? '–'} → ${f.paidDate ?? '–'}` : '');

  if (!SYNC_STATUS || (JEN_UHRAZENE && (f.status !== 'Zaplacena' || existing.status === 'Zaplacena'))) {
    warnings.push(`${desc} – v POHODĚ jinak, spusť s --sync-status pro srovnání`);
    return;
  }
  if (!DRY_RUN) {
    await sql`
      UPDATE accounting_invoices
      SET status = ${f.status}, paid_date = ${f.paidDate}, modified_at = NOW()
      WHERE id = ${existing.id}
    `;
    // Uhrazená faktura nesmí zůstat ve frontě upomínek, odeslání stav faktury nehlídá.
    if (f.status === 'Zaplacena') {
      await sql`UPDATE invoice_reminders SET status = 'zrusena' WHERE invoice_id = ${existing.id} AND status = 'ceka'`;
    }
  }
  stats.statusSynced++;
  console.log(`  ~ ${desc}`);
}

// ── Vydané faktury ────────────────────────────────────────────

async function importIssued(icoToCompany, today) {
  console.log('\n━━━ Vydané faktury ━━━');
  const rows = readImport('issued', 'vydaných faktur');
  console.log(`  Řádků v souboru: ${rows.length}`);

  const existing = new Map(
    (await sql`
      SELECT id, number, status, paid_date::text AS paid_date, bank_transaction_id
      FROM accounting_invoices WHERE type = 'issued'
    `).map(r => [r.number, r])
  );

  for (const row of rows) {
    const f = mapRow(row, today);
    const dup = existing.get(f.number);
    if (dup) {
      if (dup.id) vPohode.add(dup.id);
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
           amount, vat_amount, total_amount, currency, notes, source, pohoda_v_evidenci, created_at, modified_at)
        VALUES (
          ${genId()}, 'issued', ${f.number}, ${f.status},
          ${f.name}, ${f.ico}, ${f.dic}, ${f.address},
          ${companyId}, ${f.issueDate}, ${f.dueDate}, ${f.paidDate},
          ${f.amount}, ${f.vat}, ${f.total}, 'CZK', ${f.notes}, 'pohoda', TRUE, NOW(), NOW()
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
  console.log('\n━━━ Přijaté faktury ━━━');
  const rows = readImport('received', 'přijatých faktur');
  console.log(`  Řádků v souboru: ${rows.length}`);

  const dbRows = await sql`
    SELECT id, number, supplier, supplier_ico, supplier_number, status, issue_date::text AS issue_date,
           paid_date::text AS paid_date, total_amount, bank_transaction_id
    FROM accounting_invoices WHERE type = 'received'
  `;
  const byNumber = new Map();
  const pridej = (cislo, r) => byNumber.set(cislo, [...(byNumber.get(cislo) ?? []), r]);
  for (const r of dbRows) pridej(r.number, r);
  const seznam = (radky) => radky.map(r => r.supplier).join(', ');
  const cislaVExportu = new Set(rows.map(row => mapRow(row, today).number));
  // Kontrolní index pro fuzzy shodu (jiné číslo, ale stejné datum i částka)
  const byDateAmount = new Map();
  for (const r of dbRows) {
    const key = `${r.issue_date}|${num(r.total_amount).toFixed(2)}`;
    byDateAmount.set(key, [...(byDateAmount.get(key) ?? []), r]);
  }

  for (const row of rows) {
    const f = mapRow(row, today);

    // 1) duplicita podle čísla dokladu
    const podleCisla = posudCislo(byNumber.get(f.number) ?? [], f);
    if (podleCisla.akce === 'nejiste') {
      stats.receivedSkip++;
      // Stav se tu nesrovnává, řádek může být cizí. Rozdíl v úhradě ale musí být vidět.
      const jinyStav = podleCisla.radky.filter(r => r.status !== f.status);
      if (jinyStav.length) stats.statusDrift++;
      warnings.push(
        `${f.number} (${f.name}): stejné číslo má ${seznam(podleCisla.radky)}, dodavatele nejde rozlišit – přeskočeno, zkontrolovat ručně` +
        (jinyStav.length ? `; v POHODĚ je stav "${f.status}", tady ${jinyStav.map(r => `"${r.status}"`).join(', ')}` : '')
      );
      continue;
    }
    if (podleCisla.akce === 'existuje') {
      if (podleCisla.radek.id) vPohode.add(podleCisla.radek.id);
      stats.receivedSkip++;
      // Číslo dodavatele pro párování s Google Diskem; jen prázdné, ruční opravu nepřepíše.
      if (podleCisla.radek.id && !podleCisla.radek.supplier_number && f.doklad) {
        stats.dokladDoplnen++;
        if (!DRY_RUN) {
          await sql`UPDATE accounting_invoices SET supplier_number = ${f.doklad} WHERE id = ${podleCisla.radek.id} AND supplier_number = ''`;
        }
      }
      await syncStatus(podleCisla.radek, f);
      continue;
    }

    // Bez data se řádek nedá založit ani sloučit, sloupec je NOT NULL.
    if (!f.issueDate) {
      stats.receivedSkip++;
      warnings.push(`${f.number} (${f.name}): v POHODĚ chybí datum – přeskočeno, zkontrolovat ručně`);
      continue;
    }

    // 2) duplicita pod variabilním symbolem (faktura přišla jinou cestou)
    // Číslo z tohoto exportu je samostatný doklad POHODY, ne faktura z Disku pod číslem dodavatele.
    const podleVs = f.varsym && !cislaVExportu.has(f.varsym) ? posudVs(byNumber.get(f.varsym) ?? [], f) : { akce: 'zadna' };
    if (podleVs.akce === 'nejiste') {
      stats.receivedSkip++;
      warnings.push(`${f.number} (${f.name}): VS ${f.varsym} má ${seznam(podleVs.radky)}, dodavatele nejde rozlišit – přeskočeno, zkontrolovat ručně`);
      continue;
    }
    const underVs = podleVs.radek;
    if (underVs) {
      if (NO_MERGE) {
        stats.receivedSkip++;
        warnings.push(`${f.number}: již v DB pod VS ${f.varsym} (id ${underVs.id}) – přeskočeno`);
        continue;
      }
      // Navázaný bankovní pohyb je tvrdší důkaz než POHODA, viz syncStatus.
      const zaplaceno = underVs.status === 'Zaplacena' && f.status !== 'Zaplacena' && underVs.bank_transaction_id;
      if (zaplaceno) {
        stats.statusProtected++;
        warnings.push(`${f.number}: v POHODĚ "${f.status}", ale úhradu potvrzuje bankovní pohyb – ponecháno "Zaplacena"`);
      }
      if (!DRY_RUN) {
        await sql`
          UPDATE accounting_invoices SET
            number = ${f.number}, supplier_number = ${f.doklad}, status = ${zaplaceno ? underVs.status : f.status}, currency = 'CZK',
            supplier = ${f.name}, supplier_ico = ${f.ico}, supplier_dic = ${f.dic},
            supplier_address = ${f.street}, supplier_city = ${f.city}, supplier_zip = ${f.zip},
            crm_company_id = COALESCE(crm_company_id, ${f.ico ? icoToCompany.get(f.ico) ?? null : null}),
            issue_date = ${f.issueDate}, due_date = ${f.dueDate}, paid_date = ${zaplaceno ? underVs.paid_date : f.paidDate},
            amount = ${f.amount}, vat_amount = ${f.vat}, total_amount = ${f.total},
            notes = ${f.notes}, pohoda_v_evidenci = TRUE, modified_at = NOW()
          WHERE id = ${underVs.id}
        `;
      }
      byNumber.set(f.varsym, byNumber.get(f.varsym).filter(r => r !== underVs));
      pridej(f.number, { ...underVs, number: f.number, supplier: f.name, supplier_ico: f.ico, issue_date: f.issueDate, total_amount: f.total });
      stats.receivedMerged++;
      warnings.push(
        `${f.number}: sloučeno s existujícím záznamem "${underVs.number}" ` +
        `(${underVs.supplier}, ${underVs.issue_date}, ${num(underVs.total_amount)} Kč) – příloha zachována`
      );
      console.log(`  ~ ${f.number} | sloučeno se záznamem pod VS ${f.varsym}`);
      continue;
    }

    // 3) kontrolní shoda datum+částka – jen upozornění
    const fuzzy = byDateAmount.get(`${f.issueDate}|${f.total.toFixed(2)}`);
    if (fuzzy?.length) {
      warnings.push(
        `${f.number} (${f.name}, ${f.issueDate}, ${f.total} Kč): stejné datum i částka jako ` +
        fuzzy.map(r => `${r.number} (${r.supplier})`).join(', ') + ' – zkontrolovat ručně'
      );
    }

    if (podleCisla.radky.length) {
      warnings.push(`${f.number} (${f.name}): stejné číslo má i ${seznam(podleCisla.radky)}, jiné IČO, název i údaje – založeno zvlášť`);
    }

    const companyId = f.ico ? icoToCompany.get(f.ico) ?? null : null;

    if (DRY_RUN) {
      console.log(`  [nová] ${f.number} | ${f.issueDate} | ${f.name} | ${f.total} Kč | ${f.status}`);
    } else {
      await sql`
        INSERT INTO accounting_invoices
          (id, type, number, supplier_number, status, supplier, supplier_ico, supplier_dic,
           supplier_address, supplier_city, supplier_zip, supplier_country,
           crm_company_id, issue_date, due_date, paid_date,
           amount, vat_amount, total_amount, currency, notes, source, pohoda_v_evidenci, created_at, modified_at)
        VALUES (
          ${genId()}, 'received', ${f.number}, ${f.doklad}, ${f.status},
          ${f.name}, ${f.ico}, ${f.dic},
          ${f.street}, ${f.city}, ${f.zip}, 'Česká republika',
          ${companyId}, ${f.issueDate}, ${f.dueDate}, ${f.paidDate},
          ${f.amount}, ${f.vat}, ${f.total}, 'CZK', ${f.notes}, 'pohoda', TRUE, NOW(), NOW()
        )
      `;
    }

    pridej(f.number, {
      id: null, number: f.number, supplier: f.name, supplier_ico: f.ico, status: f.status,
      issue_date: f.issueDate, paid_date: f.paidDate, total_amount: f.total,
    });
    stats.received++;
  }

  console.log(`  ✓ vloženo ${stats.received}, sloučeno ${stats.receivedMerged}, přeskočeno jako duplicita ${stats.receivedSkip}`);
}

// ── Hlavní ────────────────────────────────────────────────────

console.log('=== Import faktur z POHODY ===');
if (DRY_RUN)     console.log('⚠  DRY RUN – nic se neukládá');
if (NO_MERGE)    console.log('⚠  --no-merge – shody přes VS se jen přeskočí');
if (SYNC_STATUS) console.log('★  --sync-status – u existujících faktur se srovná stav úhrady');

try {
  const today = new Date();
  const icoToCompany = new Map(
    (await sql`SELECT id, ico FROM crm_companies WHERE ico <> ''`).map(r => [r.ico, r.id])
  );
  console.log(`  Firem v CRM s IČO: ${icoToCompany.size}`);

  await importIssued(icoToCompany, today);
  await importReceived(icoToCompany, today);

  const ids = [...vPohode];
  const oznacit = await sql`SELECT id FROM accounting_invoices WHERE id = ANY(${ids}) AND NOT pohoda_v_evidenci`;
  if (!DRY_RUN) await sql`UPDATE accounting_invoices SET pohoda_v_evidenci = TRUE WHERE id = ANY(${oznacit.map(r => r.id)})`;

  if (warnings.length) {
    console.log('\n━━━ Ke kontrole ━━━');
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  console.log('\n=== Hotovo ===');
  console.log(`Vydané:   +${stats.issued} nových, ${stats.issuedSkip} duplicit přeskočeno`);
  console.log(`Přijaté:  +${stats.received} nových, ${stats.receivedMerged} sloučeno, ${stats.receivedSkip} duplicit přeskočeno`);
  console.log(`Číslo dodavatele doplněno u ${stats.dokladDoplnen} přijatých faktur`);
  console.log(`Nově označeno V POHODĚ: ${oznacit.length}`);
  console.log(`Stav úhrady: ${stats.statusDrift} rozdílů oproti POHODĚ, ${stats.statusSynced} srovnáno` +
              (stats.statusProtected ? `, ${stats.statusProtected} ponecháno podle banky` : ''));
} catch (err) {
  console.error('\n❌ Chyba:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
