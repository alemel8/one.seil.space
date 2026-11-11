/**
 * Kurzy devizového trhu ČNB pro přepočet dokladů v cizí měně na koruny.
 *
 * ## Odkud
 *
 * Roční soubor ČNB (`rok.txt?rok=2026`): jeden požadavek nese celý rok, takže
 * doplnění starších dokladů nepotřebuje stovky dotazů po dnech. Řádek je den
 * vyhlášení, sloupec měna; hlavička říká, za kolik jednotek kurz je
 * („100 JPY“). Když ČNB během roku změní seznam měn, objeví se uprostřed
 * souboru nová hlavička, proto se čte každá.
 *
 * ## Kdy
 *
 * ČNB vyhlašuje v pracovní dny po 14:30. Plánovač se dívá každých 30 minut
 * a stáhne letošní rok, jen když už mohl přibýt den, který v databázi chybí.
 * Svátky nezná: když vyhlášení nepřijde, zkusí to ještě ten den jednou za
 * hodinu a pak počká na další pracovní den. Uzavřený rok se stáhne jednou.
 *
 * ## Co s tím
 *
 * Přepočet dělá databáze (castka_czk v migrations/049_kurzy_cnb.sql) při
 * každém dotazu, na doklady se nic nezapisuje. Doklad, ke kterému kurz ještě
 * nebyl, se tak opraví sám, jakmile se kurz stáhne.
 */

import { getDb } from './db.js';
import { jenDatum, pridejDny, prazskyCas } from './prazsky-cas.js';

export const URL_ROK =
  'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/rok.txt';

const HODINA = 60 * 60_000;
const PAUZA_PO_CHYBE = 15 * 60_000;
// Doklad s nesmyslným datem (model přečte „0225“ místo „2025“) nesmí spustit
// stahování desítek let.
const NEJVIC_LET_ZPET = 15;

/**
 * Roční soubor ČNB → [{ mena, datum: 'YYYY-MM-DD', kurz: '24.380000' }].
 * Kurz je za 1 jednotku a jako řetězec, ať se do NUMERIC nedostane
 * zaokrouhlovací chyba z dělení stem.
 */
export function parseRocniKurzy(text) {
  const radky = [];
  let sloupce = null;
  for (const radek of String(text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const bunky = radek.trim().split('|');
    if (bunky[0] === 'Datum') {
      sloupce = bunky.slice(1).map(h => {
        const m = h.trim().match(/^(\d+)\s+([A-Z]{3})$/);
        return m ? { mnozstvi: Number(m[1]), mena: m[2] } : null;
      });
      continue;
    }
    const den = bunky[0].match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!den || !sloupce) continue;
    const datum = jenDatum(`${den[3]}-${den[2]}-${den[1]}`);
    if (!datum) continue;
    bunky.slice(1).forEach((bunka, i) => {
      const sloupec = sloupce[i];
      const kurz = Number(bunka.trim().replace(/\s/g, '').replace(',', '.'));
      if (!sloupec?.mnozstvi || !(kurz > 0)) return;
      radky.push({ mena: sloupec.mena, datum, kurz: (kurz / sloupec.mnozstvi).toFixed(6) });
    });
  }
  return radky;
}

/** Pražské „YYYY-MM-DD HH:MM“, ať se dá okamžik porovnat s „den 14:30“. */
function razitko(okamzik) {
  const { datum, hodina, minuta } = prazskyCas(new Date(okamzik));
  return `${datum} ${String(hodina).padStart(2, '0')}:${String(minuta).padStart(2, '0')}`;
}

/**
 * Poslední pracovní den, jehož kurz už ČNB měla vyhlásit: dnes po 14:30,
 * jinak předchozí pracovní den. Svátky nezná (viz hlavička).
 */
export function ocekavanyDen(now = new Date()) {
  const { datum, den, hodina, minuta } = prazskyCas(now);
  if (den <= 5 && hodina * 60 + minuta >= 14 * 60 + 30) return datum;
  let d = datum, dvt = den;
  do {
    d = pridejDny(d, -1);
    dvt = dvt === 1 ? 7 : dvt - 1;
  } while (dvt > 5);
  return d;
}

/** Je potřeba rok stáhnout? `zaznam` je řádek kurzy_cnb_stazeni, nebo nic. */
export function potrebujeStahnout(zaznam, rok, now = new Date()) {
  const letos = Number(prazskyCas(now).datum.slice(0, 4));
  if (rok > letos) return false;
  if (!zaznam) return true;
  const stazeno = razitko(zaznam.stazeno_at);
  // Uzavřený rok: stačí jedno stažení po jeho konci.
  if (rok < letos) return stazeno < `${rok + 1}-01-01`;

  const ocekavany = ocekavanyDen(now);
  const posledni = jenDatum(zaznam.posledni_datum);
  if (posledni && posledni >= ocekavany) return false;
  if (stazeno < `${ocekavany} 14:30`) return true;
  // Po vyhlášení už se stahovalo a den nepřibyl: zpoždění, nebo svátek.
  // Ještě ten den jednou za hodinu, pak až po dalším vyhlášení.
  return prazskyCas(now).datum === ocekavany && now - new Date(zaznam.stazeno_at) >= HODINA;
}

/**
 * Roky, pro které je potřeba mít kurzy: od nejstaršího dokladu v cizí měně
 * po letošek. Letošek vždycky, ať je kurz po ruce, až cizí doklad přijde.
 * Doklad z prvních dní ledna bere kurz z konce prosince, proto i rok před ním.
 */
export async function potrebneRoky(sql, now = new Date()) {
  const [{ od }] = await sql`
    SELECT MIN(d) AS od FROM (
      SELECT MIN(COALESCE(taxable_date, issue_date)) AS d FROM accounting_invoices WHERE mena_kod(currency) <> 'CZK'
      UNION ALL SELECT MIN(receipt_date)     FROM receipts                     WHERE mena_kod(currency) <> 'CZK'
      UNION ALL SELECT MIN(paid_on)          FROM hr_payroll_items             WHERE mena_kod(currency) <> 'CZK'
      UNION ALL SELECT MIN(transaction_date) FROM accounting_bank_transactions WHERE mena_kod(currency) <> 'CZK'
    ) s
  `;
  const letos = Number(prazskyCas(now).datum.slice(0, 4));
  const nejstarsi = jenDatum(od);
  let prvni = letos;
  if (nejstarsi) {
    const rok = Number(nejstarsi.slice(0, 4));
    prvni = Math.min(letos, nejstarsi.slice(5) <= '01-14' ? rok - 1 : rok);
  }
  prvni = Math.max(prvni, letos - NEJVIC_LET_ZPET);
  const roky = [];
  for (let r = prvni; r <= letos; r++) roky.push(r);
  return roky;
}

export async function stahniRok(rok, fetchImpl = fetch) {
  const res = await fetchImpl(`${URL_ROK}?rok=${rok}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ČNB odpověděla ${res.status} na kurzy roku ${rok}`);
  return parseRocniKurzy(await res.text());
}

async function ulozRok(sql, rok, radky, now) {
  const posledni = radky.reduce((max, r) => (r.datum > max ? r.datum : max), '') || null;
  await sql.begin(async tx => {
    for (let i = 0; i < radky.length; i += 2000) {
      await tx`
        INSERT INTO kurzy_cnb ${tx(radky.slice(i, i + 2000), 'mena', 'datum', 'kurz')}
        ON CONFLICT (mena, datum) DO UPDATE SET kurz = EXCLUDED.kurz
      `;
    }
    await tx`
      INSERT INTO kurzy_cnb_stazeni (rok, stazeno_at, posledni_datum)
      VALUES (${rok}, ${now}, ${posledni})
      ON CONFLICT (rok) DO UPDATE SET stazeno_at = EXCLUDED.stazeno_at, posledni_datum = EXCLUDED.posledni_datum
    `;
  });
}

let bezi = false;
const posledniChyba = new Map();

/**
 * Stáhne roky, kterým může chybět kurz. Vrací { stazeno: [roky] }.
 * Chyba jednoho roku se zaloguje a zkusí se znovu za čtvrt hodiny; přehledy
 * mezitím počítají s tím, co v databázi je.
 */
export async function aktualizujKurzy(sql = getDb(), { now = new Date(), fetchImpl = fetch, log } = {}) {
  if (bezi) return { stazeno: [] };
  bezi = true;
  try {
    const letos = Number(prazskyCas(now).datum.slice(0, 4));
    const roky = await potrebneRoky(sql, now);
    const zaznamy = new Map(
      (await sql`SELECT rok, stazeno_at, posledni_datum FROM kurzy_cnb_stazeni WHERE rok = ANY(${roky})`)
        .map(z => [z.rok, z]),
    );
    const stazeno = [];
    for (const rok of roky) {
      if (!potrebujeStahnout(zaznamy.get(rok), rok, now)) continue;
      if (now - (posledniChyba.get(rok) ?? 0) < PAUZA_PO_CHYBE) continue;
      try {
        const radky = await stahniRok(rok, fetchImpl);
        // Letošní soubor může být v prvních dnech ledna prázdný, uzavřený ne:
        // prázdná odpověď by ho jinak označila za stažený navždy.
        if (!radky.length && rok < letos) throw new Error(`ČNB vrátila prázdné kurzy roku ${rok}`);
        await ulozRok(sql, rok, radky, now);
        posledniChyba.delete(rok);
        stazeno.push(rok);
      } catch (err) {
        posledniChyba.set(rok, now);
        log?.warn?.({ err, rok }, 'Kurzy ČNB se nepodařilo stáhnout');
      }
    }
    if (stazeno.length) log?.info?.({ roky: stazeno }, 'Kurzy ČNB staženy');
    return { stazeno };
  } finally {
    bezi = false;
  }
}

export function startKurzyScheduler(log) {
  const tik = () => aktualizujKurzy(getDb(), { log }).catch(err => log?.error?.({ err }, 'kurzy ČNB tick error'));
  setTimeout(tik, 30_000);
  setInterval(tik, 30 * 60_000);
}
