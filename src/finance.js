// Náklady firmy — jediné místo, kde se sčítají.
//
// Dokud šlo jen o „součet přijatých faktur", vešel se vzorec do šablony
// (prehled.ejs) a na domovskou stránku zvlášť. Se třemi zdroji by se ty
// kopie dřív nebo později rozešly a nikdo by nepoznal proč.
//
// Co do nákladů patří a co ne:
//   přijaté faktury   ano
//   účtenky           ano — dosud se nepočítaly vůbec, takže zisk byl nadhodnocený
//   mzdy              ano, ale „náklady firmy" (hrubá + odvody zaměstnavatele),
//                     ne to, co odešlo z účtu
//   zálohy zaměstnanci NE — je to pohledávka za zaměstnancem (335), ne náklad
//
// A do cashflow se nepřidává nic: mzdy i zálohy z účtu už odešly a banka
// je vidí, takže by se započítaly dvakrát.

/**
 * Náklady za období rozpadlé podle zdroje.
 * Mzda se řadí do měsíce, ZA který je, ne podle data výplaty — mzda za
 * červen je nákladem června, i když se posílá v polovině července.
 */
export async function naklady(sql, from, to) {
  const [[faktury], [uctenky], [mzdy], [platby]] = await Promise.all([
    sql`SELECT COALESCE(SUM(total_amount),0)::float8 AS v, COUNT(*)::int AS n
          FROM accounting_invoices
         WHERE type = 'received' AND issue_date BETWEEN ${from} AND ${to}`,
    sql`SELECT COALESCE(SUM(total_amount),0)::float8 AS v, COUNT(*)::int AS n
          FROM receipts WHERE receipt_date BETWEEN ${from} AND ${to}`,
    sql`SELECT COALESCE(SUM(company_cost),0)::float8 AS v, COUNT(*)::int AS n
          FROM hr_payroll_runs WHERE period BETWEEN ${from} AND ${to}`,
    sql`SELECT COALESCE(SUM(amount),0)::float8 AS v, COUNT(*)::int AS n
          FROM hr_payroll_items
         WHERE kind <> 'zaloha' AND paid_on BETWEEN ${from} AND ${to}`,
  ]);
  const zdroje = {
    faktury: faktury.v, uctenky: uctenky.v, mzdy: mzdy.v, platby: platby.v,
  };
  return {
    ...zdroje,
    celkem: zdroje.faktury + zdroje.uctenky + zdroje.mzdy + zdroje.platby,
    pocty: { faktury: faktury.n, uctenky: uctenky.n, mzdy: mzdy.n, platby: platby.n },
  };
}

/** Tržby za období. Zatím jediný zdroj, ale drží se u nákladů, ať je to na jednom místě. */
export async function trzby(sql, from, to) {
  const [[issued]] = await Promise.all([
    sql`SELECT COALESCE(SUM(total_amount),0)::float8 AS v, COUNT(*)::int AS n
          FROM accounting_invoices
         WHERE type = 'issued' AND issue_date BETWEEN ${from} AND ${to}`,
  ]);
  return { celkem: issued.v, pocet: issued.n };
}

/** Mzdové náklady po měsících roku — třetí řada do grafu tržeb a nákladů. */
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
