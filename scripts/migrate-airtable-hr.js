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
 *   --z-souboru=DIR     čte záznamy z DIR/<tabulka>.json místo z API. Slouží
 *                       k běhu bez tokenu — data se vyexportují jinudy.
 *                       Odkazy na přílohy v exportu platí jen dvě hodiny,
 *                       takže se musí migrovat hned po něm.
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
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
const ZE_SOUBORU = (process.argv.find(a => a.startsWith('--z-souboru=')) || '').slice(12);

const BASE_TROJEK = process.env.AIRTABLE_BASE_TROJEK || 'appnJF71iCU3ymc5N';
const BASE_SEIL   = process.env.AIRTABLE_BASE_SEIL   || 'appBpZ7LP2SvW7tHe';

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 3,
});

const stat = { radky: 0, preskoceno: 0, soubory: 0, souboryPreskoceno: 0, chyby: 0 };

/**
 * Záznamy tabulky — buď z API, nebo z předem vyexportovaného souboru.
 * Soubor má tvar odpovědi Airtable: { records: [...] }.
 */
async function* ctiZaznamy(tableId, nazev, baseId = BASE_TROJEK) {
  if (!ZE_SOUBORU) { yield* zaznamy(baseId, tableId); return; }
  const soubor = path.join(ZE_SOUBORU, `${nazev}.json`);
  let data;
  try {
    data = JSON.parse(readFileSync(soubor, 'utf8'));
  } catch (err) {
    throw new Error(`Export ${soubor} nejde přečíst: ${err.message}`);
  }
  const zaznamu = data.records ?? data;
  console.log(`  Ze souboru ${nazev}.json: ${zaznamu.length} záznamů`);
  yield* zaznamu;
}
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
      const buf = await stahniPrilohu(p, { ...zdroj, bezObnovy: Boolean(ZE_SOUBORU) });
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

  for await (const rec of ctiZaznamy(TABULKY.podklady, 'podklady')) {
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
  for await (const rec of ctiZaznamy(TABULKY.mzdy, 'mzdy')) {
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
  for await (const rec of ctiZaznamy(TABULKY.extra, 'extra')) {
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
  for await (const rec of ctiZaznamy(TABULKY.dokumenty, 'dokumenty')) {
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

// ── Heřík: úkoly, měření času a mzdy ─────────────────────────

/** Mapa Airtable uživatelů na uživatele v systému (podle e-mailu). */
async function mapaUzivatelu() {
  const podleEmailu = new Map((await sql`SELECT id, LOWER(email) AS email FROM users`)
    .map(u => [u.email, u.id]));
  const mapa = new Map();
  for await (const rec of ctiZaznamy(TABULKY.users, 'users', BASE_SEIL)) {
    const u = mapujUzivatele(rec);
    const id = podleEmailu.get(u.email);
    if (id) mapa.set(u.airtableId, { id, email: u.email, hourlyRate: u.hourlyRate });
    else varovani.push(`uživatel ${u.email || u.airtableId} v systému není — jeho záznamy zůstanou bez vazby`);
  }
  return mapa;
}

async function fazeUkoly(lide) {
  console.log('\n━━━ Úkoly ━━━');
  // Všechny úkoly jsou pro jednoho klienta (GrapeNet). Kdyby v CRM nebyl,
  // úkoly se naimportují bez vazby — je to popisný údaj, ne účetní.
  const [klient] = await sql`
    SELECT id FROM crm_companies WHERE LOWER(name) LIKE 'grapenet%' LIMIT 1`;
  if (!klient) varovani.push('GrapeNet není v CRM — úkoly zůstanou bez vazby na firmu');
  const airtableNaId = new Map();
  const hierarchie = [];

  for await (const rec of ctiZaznamy(TABULKY.tasks, 'tasks', BASE_SEIL)) {
    const u = mapujUkol(rec);
    const [uz] = DRY ? [] : await sql`SELECT id FROM tasks WHERE airtable_id = ${u.airtableId}`;
    if (uz) { airtableNaId.set(u.airtableId, uz.id); stat.preskoceno++; continue; }

    // Mapa i hierarchie se plní i nasucho — jinak by dry run tvrdil, že
    // žádné měření nemá úkol a žádný úkol nemá nadřazený.
    const id = genId();
    airtableNaId.set(u.airtableId, id);
    if (u.nadrazenyAirtableId) hierarchie.push([id, u.nadrazenyAirtableId]);
    if (DRY) { stat.radky++; continue; }

    await sql`
      INSERT INTO tasks (id, seq, code, summary, description, kind, status, priority,
                         priority_label, company_id, start_date, due_date, done_at,
                         assignee_id, author_id, airtable_id)
      VALUES (${id}, ${u.seq}, ${u.code}, ${u.summary}, ${u.description}, ${u.kind},
              ${u.status}, ${u.priority}, ${u.priorityLabel},
              ${u.klientAirtableId ? klient?.id ?? null : null},
              ${u.startDate}, ${u.dueDate}, ${u.doneAt},
              ${lide.get(u.resitelAirtableId)?.id ?? null},
              ${lide.get(u.autorAirtableId)?.id ?? null}, ${u.airtableId})
    `;
    stat.radky++;
    await ulozPrilohy('task_id', id, u.prilohy,
      { baseId: BASE_SEIL, tableId: TABULKY.tasks, recordId: u.airtableId,
        fieldId: POLE.task.priloha });
  }

  // Nadřazené úkoly až druhým průchodem — záznamy nechodí topologicky
  let navazano = 0;
  for (const [id, rodicAirtable] of hierarchie) {
    const rodic = airtableNaId.get(rodicAirtable);
    if (!rodic || rodic === id) { varovani.push(`úkol ${id}: nadřazený ${rodicAirtable} nenalezen`); continue; }
    if (!DRY) await sql`UPDATE tasks SET parent_id = ${rodic} WHERE id = ${id}`;
    navazano++;
  }
  console.log(`  ✓ ${stat.radky} úkolů, ${navazano} navázáno na nadřazený`);
  return airtableNaId;
}

async function fazeCas(lide, ukolyMapa) {
  console.log('\n━━━ Měření času ━━━');
  let bezUkolu = 0, bezUzivatele = 0, n = 0;
  for await (const rec of ctiZaznamy(TABULKY.timetracker, 'timetracker', BASE_SEIL)) {
    const m = mapujMereni(rec);
    if (!m.startedAt) { varovani.push(`měření ${m.airtableId}: chybí začátek`); continue; }
    const uzivatel = lide.get(m.uzivatelAirtableId);
    if (!uzivatel) { bezUzivatele++; continue; }
    // Databáze nepustí konec před začátkem. Radši to nahlásit než tiše
    // prohodit — obrácený záznam znamená, že v Airtable je něco špatně.
    if (m.endedAt && m.endedAt < m.startedAt) {
      varovani.push(`měření ${m.airtableId}: konec ${m.endedAt} je před začátkem ${m.startedAt}, přeskočeno`);
      continue;
    }
    if (!DRY && !(await jeNovy('time_entries', m.airtableId))) continue;
    const taskId = ukolyMapa.get(m.ukolAirtableId) ?? null;
    if (!taskId) bezUkolu++;

    if (!DRY) {
      await sql`
        INSERT INTO time_entries (user_id, task_id, kind, started_at, ended_at,
                                  source, hourly_rate, airtable_id)
        VALUES (${uzivatel.id}, ${taskId}, ${m.kind}, ${m.startedAt}, ${m.endedAt},
                'import', ${uzivatel.hourlyRate}, ${m.airtableId})
      `;
    }
    stat.radky++; n++;
  }
  console.log(`  ✓ ${n} měření` + (bezUkolu ? `, ${bezUkolu} bez úkolu` : '')
    + (bezUzivatele ? `, ${bezUzivatele} přeskočeno (neznámý uživatel)` : ''));
}

async function fazePayroll(lide) {
  console.log('\n━━━ Mzdy z dohody ━━━');
  let mezd = 0, nakupu = 0;
  for await (const rec of ctiZaznamy(TABULKY.payroll, 'payroll', BASE_SEIL)) {
    const r = mapujPayroll(rec);
    const uzivatel = lide.get(r.uzivatelAirtableId);
    if (!uzivatel) { varovani.push(`payroll ${r.airtableId}: neznámý zaměstnanec`); continue; }
    if (r.druh === 'prazdny') { varovani.push(`payroll ${r.airtableId}: prázdný řádek, přeskočeno`); continue; }
    if (!r.period) { varovani.push(`payroll ${r.airtableId}: chybí měsíc`); continue; }

    const tabulka = r.druh === 'naklad' ? 'hr_payroll_items' : 'hr_payroll_runs';
    if (!DRY && !(await jeNovy(tabulka, r.airtableId))) continue;

    if (DRY) {
      console.log(`  [${r.druh === 'naklad' ? 'nákup' : 'mzda '}] ${r.period}`
        + (r.druh === 'naklad' ? ` | ${kc(r.amount)} Kč | ${r.description}`
           : ` | ${r.hours ?? 0} h | odměna ${kc(r.earned ?? 0)} | hrubá ${kc(r.gross)}`));
      stat.radky++; r.druh === 'naklad' ? nakupu++ : mezd++; continue;
    }

    const id = genId();
    if (r.druh === 'naklad') {
      // Proplacený nákup není mzda — Airtable to mísil v jedné tabulce
      await sql`
        INSERT INTO hr_payroll_items (id, user_id, kind, paid_on, period, amount,
                                      description, airtable_id)
        VALUES (${id}, ${uzivatel.id}, 'proplaceny_naklad', ${r.period}, ${r.period},
                ${r.amount}, ${r.description}, ${r.airtableId})
      `;
      await ulozPrilohy('payroll_item_id', id, r.prilohy,
        { baseId: BASE_SEIL, tableId: TABULKY.payroll, recordId: r.airtableId,
          fieldId: POLE.payroll.prilohy });
      nakupu++;
    } else {
      // U dohody účetní žádné srážky neevidovala, takže čistá = hrubá.
      // Náklad firmy je to, co reálně odešlo: mzdový list plus hotovost.
      await sql`
        INSERT INTO hr_payroll_runs (id, user_id, period, hours, hourly_rate, earned,
                                     gross, net, cash_paid, company_cost, paid,
                                     notes, airtable_id)
        VALUES (${id}, ${uzivatel.id}, ${r.period}, ${r.hours}, ${r.hourlyRate}, ${r.earned},
                ${r.gross}, ${r.gross}, ${r.cashPaid}, ${r.gross + r.cashPaid}, TRUE,
                ${r.poznamka}, ${r.airtableId})
      `;
      await ulozPrilohy('payroll_run_id', id, r.prilohy,
        { baseId: BASE_SEIL, tableId: TABULKY.payroll, recordId: r.airtableId,
          fieldId: POLE.payroll.prilohy });
      mezd++;
    }
    stat.radky++;
  }
  console.log(`  ✓ ${mezd} mzdových listů, ${nakupu} proplacených nákupů`);
}

// ── ověření ───────────────────────────────────────────────────

async function overit() {
  // Součty musí být vázané na člověka. Dokud v tabulkách seděl jediný
  // zaměstnanec, stačil SUM přes celou tabulku; jakmile přibyl druhý,
  // začal by globální součet hlásit chybu i u bezvadné migrace.
  const [trojek] = TROJEK_EMAIL
    ? await sql`SELECT id FROM users WHERE LOWER(email) = ${TROJEK_EMAIL.toLowerCase()}`
    : [];
  const [herik] = await sql`SELECT id FROM users WHERE LOWER(email) = 'lukas@seil.cz'`;

  const radek = (nazev, je, ma, pocet, maPocet) => {
    const ok = Math.abs(je - ma) < 0.01 && (maPocet == null || pocet === maPocet);
    if (!ok) process.exitCode = 1;
    console.log(`  ${ok ? '✓' : '✗'} ${nazev.padEnd(16)} ${kc(je).padStart(14)}`
      + (maPocet != null ? `  (${pocet}/${maPocet} záznamů)` : '')
      + (ok ? '' : `   ČEKÁNO ${kc(ma)}`));
  };

  if (trojek) {
    console.log('\n━━━ Kontrolní součty — Trojek ━━━');
    const [[p], [m], [e]] = await Promise.all([
      sql`SELECT COUNT(*)::int n, COALESCE(SUM(total_amount),0)::float8 v
            FROM hr_work_reports  WHERE user_id = ${trojek.id}`,
      sql`SELECT COUNT(*)::int n, COALESCE(SUM(paid_total),0)::float8 v
            FROM hr_payroll_runs  WHERE user_id = ${trojek.id}`,
      sql`SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::float8 v
            FROM hr_payroll_items WHERE user_id = ${trojek.id}`,
    ]);
    radek('Příjmy',       p.v, 1488721.70, p.n, 31);
    radek('Výdaje',       m.v, 1036044,    m.n, 27);
    radek('Extra výdaje', e.v,  433045.47, e.n, 27);
    radek('Zůstatek', p.v - m.v - e.v, 19632.23);
  }

  if (herik) {
    console.log('\n━━━ Kontrolní součty — Heřík ━━━');
    const [[mzdy], [nakupy], [cas], [ukoly]] = await Promise.all([
      sql`SELECT COUNT(*)::int n,
                 COALESCE(SUM(hours),0)::float8     hodiny,
                 COALESCE(SUM(earned),0)::float8    odmena,
                 COALESCE(SUM(gross),0)::float8     hruba,
                 COALESCE(SUM(cash_paid),0)::float8 hotovost
            FROM hr_payroll_runs WHERE user_id = ${herik.id}`,
      sql`SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::float8 v
            FROM hr_payroll_items WHERE user_id = ${herik.id} AND kind = 'proplaceny_naklad'`,
      sql`SELECT COUNT(*)::int n FROM time_entries WHERE user_id = ${herik.id}`,
      sql`SELECT COUNT(*)::int n FROM tasks WHERE airtable_id IS NOT NULL`,
    ]);
    radek('Odpracováno h',  mzdy.hodiny,   434.95,  mzdy.n, 16);
    radek('Odměna',         mzdy.odmena,   217475);
    radek('Hrubá mzda',     mzdy.hruba,    136800);
    radek('Hotovost',       mzdy.hotovost,  83500);
    radek('Nákupy',         nakupy.v,     29310.78, nakupy.n, 8);
    // Hodiny ve mzdách vědomě nesedí s naměřeným časem (chybí 5/2025–7/2025
    // a naopak 4–6/2026 není vyúčtované). Kontroluje se počet, ne rovnost.
    console.log(`  · měření času: ${cas.n} záznamů`
      + (cas.n === 366 ? ' ✓' : '   ČEKÁNO 366'));
    if (cas.n !== 366) process.exitCode = 1;
    console.log(`  · úkolů z Airtable: ${ukoly.n}`
      + (ukoly.n === 467 ? ' ✓' : '   ČEKÁNO 467'));
    if (ukoly.n !== 467) process.exitCode = 1;
  }

  // Dva řádky nad jedním souborem by znamenaly, že mazání jednoho z nich
  // utrhne přílohu tomu druhému.
  const [[pril], [dvojity]] = await Promise.all([
    sql`SELECT COUNT(*)::int n FROM attachments`,
    sql`SELECT COUNT(*)::int n FROM (
          SELECT path FROM attachments GROUP BY path HAVING COUNT(*) > 1) x`,
  ]);
  console.log(`\n  příloh v systému: ${pril.n}`);
  if (dvojity.n) { process.exitCode = 1; console.log(`  ✗ ${dvojity.n} souborů sdílí víc řádků`); }
}

// ── běh ───────────────────────────────────────────────────────

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL není nastavená');
  console.log(`=== Migrace z Airtable ===${DRY ? '  ⚠ DRY RUN — nic se neukládá' : ''}`);

  if (OVERIT) { await overit(); }
  else {
    if (!ZE_SOUBORU && !jeNastaveno()) {
      throw new Error(
        'Chybí AIRTABLE_API_KEY v .env. Vytvoř Personal Access Token na\n' +
        '   https://airtable.com/create/tokens\n' +
        '   s právem data.records:read a přístupem k oběma základnám.'
      );
    }
    // Základna Trojek — e-mail je potřeba jen pro její fáze; Heříkovy fáze
    // si uživatele najdou samy podle tabulky Users v základně SEIL.
    const trojkovyFaze = ['podklady', 'mzdy', 'extra', 'dokumenty'].filter(delam);
    if (trojkovyFaze.length) {
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
    }

    // Základna SEIL — Heřík: úkoly, měření času a mzdy z dohody
    if (delam('ukoly') || delam('cas') || delam('payroll')) {
      const lide = await mapaUzivatelu();
      const ukolyMapa = delam('ukoly') ? await fazeUkoly(lide) : new Map(
        (await sql`SELECT id, airtable_id FROM tasks WHERE airtable_id IS NOT NULL`)
          .map(t => [t.airtable_id, t.id])
      );
      if (delam('cas'))     await fazeCas(lide, ukolyMapa);
      if (delam('payroll')) await fazePayroll(lide);
    }

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
