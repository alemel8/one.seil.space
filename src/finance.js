// Náklady firmy – jediné místo, kde se sčítají.
//
// Dokud šlo jen o „součet přijatých faktur", vešel se vzorec do šablony
// (prehled.ejs) a na domovskou stránku zvlášť. Se třemi zdroji by se ty
// kopie dřív nebo později rozešly a nikdo by nepoznal proč.
//
// Co do nákladů patří a co ne:
//   přijaté faktury   ano
//   účtenky           ano – dosud se nepočítaly vůbec, takže zisk byl nadhodnocený
//   mzdy              ano, ale „náklady firmy" (hrubá + odvody zaměstnavatele),
//                     ne to, co odešlo z účtu
//   zálohy zaměstnanci NE – je to pohledávka za zaměstnancem (335), ne náklad
//
// A do cashflow se nepřidává nic: mzdy i zálohy z účtu už odešly a banka
// je vidí, takže by se započítaly dvakrát.
//
// Cizí měny: doklad v EUR nebo USD se přepočítá na koruny denním kurzem ČNB
// ke dni dokladu (castka_czk v migrations/049_kurzy_cnb.sql, kurzy stahuje
// src/kurzy-cnb.js). Doklad, ke kterému kurz ještě není, se do součtu
// nepřičte – eura sečtená jako koruny jsou horší než chybějící částka –
// a ohlásí se v poli `meny`, ať přehled neříká, že je úplný.

// Částka řádku v korunách (`k.czk`) a kód jeho měny (`k.mena`). Každá tabulka
// má měnu a den dokladu jinde; mzdové listy měnu nemají, jsou v korunách.
const vKorunach = {
  faktura: sql => sql`CROSS JOIN LATERAL (SELECT
    castka_czk(f.total_amount, f.currency, COALESCE(f.taxable_date, f.issue_date)) AS czk,
    mena_kod(f.currency) AS mena) k`,
  uctenka: sql => sql`CROSS JOIN LATERAL (SELECT
    castka_czk(r.total_amount, r.currency, r.receipt_date) AS czk, mena_kod(r.currency) AS mena) k`,
  platba: sql => sql`CROSS JOIN LATERAL (SELECT
    castka_czk(p.amount, p.currency, p.paid_on) AS czk, mena_kod(p.currency) AS mena) k`,
};
const souhrn = sql => sql`COALESCE(SUM(k.czk),0)::float8 AS v, COUNT(*)::int AS n,
  COUNT(*) FILTER (WHERE k.mena <> 'CZK')::int AS cizi,
  COUNT(*) FILTER (WHERE k.czk IS NULL)::int AS bez_kurzu`;

const meny = (...souhrny) => ({
  cizi: souhrny.reduce((s, r) => s + (r.cizi || 0), 0),
  bezKurzu: souhrny.reduce((s, r) => s + (r.bez_kurzu || 0), 0),
});

/**
 * Náklady za období rozpadlé podle zdroje.
 * Mzda se řadí do měsíce, ZA který je, ne podle data výplaty – mzda za
 * červen je nákladem června, i když se posílá v polovině července.
 */
export async function naklady(sql, from, to) {
  const [[faktury], [uctenky], [mzdy], [platby]] = await Promise.all([
    sql`SELECT ${souhrn(sql)}
          FROM accounting_invoices f ${vKorunach.faktura(sql)}
         WHERE f.type = 'received' AND f.issue_date BETWEEN ${from} AND ${to}`,
    sql`SELECT ${souhrn(sql)}
          FROM receipts r ${vKorunach.uctenka(sql)}
         WHERE r.receipt_date BETWEEN ${from} AND ${to}`,
    sql`SELECT COALESCE(SUM(company_cost),0)::float8 AS v, COUNT(*)::int AS n
          FROM hr_payroll_runs WHERE period BETWEEN ${from} AND ${to}`,
    sql`SELECT ${souhrn(sql)}
          FROM hr_payroll_items p ${vKorunach.platba(sql)}
         WHERE p.kind <> 'zaloha' AND p.paid_on BETWEEN ${from} AND ${to}`,
  ]);
  const zdroje = {
    faktury: faktury.v, uctenky: uctenky.v, mzdy: mzdy.v, platby: platby.v,
  };
  return {
    ...zdroje,
    celkem: zdroje.faktury + zdroje.uctenky + zdroje.mzdy + zdroje.platby,
    pocty: { faktury: faktury.n, uctenky: uctenky.n, mzdy: mzdy.n, platby: platby.n },
    meny: meny(faktury, uctenky, platby),
  };
}

/** Tržby za období. Zatím jediný zdroj, ale drží se u nákladů, ať je to na jednom místě. */
export async function trzby(sql, from, to) {
  const [issued] = await sql`
    SELECT ${souhrn(sql)}
      FROM accounting_invoices f ${vKorunach.faktura(sql)}
     WHERE f.type = 'issued' AND f.issue_date BETWEEN ${from} AND ${to}`;
  return { celkem: issued.v, pocet: issued.n, meny: meny(issued) };
}

/** Mzdové náklady po měsících roku – třetí řada do grafu tržeb a nákladů. */
export async function mzdyPoMesicich(sql, year) {
  const rows = await sql`
    SELECT EXTRACT(MONTH FROM period)::int AS m, COALESCE(SUM(company_cost),0)::float8 AS v
      FROM hr_payroll_runs
     WHERE period BETWEEN ${`${year}-01-01`} AND ${`${year}-12-31`}
     GROUP BY m ORDER BY m
  `;
  const pole = Array(12).fill(0);
  for (const r of rows) pole[r.m - 1] = r.v;
  return pole;
}

/** Popisek pod číslo nákladů, aby bylo poznat, z čeho se skládá. */
export function popisNakladu(n) {
  const casti = [];
  if (n.pocty.faktury) casti.push(`${n.pocty.faktury} faktur`);
  if (n.pocty.uctenky) casti.push(`${n.pocty.uctenky} účtenek`);
  if (n.pocty.mzdy)    casti.push(`${n.pocty.mzdy} mezd`);
  if (n.pocty.platby)  casti.push(`${n.pocty.platby} plateb`);
  return casti.length ? casti.join(' · ') : 'Přijaté faktury, účtenky a mzdy';
}

const tvar = (n, jeden, dva, pet) => (n === 1 ? jeden : n >= 2 && n <= 4 ? dva : pet);

/**
 * Druhý řádek pod částku, když v ní jsou doklady v cizí měně. Prázdný,
 * když je všechno v korunách. Chybějící kurz má přednost: součet je pak
 * nižší, než by měl být, a to musí být vidět.
 */
export function popisPrepoctu(m) {
  if (!m) return '';
  if (m.bezKurzu) {
    return `Bez kurzu ČNB, v součtu chybí: ${m.bezKurzu} ${tvar(m.bezKurzu, 'doklad', 'doklady', 'dokladů')}`;
  }
  if (m.cizi) return `Cizí měna v Kč kurzem ČNB: ${m.cizi} ${tvar(m.cizi, 'doklad', 'doklady', 'dokladů')}`;
  return '';
}
