/**
 * Čtečka bankovních výpisů z Fio banky (CSV export z Internetbankingu 2.0).
 *
 *   parseStatement('/cesta/Vypis_z_uctu-2800828200_...csv')
 *     → { account, currency, statementNo, dateFrom, dateTo, rows: [...] }
 *
 * Formát souboru:
 *   - UTF-8 s BOM, CRLF, oddělovač `;`, hodnoty v dvojitých uvozovkách
 *   - 8 řádků hlavičky (účet, majitel, období, stavy, sumy), prázdný řádek,
 *     řádek s názvy sloupců, pak transakce
 *   - čísla mají desetinnou čárku, data ve formátu DD.MM.RRRR
 *
 * Pozor: hlavička obsahuje "Poznámka" dvakrát (banková poznámka a uživatelská
 * identifikace), proto se sloupce hledají podle pořadí výskytu, ne podle názvu.
 */

import fs from 'node:fs';

// ── CSV ───────────────────────────────────────────────────────

/** Rozdělí řádek CSV na hodnoty; respektuje uvozovky a zdvojené "" uvnitř. */
export function splitCsvLine(line, delim = ';') {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map(v => v.trim());
}

// ── Hodnoty ───────────────────────────────────────────────────

/** "13.01.2026" → "2026-01-13" */
export function czDate(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** "-1 572,30" → -1572.3 */
export function czNumber(v) {
  const s = String(v ?? '').replace(/\s| /g, '').replace(',', '.');
  if (!s) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** Číslo účtu do jednotné podoby pro porovnávání: jen číslice a lomítko. */
export function normalizeAccount(v) {
  return String(v ?? '').replace(/\s/g, '').replace(/^0+(?=\d)/, '');
}

// ── Hlavička ──────────────────────────────────────────────────

/** Index n-tého výskytu sloupce daného názvu (0 = první). */
function colAt(header, name, occurrence = 0) {
  let seen = 0;
  for (let i = 0; i < header.length; i++) {
    if (header[i] === name) {
      if (seen === occurrence) return i;
      seen++;
    }
  }
  return -1;
}

const REQUIRED = ['ID operace', 'Datum', 'Objem', 'Měna', 'VS'];

// ── Veřejné API ───────────────────────────────────────────────

/**
 * Načte výpis ze souboru. Vyhodí chybu, pokud soubor nemá očekávanou
 * strukturu — u účetních dat je lepší spadnout než naimportovat nesmysl.
 */
export function parseStatement(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);

  const headerIdx = lines.findIndex(l => l.startsWith('"ID operace"'));
  if (headerIdx < 0) throw new Error('nenalezen řádek s názvy sloupců ("ID operace")');

  const header = splitCsvLine(lines[headerIdx]);
  const missing = REQUIRED.filter(n => colAt(header, n) < 0);
  if (missing.length) throw new Error(`chybí sloupce: ${missing.join(', ')}`);

  // Metadata z úvodních řádků
  const meta = lines.slice(0, headerIdx).join('\n');
  const account     = meta.match(/z\s+účtu\s+""([^"]+)""/)?.[1] ?? null;
  const statementNo = meta.match(/Výpis\s+č\.\s*([^\s]+)\s/)?.[1] ?? null;
  const period      = meta.match(/Období:\s*(\d{1,2}\.\d{1,2}\.\d{4})\s*-\s*(\d{1,2}\.\d{1,2}\.\d{4})/);
  const currency    = meta.match(/Počáteční stav účtu[^:]*:\s*[-\d\s,.]+([A-Z]{3})/)?.[1] ?? null;

  if (!account) throw new Error('nenalezeno číslo účtu v hlavičce výpisu');

  const idx = {
    id:       colAt(header, 'ID operace'),
    date:     colAt(header, 'Datum'),
    amount:   colAt(header, 'Objem'),
    currency: colAt(header, 'Měna'),
    cpAcct:   colAt(header, 'Protiúčet'),
    cpName:   colAt(header, 'Název protiúčtu'),
    bankCode: colAt(header, 'Kód banky'),
    bankName: colAt(header, 'Název banky'),
    ks:       colAt(header, 'KS'),
    vs:       colAt(header, 'VS'),
    ss:       colAt(header, 'SS'),
    note:     colAt(header, 'Poznámka', 0),
    message:  colAt(header, 'Zpráva pro příjemce'),
    type:     colAt(header, 'Typ'),
    author:   colAt(header, 'Provedl'),
    detail:   colAt(header, 'Upřesnění'),
    userNote: colAt(header, 'Poznámka', 1),
  };
  const at = (cells, i) => (i >= 0 ? (cells[i] ?? '') : '');

  const rows = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const c = splitCsvLine(line);
    const externalId = at(c, idx.id);
    const date = czDate(at(c, idx.date));
    if (!externalId || !date) continue;   // souhrnné či prázdné řádky na konci

    const raw      = czNumber(at(c, idx.amount));
    const bankCode = at(c, idx.bankCode);
    const cpAcct   = at(c, idx.cpAcct);

    rows.push({
      externalId,
      date,
      raw,
      type:     raw < 0 ? 'debit' : 'credit',
      amount:   Math.abs(raw),
      currency: at(c, idx.currency) || currency || 'CZK',
      cpAccount: cpAcct && bankCode ? `${cpAcct}/${bankCode}` : cpAcct,
      cpName:   at(c, idx.cpName),
      ks:       at(c, idx.ks),
      vs:       at(c, idx.vs),
      ss:       at(c, idx.ss),
      // Zpráva pro příjemce je u převodů, poznámka u karetních transakcí
      message:  at(c, idx.message) || at(c, idx.note) || at(c, idx.userNote),
      txType:   at(c, idx.type),
      author:   at(c, idx.author),
      detail:   at(c, idx.detail),
      bankName: at(c, idx.bankName),
    });
  }

  return {
    account,
    accountNorm: normalizeAccount(account),
    currency: currency ?? rows[0]?.currency ?? 'CZK',
    statementNo,
    dateFrom: period ? czDate(period[1]) : null,
    dateTo:   period ? czDate(period[2]) : null,
    rows,
  };
}
