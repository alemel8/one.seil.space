/**
 * Přenos personální a fakturační agendy z Airtable do One SEIL.
 *
 * Spuštění (.env si skript načte sám):
 *   node scripts/migrate-airtable-hr.js --dry-run
 *   node scripts/migrate-airtable-hr.js
 *   node scripts/migrate-airtable-hr.js --overit
 *
 * Přepínače:
 *   --dry-run           nic neuloží ani nestáhne, jen vypíše, co by vzniklo
 *   --jen=a,b           jen vybrané fáze (podklady, mzdy, extra, dokumenty,
 *                       ukoly, cas, payroll)
 *   --bez-priloh        naimportuje řádky, soubory vynechá (rychlé ladění)
 *   --overit            jen kontrolní součty proti Airtable, nic nezapisuje
 *   --trojek=<email>    komu patří základna Trojek (jinak AIRTABLE_TROJEK_EMAIL)
 *
 * KDE TO POUŠTĚT: v kontejneru, ne lokálně přes tunel. Soubory musí přistát
 * na persistent volume /app/data — při lokálním běhu by databáze měla stovky
 * řádků a disk nula souborů a checkAttachments() by při startu hlásil, že
 * chybí všechno.
 *
 * IDEMPOTENCE: každý řádek nese airtable_id s částečným unikátním indexem,
 * každý soubor taky. Opakovaný běh tedy nic nezdvojí a nestahuje znovu.
 */

import './lib/load-env.js';
import postgres from 'postgres';
import { jeNastaveno, zaznamy, stahniPrilohu } from './lib/airtable.js';
import {
  TABULKY, POLE, mapujPodklad, mapujMzdu, mapujExtraVydaj, mapujDokument,
  mapujUkol, mapujMereni, mapujPayroll, mapujUzivatele, kontrolaUhrazeno,
} from '../src/airtable-map.js';
import { saveAttachment } from '../src/attachments.js';
import { createHash } from 'node:crypto';

const DRY      = process.argv.includes('--dry-run');
const OVERIT   = process.argv.includes('--overit');
const BEZ_PRIL = process.argv.includes('--bez-priloh');
const JEN = (process.argv.find(a => a.startsWith('--jen=')) || '').slice(6)
  .split(',').filter(Boolean);
const TROJEK_EMAIL = (process.argv.find(a => a.startsWith('--trojek=')) || '').slice(9)
  || process.env.AIRTABLE_TROJEK_EMAIL || '';

const BASE_TROJEK = process.env.AIRTABLE_BASE_TROJEK || 'appnJF71iCU3ymc5N';
const BASE_SEIL   = process.env.AIRTABLE_BASE_SEIL   || 'appBpZ7LP2SvW7tHe';

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 3,
});

const stat = { radky: 0, preskoceno: 0, soubory: 0, souboryPreskoceno: 0, chyby: 0 };
const varovani = [];
const delam = f => !JEN.length || JEN.includes(f);
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const kc = n => Number(n).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── přílohy ───────────────────────────────────────────────────

async function ulozPrilohy(vlastnik, id, seznam, zdroj) {
  if (BEZ_PRIL || DRY) return;
  for (const p of seznam) {
    const [uz] = await sql`SELECT 1 FROM attachments WHERE airtable_id = ${p.airtableId}`;
    if (uz) { stat.souboryPreskoceno++; continue; }
    try {
      const buf = await stahniPrilohu(p, zdroj);
      // Nejdřív na disk, pak do databáze. Osiřelý soubor nikoho nebolí,
      // řádek bez souboru je doklad, který nejde otevřít.
      const saved = await saveAttachment(buf, p.mime, 'airtable', { archive: true });
      await sql`
        INSERT INTO attachments (path, original_name, mime, size, sha256, category,
                                 sort_order, ${sql(vlastnik)}, airtable_id)
        VALUES (${saved.filename}, ${p.filename}, ${saved.mime}, ${saved.size},
                ${createHash('sha256').update(buf).digest('hex')}, ${p.kategorie},
                ${p.poradi}, ${id}, ${p.airtableId})
      `;
      stat.soubory++;
    } catch (err) {
      stat.chyby++;
      varovani.push(`příloha ${p.filename}: ${err.message}`);
    }
  }
}

/** Přeskočí záznam, který už v cíli je. Vrací true, když se má pokračovat. */
async function jeNovy(tabulka, airtableId) {
  const [uz] = await sql`SELECT id FROM ${sql(tabulka)} WHERE airtable_id = ${airtableId}`;
  if (uz) { stat.preskoceno++; return null; }
  return true;
}

// ── fáze ──────────────────────────────────────────────────────

async function fazePodklady(userId) {
  console.log('\n━━━ Fakturační podklady ━━━');
  // Číslo faktury → id, ať se podklad naváže na doklad, který už v systému je
  const faktury = new Map((await sql`
    SELECT id, number FROM accounting_invoices WHERE type = 'issued' AND number <> ''
  `).map(r => [r.number, r.id]));

  for await (const rec of zaznamy(BASE_TROJEK, TABULKY.podklady)) {
    const p = mapujPodklad(rec);
    if (!DRY && !(await jeNovy('hr_work_reports', p.airtableId))) continue;

    const invoiceId = p.invoiceNumber ? faktury.get(p.invoiceNumber) ?? null : null;
    if (p.invoiceNumber && !invoiceId) {
      varovani.push(`podklad ${p.title}: faktura ${p.invoiceNumber} není v systému — PDF se archivuje`);
    }

    if (DRY) {
      console.log(`  [nový] ${p.reportDate} | ${p.projekty.join('/')} | ${kc(p.totalAmount)} Kč`
        + ` | faktura ${p.invoiceNumber}${invoiceId ? '' : ' (nenalezena)'} | ${p.prilohy.length} příloh`);
      stat.radky++; continue;
    }

    const id = genId();
    await sql.begin(async tx => {
      await tx`
        INSERT INTO hr_work_reports (id, user_id, report_date, title, breakdown,
                                     total_amount, status, invoice_id, invoice_number, airtable_id)
        VALUES (${id}, ${userId}, ${p.reportDate}, ${p.title}, ${p.breakdown},
                ${p.totalAmount}, ${p.status}, ${invoiceId}, ${p.invoiceNumber}, ${p.airtableId})
      `;
      for (const kod of p.projekty) {
        await tx`INSERT INTO hr_work_report_projects (report_id, project_code)
                 VALUES (${id}, ${kod}) ON CONFLICT DO NOTHING`;
      }
      for (const l of p.lokality) {
        await tx`INSERT INTO hr_work_report_locations (report_id, city, country)
                 VALUES (${id}, ${l.city}, ${l.country}) ON CONFLICT DO NOTHING`;
      }
    });
    stat.radky++;

    await ulozPrilohy('work_report_id', id, p.prilohy,
      { baseId: BASE_TROJEK, tableId: TABULKY.podklady, recordId: p.airtableId,
        fieldId: POLE.podklad.rozpisPrace });
    // PDF faktury archivujeme jen tam, kde se doklad v systému nenašel —
    // jinak by systém držel dvě kopie téhož.
    if (!invoiceId && p.fakturaPriloha) {
      await ulozPrilohy('work_report_id', id, [p.fakturaPriloha],
        { baseId: BASE_TROJEK, tableId: TABULKY.podklady, recordId: p.airtableId,
          fieldId: POLE.podklad.faktura });
    }
    console.log(`  + ${p.reportDate} | ${p.projekty.join('/') || '—'} | ${kc(p.totalAmount)} Kč`);
  }
}

async function fazeMzdy(userId, employmentId) {
  console.log('\n━━━ Mzdový rozpis ━━━');
  for await (const rec of zaznamy(BASE_TROJEK, TABULKY.mzdy)) {
    const m = mapujMzdu(rec);
    if (!m.period) { varovani.push(`mzda ${m.airtableId}: nečitelný měsíc, přeskočeno`); continue; }

    const k = kontrolaUhrazeno(m);
    if (!k.sedi) {
      varovani.push(`mzda ${m.period}: dopočet uhrazeno ${kc(k.dopocet)} ≠ Airtable ${kc(m.uhrazenoAirtable)}`);
    }
    if (!DRY && !(await jeNovy('hr_payroll_runs', m.airtableId))) continue;

    if (DRY) {
      console.log(`  [nová] ${m.period} | hrubá ${kc(m.gross)} | uhrazeno ${kc(k.dopocet)}`
        + ` | náklad firmy ${kc(m.companyCost)} | ${m.prilohy.length} příloh`);
      stat.radky++; continue;
    }

    const id = genId();
    await sql`
      INSERT INTO hr_payroll_runs (id, user_id, employment_id, period, gross, net, social,
                                   health, tax, insolvency, garnishment, accident_insurance,
                                   company_cost, paid, paid_on, airtable_id)
      VALUES (${id}, ${userId}, ${employmentId}, ${m.period}, ${m.gross}, ${m.net}, ${m.social},
              ${m.health}, ${m.tax}, ${m.insolvency}, ${m.garnishment}, ${m.accidentInsurance},
              ${m.companyCost}, ${m.paid}, ${m.paidOn}, ${m.airtableId})
    `;
    stat.radky++;
    await ulozPrilohy('payroll_run_id', id, m.prilohy,
      { baseId: BASE_TROJEK, tableId: TABULKY.mzdy, recordId: m.airtableId,
        fieldId: POLE.mzda.rozpis });
    console.log(`  + ${m.period} | uhrazeno ${kc(k.dopocet)} | ${m.prilohy.length} příloh`);
  }
}

async function fazeExtra(userId) {
  console.log('\n━━━ Platby mimo mzdu ━━━');
  for await (const rec of zaznamy(BASE_TROJEK, TABULKY.extra)) {
    const v = mapujExtraVydaj(rec);
    if (!DRY && !(await jeNovy('hr_payroll_items', v.airtableId))) continue;
    if (DRY) {
      console.log(`  [nová] ${v.paidOn} | ${kc(v.amount)} Kč | ${v.description || '—'}`);
      stat.radky++; continue;
    }
    await sql`
      INSERT INTO hr_payroll_items (id, user_id, kind, paid_on, amount, description, airtable_id)
      VALUES (${genId()}, ${userId}, ${v.kind}, ${v.paidOn}, ${v.amount}, ${v.description}, ${v.airtableId})
    `;
    stat.radky++;
    console.log(`  + ${v.paidOn} | ${kc(v.amount)} Kč | ${v.description || '—'}`);
  }
}

async function fazeDokumenty(userId, employmentId) {
  console.log('\n━━━ Osobní dokumenty ━━━');
  for await (const rec of zaznamy(BASE_TROJEK, TABULKY.dokumenty)) {
    const d = mapujDokument(rec);
    if (!DRY && !(await jeNovy('hr_documents', d.airtableId))) continue;
    if (DRY) {
      console.log(`  [nový] ${d.title} | ${d.category || '—'} | ${d.prilohy.length} souborů`);
      stat.radky++; continue;
    }
    const id = genId();
    await sql`
      INSERT INTO hr_documents (id, user_id, employment_id, title, category,
                                document_date, signed, airtable_id)
      VALUES (${id}, ${userId}, ${employmentId}, ${d.title}, ${d.category},
              ${d.documentDate}, ${d.signed}, ${d.airtableId})
    `;
    stat.radky++;
    await ulozPrilohy('document_id', id, d.prilohy,
      { baseId: BASE_TROJEK, tableId: TABULKY.dokumenty, recordId: d.airtableId,
        fieldId: POLE.dokument.soubor });
    console.log(`  + ${d.title}`);
  }
}

// ── ověření ───────────────────────────────────────────────────

async function overit() {
  console.log('\n━━━ Kontrolní součty ━━━');
  const [[p], [m], [e]] = await Promise.all([
    sql`SELECT COUNT(*)::int n, COALESCE(SUM(total_amount),0)::float8 v FROM hr_work_reports`,
    sql`SELECT COUNT(*)::int n, COALESCE(SUM(paid_total),0)::float8 v FROM hr_payroll_runs`,
    sql`SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::float8 v FROM hr_payroll_items`,
  ]);
  const zustatek = p.v - m.v - e.v;
  const ceka = { prijmy: 1488721.70, vydaje: 1036044, extra: 433045.47, zustatek: 19632.23 };
  const radek = (nazev, je, ma, pocet, maPocet) => {
    const ok = Math.abs(je - ma) < 0.01 && (maPocet == null || pocet === maPocet);
    if (!ok) process.exitCode = 1;
    console.log(`  ${ok ? '✓' : '✗'} ${nazev.padEnd(14)} ${kc(je).padStart(14)}`
      + (maPocet != null ? `  (${pocet}/${maPocet} záznamů)` : '')
      + (ok ? '' : `   ČEKÁNO ${kc(ma)}`));
  };
  radek('Příjmy', p.v, ceka.prijmy, p.n, 31);
  radek('Výdaje', m.v, ceka.vydaje, m.n, 27);
  radek('Extra výdaje', e.v, ceka.extra, e.n, 27);
  radek('Zůstatek', zustatek, ceka.zustatek);

  const [[pril]] = await Promise.all([sql`SELECT COUNT(*)::int n FROM attachments`]);
  console.log(`    příloh v systému: ${pril.n}`);
}

// ── běh ───────────────────────────────────────────────────────

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL není nastavená');
  console.log(`=== Migrace z Airtable ===${DRY ? '  ⚠ DRY RUN — nic se neukládá' : ''}`);

  if (OVERIT) { await overit(); }
  else {
    if (!jeNastaveno()) {
      throw new Error(
        'Chybí AIRTABLE_API_KEY v .env. Vytvoř Personal Access Token na\n' +
        '   https://airtable.com/create/tokens\n' +
        '   s právem data.records:read a přístupem k oběma základnám.'
      );
    }
    if (!TROJEK_EMAIL) {
      throw new Error('Chybí --trojek=<email> (nebo AIRTABLE_TROJEK_EMAIL) — komu patří základna Trojek.');
    }
    const [trojek] = await sql`SELECT id FROM users WHERE LOWER(email) = ${TROJEK_EMAIL.toLowerCase()}`;
    if (!trojek) {
      throw new Error(`Uživatel ${TROJEK_EMAIL} v systému není — založ ho v /lide/tym a spusť znovu.`);
    }

    // Poměr, na který se navěsí mzdy a dokumenty
    let [uvazek] = await sql`SELECT id FROM hr_employments WHERE user_id = ${trojek.id} ORDER BY created_at LIMIT 1`;
    if (!uvazek && !DRY) {
      [uvazek] = await sql`
        INSERT INTO hr_employments (id, user_id, kind, position)
        VALUES (${genId()}, ${trojek.id}, 'hpp', 'Montážní technik') RETURNING id
      `;
    }

    if (delam('podklady'))  await fazePodklady(trojek.id);
    if (delam('mzdy'))      await fazeMzdy(trojek.id, uvazek?.id ?? null);
    if (delam('extra'))     await fazeExtra(trojek.id);
    if (delam('dokumenty')) await fazeDokumenty(trojek.id, uvazek?.id ?? null);

    if (!DRY) await overit();
  }

  console.log('\n=== Hotovo ===');
  console.log(`Řádky:   +${stat.radky} nových, ${stat.preskoceno} už bylo`);
  console.log(`Soubory: +${stat.soubory} staženo, ${stat.souboryPreskoceno} už bylo, ${stat.chyby} chyb`);
  if (varovani.length) {
    console.log(`\n━━━ Ke kontrole (${varovani.length}) ━━━`);
    for (const v of varovani.slice(0, 40)) console.log('  ! ' + v);
    if (varovani.length > 40) console.log(`  … a dalších ${varovani.length - 40}`);
  }
  if (!DRY && !OVERIT) {
    console.log('\nSoubory leží v data/media — pokud skript neběžel v kontejneru,');
    console.log('přenes je na persistent volume, jinak je systém nenajde.');
  }
} catch (err) {
  console.error('\n❌ ' + err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
